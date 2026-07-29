/**
 * The webhook receiver: a thin producer that turns a verified GitHub webhook into (at most) one queued
 * job. It composes the three pieces that own the hard parts -- `makeVerifiedHandler` (the HMAC trust
 * boundary), `filter` (the trigger/author gate), and the SHARED `enqueueGitHubJob` -- and adds only the
 * glue: parse the verified body, project the payload subset, route on the filter's verdict, and map the
 * outcome to a status code.
 *
 * DES-TRIGGER-OUTSIDE-PI: the trigger lives outside pi. This module imports the shared `enqueueGitHubJob`
 * and never re-implements `queue.add` -- the queue's jobId/dedup/retention policy has exactly one owner,
 * so there is no drift between what the receiver enqueues and what every other producer does.
 *
 * no-pii-in-logs: logs carry stable non-PII identifiers only -- the delivery GUID, repo full_name, issue
 * number, flow, and a drop/failure reason. Never an issue title/body, a comment body, or a login.
 *
 * DES-ADMIN-VIA-PI-EXTENSION: the receiver exposes only the webhook handler. There is no admin,
 * dashboard, or admin-extension route here -- the admin surface is a pi extension in the operator's
 * session and binds no port.
 */

import { makeVerifiedHandler } from "./verify.mjs";
import { filter } from "./filter.mjs";
import { enqueueGitHubJob, enqueueGitLabJob } from "@pi-dispatch/worker/queue";
import { filterGitLab } from "./filter-gitlab.mjs";
import { parseGitLabSubset } from "./gitlab-subset.mjs";
import { makeGitLabVerifiedHandler } from "./verify-gitlab.mjs";

/** Write a small JSON body with an explicit status; a 204 carries no body. verify's `respond` is private. */
function respond(res, status, obj) {
	if (status === 204) {
		res.writeHead(204);
		res.end();
		return;
	}
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(obj ?? {}));
}

/**
 * Project ONLY the INT-WEBHOOK-PAYLOAD-SUBSET fields out of a parsed webhook payload. Nothing outside
 * this set flows onward to the filter or the job: the subset is the whole surface the trigger decision
 * and the enqueued job are allowed to see.
 */
export function parseSubset(payload) {
	const pr = payload.pull_request;
	return {
		action: payload.action,
		sender: { id: payload.sender?.id },
		issue: {
			number: payload.issue?.number,
			title: payload.issue?.title,
			body: payload.issue?.body,
			labels: Array.isArray(payload.issue?.labels) ? payload.issue.labels.map((l) => ({ name: l?.name })) : [],
			// Presence marker only: an issue_comment on a PR carries issue.pull_request, so the comment path
			// routes it as a pull_request target. A boolean keeps a URL/login out of the subset.
			pull_request: payload.issue?.pull_request != null,
		},
		comment: { body: payload.comment?.body, author_association: payload.comment?.author_association },
		// pull_request event fields (labeled/opened/synchronize/reopened). head/base are attacker-controlled
		// fork DATA -- projected for the flow's event.json, NEVER used as a clone ref (the worker clones the
		// base default-branch SHA). Absent for non-PR events.
		pull_request: pr
			? {
					number: pr.number,
					title: pr.title,
					body: pr.body,
					author_association: pr.author_association,
					labels: Array.isArray(pr.labels) ? pr.labels.map((l) => ({ name: l?.name })) : [],
					head: { ref: pr.head?.ref, sha: pr.head?.sha, repo: { full_name: pr.head?.repo?.full_name } },
					base: { ref: pr.base?.ref },
				}
			: undefined,
		repository: { full_name: payload.repository?.full_name },
	};
}

/**
 * Build the receiver's `node:http` handler.
 *
 * ROUTING BY PATH, not by header (issue #42). Each forge gets its own path, and with it its own secret and
 * its own trust regime, decided before a byte of the body is read. Discriminating on headers instead would
 * hand that choice to the sender: Forgejo emits `X-GitHub-*` on every delivery, so header-sniffing cannot
 * even tell two forges apart reliably, and a request that could select which gate it faced would always
 * select the weakest one available.
 *
 * `/` stays mapped to GitHub. Existing deployments configured their webhook URL before any path existed,
 * and silently 404-ing them would look exactly like the harness being down.
 *
 * A forge with no configuration gets no route at all -- not a route that answers 401. An endpoint that
 * responds to an unconfigured forge is an endpoint an operator can believe is armed.
 */
export function makeReceiver({ queue, selfId, cfg, log, gitlab = null }) {
	const github = makeGitHubHandler({ queue, selfId, cfg, log });
	const gitlabHandler = gitlab ? makeGitLabHandler({ queue, cfg, log, ...gitlab }) : null;

	return async function receiverHandler(req, res) {
		const path = pathOf(req.url);
		if (path === "/gitlab") {
			if (!gitlabHandler) return respond(res, 404, { error: "gitlab webhooks are not configured" });
			return await gitlabHandler(req, res);
		}
		return await github(req, res);
	};
}

/** The path portion of a request URL, without query or trailing slash. Never throws on a malformed URL. */
function pathOf(url) {
	const raw = String(url ?? "/").split("?")[0];
	return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * The GitHub arm. Returns `makeVerifiedHandler`'s handler directly, so it only ever sees an already-verified
 * request. `onVerified` owns parse, filter, enqueue, and response; a good signature is the sole
 * precondition D2 guarantees before it runs.
 */
function makeGitHubHandler({ queue, selfId, cfg, log }) {
	return makeVerifiedHandler({ secret: cfg.webhookSecret }, async ({ rawBody, event, delivery }, res) => {
		let subset;
		try {
			subset = parseSubset(JSON.parse(rawBody));
		} catch {
			return respond(res, 400, { error: "invalid-json" });
		}

		const result = filter(event, subset, cfg, selfId, delivery);
		if (!result.enqueue) {
			log?.({ event: "dropped", delivery, reason: result.reason });
			return respond(res, 204);
		}

		try {
			await enqueueGitHubJob(queue, result.job);
		} catch (err) {
			// Own try/catch so a Valkey-down enqueue is a 503 (retryable), not verify's outer 500.
			log?.({ event: "enqueue_failed", delivery, reason: err?.message });
			return respond(res, 503, { error: "enqueue-failed" }); // GitHub redelivers; dedup by GUID coalesces
		}

		log?.({ event: "enqueued", delivery, repo: result.job.repo, target: `${result.job.target.type}#${result.job.target.number}`, flow: result.job.flow });
		return respond(res, 202, { status: "queued" });
	});
}

/**
 * The GitLab arm. Same shape as the GitHub one -- verify, project, gate, enqueue, respond -- with one step
 * the GitHub path does not need: the actor's project access level is RESOLVED here, between verification
 * and the gate, because GitLab puts no `author_association` in the payload (gitlab-members.mjs).
 *
 * That resolution is a network call, and its three outcomes are deliberately not two:
 *   - a level (including 0 for a determinate non-member) is handed to the gate, which decides;
 *   - an INDETERMINATE lookup is a 503, so GitLab redelivers and the stable `webhook-id` dedups the
 *     retry. Answering 204 would drop real work during an outage, and it would look on the wire exactly
 *     like a stranger being correctly refused.
 * The lookup runs only for events that could still fire -- after verification, and after the payload has
 * been projected -- so an unauthenticated flood cannot make this project call GitLab at all.
 */
function makeGitLabHandler({ queue, cfg, log, mode, secret, selfId, resolveAccessLevel, now }) {
	return makeGitLabVerifiedHandler({ mode, secret, ...(now ? { now } : {}) }, async ({ rawBody, delivery }, res) => {
		let subset;
		try {
			subset = parseGitLabSubset(JSON.parse(rawBody));
		} catch {
			return respond(res, 400, { error: "invalid-json" });
		}

		const resolved = await resolveAccessLevel(subset.project?.id, subset.user?.id);
		if (resolved.indeterminate) {
			// The reason names the lookup, never the actor -- `user.username` is personal data and exists
			// only to have been asked about (no-pii-in-logs).
			log?.({ event: "gitlab_access_lookup_failed", delivery, reason: resolved.indeterminate });
			return respond(res, 503, { error: "access-lookup-failed" });
		}

		const result = filterGitLab(subset, cfg.triggers?.gitlab, cfg.triggers?.knownFlows, selfId, resolved.level, delivery);
		if (!result.enqueue) {
			log?.({ event: "dropped", delivery, reason: result.reason });
			return respond(res, 204);
		}

		try {
			await enqueueGitLabJob(queue, result.job);
		} catch (err) {
			log?.({ event: "enqueue_failed", delivery, reason: err?.message });
			return respond(res, 503, { error: "enqueue-failed" }); // GitLab redelivers; dedup by webhook-id coalesces
		}

		// `!` for a merge request, `#` for an issue -- GitLab's own notation, and the same discrimination
		// the semantic dedup key makes, because the two are separate number sequences.
		const sep = result.job.target.type === "pull_request" ? "!" : "#";
		log?.({ event: "enqueued", delivery, repo: result.job.repo, target: `${result.job.repo}${sep}${result.job.target.number}`, flow: result.job.flow });
		return respond(res, 202, { status: "queued" });
	});
}
