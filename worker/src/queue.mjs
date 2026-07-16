import { Queue } from "bullmq";
import { localJobId } from "./job-id.mjs";

export const QUEUE = "pi-jobs";
export { localJobId };

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
export async function enqueueLocalJob(queue, { folder, flow, task, provider, model, maxTurns, now = new Date() }) {
	const minute = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM -- the dedup window
	const jobId = localJobId({ folder, flow, task, minute });
	const data = { kind: "local", folder, flow, task, provider, model, maxTurns };
	await queue.add("local", data, {
		jobId,
		attempts: 2,
		backoff: { type: "exponential", delay: 60_000 },
		removeOnComplete: { age: 24 * 3600 },
		removeOnFail: { age: 7 * 24 * 3600 },
	});
	return jobId;
}
