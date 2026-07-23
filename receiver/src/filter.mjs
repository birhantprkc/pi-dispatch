/**
 * The trigger gate: decide whether a verified webhook becomes a paid agent job, and if so with what
 * shape. This is CONST-TRIGGER-AUTHOR-GATE made executable -- the independent controls it names (label
 * allowlist, comment author_association, pull_request author gate, bot-loop guard) plus the
 * INT-WEBHOOK-PAYLOAD-SUBSET extraction that keeps the job carrying only the named fields.
 *
 * Pure and total: imports nothing, touches no I/O, and NEVER throws. A rejected event returns
 * `{ enqueue: false, reason }`; an accepted one returns `{ enqueue: true, job }`. Purity is the point --
 * the whole gate is decidable offline from its inputs, so the security-critical decision is unit testable
 * without a server, a socket, or a queue.
 *
 * The evaluation ORDER is fail-closed and load-bearing:
 *   0. A non-numeric `sender.id` is rejected FIRST. It must precede the `=== selfId` compare, because
 *      `undefined === selfId` is `false` and would fall through to enqueue -- failing OPEN on a
 *      malformed payload. Missing identity is a reject, never a pass.
 *   1. The bot-loop guard (`sender.id === selfId`) runs UNCONDITIONALLY, before any author/label check.
 *      Under a PAT the harness is repo OWNER and would clear the author gate, so a completion comment the
 *      harness posts -- or the flow's own push to a PR head, which fires `pull_request.synchronize` -- is
 *      an event that passes the gate: an unbounded paid recursion. Gating this drop behind the author
 *      check would reintroduce exactly that loop.
 *   2. Only then route on event + action: issue label, author-gated comment, or pull_request.
 *
 * PR AUTHOR GATE (security-critical): auto actions (`opened|synchronize|reopened`) fire ONLY when the PR
 * `author_association` is a collaborator. This is hard-coded here, never config-optional -- a fork PR from
 * a stranger would otherwise launch an unbounded paid run (CONST-TRIGGER-AUTHOR-GATE, job-budget rules).
 * PR labeling is self-gating: only collaborators can apply labels, so the label predicate IS the approval,
 * exactly as on the issue label path.
 *
 * `selfId` is the numeric id of whichever identity posts as the harness (the App's bot user, or the PAT
 * user); `deliveryId` is the `X-GitHub-Delivery` GUID, carried into the job for downstream dedup.
 */

const AUTHOR_ALLOWLIST = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const LABEL_ACTIONS = new Set(["opened", "labeled", "reopened"]);
const PR_ACTIONS = new Set(["labeled", "opened", "synchronize", "reopened"]);
const PR_AUTO_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export function filter(eventName, subset, cfg, selfId, deliveryId) {
	// (0) Fail-closed on identity. MUST precede the self compare -- see header, ordering constraint.
	if (typeof subset?.sender?.id !== "number") {
		return { enqueue: false, reason: "missing-sender-id" };
	}

	// (1) Bot-loop guard: unconditional, independent of the author/label outcome below.
	if (subset.sender.id === selfId) {
		return { enqueue: false, reason: "self" };
	}

	// (2) Route on event + action -> resolve { flow, target } or a drop reason.
	const action = subset.action;
	const triggers = cfg?.triggers ?? {};
	let resolved;

	if (eventName === "issues" && LABEL_ACTIONS.has(action)) {
		resolved = routeIssueLabel(subset, triggers);
	} else if (eventName === "issue_comment" && action === "created") {
		resolved = routeComment(subset, triggers);
	} else if (eventName === "pull_request" && PR_ACTIONS.has(action)) {
		resolved = routePullRequest(subset, triggers, action);
	} else {
		return { enqueue: false, reason: "unhandled-event" };
	}

	if (!resolved.enqueue) return resolved; // carries the drop reason

	// (3) Build the job from the INT-WEBHOOK-PAYLOAD-SUBSET fields only. No sender.login (not in the
	// subset), no provider/model/maxTurns (the worker fills defaults), no field outside the subset.
	const job = {
		repo: subset.repository?.full_name,
		target: resolved.target,
		flow: resolved.flow,
		trigger: { event: eventName, action, deliveryId, sender: { id: subset.sender.id } },
	};
	return { enqueue: true, job };
}

/** Issue label path: the label allowlist IS the human approval gate -- only collaborators can label. */
function routeIssueLabel(subset, triggers) {
	const L = labelSet(subset.issue?.labels);
	const flow = firstMatchingFlow(triggers.label, L);
	if (flow === undefined) {
		return { enqueue: false, reason: "no-allowlisted-label" };
	}
	return {
		enqueue: true,
		flow,
		target: { type: "issue", number: subset.issue?.number, title: subset.issue?.title, body: subset.issue?.body },
	};
}

/** Comment path: author_association is the approval gate (no label event to carry it). */
function routeComment(subset, triggers) {
	if (!AUTHOR_ALLOWLIST.has(subset.comment?.author_association)) {
		return { enqueue: false, reason: "author-not-allowed" };
	}
	const phrase = triggers.comment?.phrase;
	const body = subset.comment?.body;
	if (typeof phrase !== "string" || typeof body !== "string" || !body.includes(phrase)) {
		return { enqueue: false, reason: "no-trigger-phrase" };
	}
	// Default to the configured flow; an explicit `<phrase> <flow>` overrides only when `<flow>` is a
	// known flow name, so a comment cannot summon an unlisted flow.
	let flow = triggers.comment?.defaultFlow;
	const match = body.match(new RegExp(escapeRegExp(phrase) + "\\s+(\\S+)"));
	if (match && triggers.knownFlows?.has(match[1])) {
		flow = match[1];
	}
	if (flow === null || flow === undefined || flow === "") {
		return { enqueue: false, reason: "no-flow" };
	}
	// An issue_comment on a PR carries issue.pull_request; its issue.number IS the PR number and the
	// issue title/body are the PR's. Route it as a pull_request target so the flow gets PR context and
	// does not mint a fresh pi/issue-<n> branch. head/base are absent here (not in the comment payload);
	// the flow resolves them from the number via `gh`.
	const isPR = subset.issue?.pull_request === true;
	return {
		enqueue: true,
		flow,
		target: { type: isPR ? "pull_request" : "issue", number: subset.issue?.number, title: subset.issue?.title, body: subset.issue?.body },
	};
}

/**
 * Pull-request path. `labeled` is gated by the label predicate (collaborator-applied label = approval);
 * auto actions (`opened|synchronize|reopened`) are gated by the PR author_association (hard-coded, never
 * config-optional). A trigger's optional predicate only narrows an auto action; an empty predicate is
 * vacuously true. First matching rule (in file order) wins.
 */
function routePullRequest(subset, triggers, action) {
	const pr = subset.pull_request;
	if (pr === null || typeof pr !== "object") {
		return { enqueue: false, reason: "missing-pull-request" };
	}
	const L = labelSet(pr.labels);
	const authorOk = AUTHOR_ALLOWLIST.has(pr.author_association);

	for (const rule of triggers.pullRequest ?? []) {
		if (!rule.actions.has(action)) continue;
		if (action === "labeled") {
			if (!matchesRule(L, rule.predicate)) continue;
		} else {
			// Auto action -- author_association is the hard gate; the predicate (if any) narrows scope.
			if (!authorOk) continue;
			if (!matchesRule(L, rule.predicate)) continue;
		}
		return { enqueue: true, flow: rule.flow, target: buildPrTarget(pr) };
	}

	// Surface the security-relevant author drop distinctly from a plain no-match so it is observable.
	if (PR_AUTO_ACTIONS.has(action) && !authorOk) {
		return { enqueue: false, reason: "pr-author-not-allowed" };
	}
	return { enqueue: false, reason: "no-matching-pr-trigger" };
}

/** Build the pull_request target. head/base are carried as DATA only -- never a clone ref (see header). */
function buildPrTarget(pr) {
	const target = { type: "pull_request", number: pr.number, title: pr.title, body: pr.body };
	if (pr.head) target.head = { ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo?.full_name };
	if (pr.base) target.base = { ref: pr.base.ref };
	return target;
}

/** The set of label names present on an issue/PR; non-string names are dropped. */
function labelSet(labels) {
	const arr = Array.isArray(labels) ? labels : [];
	return new Set(arr.map((l) => l?.name).filter((n) => typeof n === "string"));
}

/** First rule (in file order) whose predicate matches `L`, or undefined. */
function firstMatchingFlow(rules, L) {
	for (const rule of rules ?? []) {
		if (matchesRule(L, rule.predicate)) return rule.flow;
	}
	return undefined;
}

/**
 * Per-rule label predicate over the label set `L`:
 *   (any empty OR L∩any ≠ ∅) AND (all ⊆ L) AND (L∩none = ∅).
 * An empty `any` is vacuously true, so the `all`/`none` clauses carry the requirement; the loader
 * guarantees at least one positive selector where the predicate is the approval gate (label triggers and
 * `labeled` PR triggers), so a validated approval rule can never match every event. Reads only its
 * arguments and never throws -- the gate's purity extends here, and the defensive `?? []` covers a rule
 * the loader has already validated.
 */
function matchesRule(L, rule) {
	const any = rule?.any ?? [];
	const all = rule?.all ?? [];
	const none = rule?.none ?? [];
	if (any.length > 0 && !any.some((x) => L.has(x))) return false;
	if (!all.every((x) => L.has(x))) return false;
	if (none.some((x) => L.has(x))) return false;
	return true;
}

/** Escape a literal string for safe embedding in a RegExp -- the trigger phrase is config, not a pattern. */
function escapeRegExp(literal) {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
