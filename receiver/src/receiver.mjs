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
 * DES-PANEL-SEPARATE-FROM-RECEIVER: the receiver exposes only the webhook handler. There is no admin,
 * dashboard, or BullBoard route here -- the panel is a separate service on a separate bind.
 */

import { makeVerifiedHandler } from "./verify.mjs";
import { filter } from "./filter.mjs";
import { enqueueGitHubJob } from "@pi-dispatch/worker/queue";

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
	return {
		action: payload.action,
		sender: { id: payload.sender?.id },
		issue: {
			number: payload.issue?.number,
			title: payload.issue?.title,
			body: payload.issue?.body,
			labels: Array.isArray(payload.issue?.labels) ? payload.issue.labels.map((l) => ({ name: l?.name })) : [],
		},
		comment: { body: payload.comment?.body, author_association: payload.comment?.author_association },
		repository: { full_name: payload.repository?.full_name },
	};
}

/**
 * Build the receiver's `node:http` handler. Returns `makeVerifiedHandler`'s handler directly, so the
 * receiver only ever sees an already-verified request. `onVerified` owns parse, filter, enqueue, and
 * response; a good signature is the sole precondition D2 guarantees before it runs.
 */
export function makeReceiver({ queue, selfId, cfg, log }) {
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

		log?.({ event: "enqueued", delivery, repo: result.job.repo, issue: result.job.issueNumber, flow: result.job.flow });
		return respond(res, 202, { status: "queued" });
	});
}
