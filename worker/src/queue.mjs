import { Queue } from "bullmq";
import { chainedJobId, localJobId, deliveryJobId } from "./job-id.mjs";

export const QUEUE = "pi-jobs";
export { chainedJobId, localJobId, deliveryJobId };

export function makeQueue(connection) {
	return new Queue(QUEUE, { connection });
}

/**
 * Enqueue a local-folder job. Returns the jobId. The data shape is what the processor's runJob
 * consumes (kind/folder/flow/task/provider/model/maxTurns).
 *
 * removeOnComplete keeps the dedup window ~= the retention. Unlike webhooks, local jobs are not
 * redelivered, so a modest window is enough.
 */
export async function enqueueLocalJob(queue, { folder, flow, task, provider, model, maxTurns, chainDepth, parentJobId, jobId, now = new Date() }) {
	const minute = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM -- the dedup window
	// A caller-supplied jobId (the outbox collector's retry-idempotent chainedJobId) wins; otherwise the
	// minute-windowed localJobId is the dedup key.
	const id = jobId ?? localJobId({ folder, flow, task, minute });
	// chainDepth/parentJobId land on `data` only when present, so a non-chained job's data is byte-identical.
	const data = {
		kind: "local",
		folder,
		flow,
		task,
		provider,
		model,
		maxTurns,
		...(chainDepth !== undefined && { chainDepth }),
		...(parentJobId !== undefined && { parentJobId }),
	};
	await queue.add("local", data, {
		jobId: id,
		attempts: 2,
		backoff: { type: "exponential", delay: 60_000 },
		removeOnComplete: { age: 24 * 3600 },
		removeOnFail: { age: 7 * 24 * 3600 },
	});
	return id;
}

// Coalesces rapid re-label spam; the GUID jobId + 31d retention handle exact redelivery, so this
// window only needs to absorb burst re-labels, not the full redelivery window.
const SEMANTIC_WINDOW_MS = 10 * 60 * 1000;

/**
 * Enqueue a GitHub-triggered job. Returns the jobId. The data shape is what prepare/runJob consumes
 * for the github kind. No `sha` field: the commit is resolved fresh in prepare (C1), so baking a
 * possibly-stale sha here would only race the branch head.
 *
 * Two dedup layers, ADDITIVE and independent:
 *   - `jobId` (the delivery GUID) is exact-per-delivery: a redelivered webhook resolves to the same
 *     id and BullMQ's `EXISTS jobId` rejects it -- REQ-DEDUP-BY-DELIVERY-GUID.
 *   - `deduplication` keys on `repo#issue:flow` for SEMANTIC_WINDOW_MS: distinct GUIDs from rapid
 *     re-labels of the same issue coalesce to one active job. It coexists with jobId; it does not
 *     replace it.
 */
export async function enqueueGitHubJob(queue, { repo, issueNumber, flow, title, body, trigger, provider, model, maxTurns }) {
	const jobId = deliveryJobId(trigger.deliveryId);
	const data = { kind: "github", repo, issueNumber, flow, title, body, trigger, provider, model, maxTurns };
	await queue.add("github", data, {
		jobId,
		deduplication: { id: `${repo}#${issueNumber}:${flow}`, ttl: SEMANTIC_WINDOW_MS }, // ttl in ms
		attempts: 2,
		backoff: { type: "exponential", delay: 60_000 },
		removeOnComplete: { age: 31 * 24 * 3600 }, // age in seconds -- do not cross units with the ms ttl above
		removeOnFail: { age: 31 * 24 * 3600 },
	});
	return jobId;
}
