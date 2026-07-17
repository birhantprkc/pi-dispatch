/**
 * The trigger gate: decide whether a verified webhook becomes a paid agent job, and if so with what
 * shape. This is CONST-TRIGGER-AUTHOR-GATE made executable -- the three independent controls it names
 * (label allowlist, comment author_association, bot-loop guard) plus the INT-WEBHOOK-PAYLOAD-SUBSET
 * extraction that keeps the job carrying only the named fields.
 *
 * Pure and total: imports nothing, touches no I/O, and NEVER throws. A rejected event returns
 * `{ enqueue: false, reason }`; an accepted one returns `{ enqueue: true, job }`. Purity is the point --
 * the whole gate is decidable offline from its four inputs, so the security-critical decision is unit
 * testable without a server, a socket, or a queue.
 *
 * The evaluation ORDER is fail-closed and load-bearing:
 *   0. A non-numeric `sender.id` is rejected FIRST. It must precede the `=== selfId` compare, because
 *      `undefined === selfId` is `false` and would fall through to enqueue -- failing OPEN on a
 *      malformed payload. Missing identity is a reject, never a pass.
 *   1. The bot-loop guard (`sender.id === selfId`) runs UNCONDITIONALLY, before any author/label check.
 *      Under a PAT the harness is repo OWNER and would clear the author gate, so a completion comment
 *      the harness itself posts is an `issue_comment.created` event that passes the gate -- an unbounded
 *      paid recursion. Gating this drop behind the author check would reintroduce exactly that loop.
 *   2. Only then route on event + action: the label path (issues) or the author-gated comment path.
 *
 * `selfId` is the numeric id of whichever identity posts as the harness (the App's bot user, or the PAT
 * user); `deliveryId` is the `X-GitHub-Delivery` GUID, carried into the job for downstream dedup.
 */

const COMMENT_AUTHOR_ALLOWLIST = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const LABEL_ACTIONS = new Set(["opened", "labeled", "reopened"]);

export function filter(eventName, subset, cfg, selfId, deliveryId) {
	// (0) Fail-closed on identity. MUST precede the self compare -- see header, ordering constraint.
	if (typeof subset?.sender?.id !== "number") {
		return { enqueue: false, reason: "missing-sender-id" };
	}

	// (1) Bot-loop guard: unconditional, independent of the author/label outcome below.
	if (subset.sender.id === selfId) {
		return { enqueue: false, reason: "self" };
	}

	// (2) Route on event + action.
	const action = subset.action;
	let flow;

	if (eventName === "issues" && LABEL_ACTIONS.has(action)) {
		// Label path: the label allowlist IS the human approval gate -- only collaborators can label.
		const labels = Array.isArray(subset.issue?.labels) ? subset.issue.labels : [];
		const labelFlows = cfg?.labelFlows ?? {};
		for (const label of labels) {
			const name = label?.name;
			if (typeof name === "string" && Object.prototype.hasOwnProperty.call(labelFlows, name)) {
				flow = labelFlows[name];
				break;
			}
		}
		if (flow === undefined) {
			return { enqueue: false, reason: "no-allowlisted-label" };
		}
	} else if (eventName === "issue_comment" && action === "created") {
		// Comment path: author_association is the approval gate (no label event to carry it).
		if (!COMMENT_AUTHOR_ALLOWLIST.has(subset.comment?.author_association)) {
			return { enqueue: false, reason: "author-not-allowed" };
		}
		const phrase = cfg?.commentTrigger?.phrase;
		const body = subset.comment?.body;
		if (typeof phrase !== "string" || typeof body !== "string" || !body.includes(phrase)) {
			return { enqueue: false, reason: "no-trigger-phrase" };
		}
		// Default to the configured flow; an explicit `<phrase> <flow>` overrides only when `<flow>` is
		// a known flow value, so a comment cannot summon an unlisted flow.
		flow = cfg?.commentTrigger?.defaultFlow;
		const knownFlows = new Set(Object.values(cfg?.labelFlows ?? {}));
		const match = body.match(new RegExp(escapeRegExp(phrase) + "\\s+(\\S+)"));
		if (match && knownFlows.has(match[1])) {
			flow = match[1];
		}
		if (flow === null || flow === undefined || flow === "") {
			return { enqueue: false, reason: "no-flow" };
		}
	} else {
		return { enqueue: false, reason: "unhandled-event" };
	}

	// (3) Build the job from the INT-WEBHOOK-PAYLOAD-SUBSET fields only. No sender.login (not in the
	// subset), no provider/model/maxTurns (the worker fills defaults), no field outside the subset.
	const job = {
		repo: subset.repository?.full_name,
		issueNumber: subset.issue?.number,
		flow,
		title: subset.issue?.title,
		body: subset.issue?.body,
		trigger: { event: eventName, action, deliveryId, sender: { id: subset.sender.id } },
	};
	return { enqueue: true, job };
}

/** Escape a literal string for safe embedding in a RegExp -- the trigger phrase is config, not a pattern. */
function escapeRegExp(literal) {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
