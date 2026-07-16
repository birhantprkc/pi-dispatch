import { createHash } from "node:crypto";

/**
 * A deterministic jobId for a local job. BullMQ's dedup is `EXISTS jobId`, so a double-invoke of
 * the same task within the same minute produces the same id and the duplicate is ignored -- the
 * local equivalent of REQ-DEDUP-BY-DELIVERY-GUID, guarding against a hasty second Enter
 * double-spending, without blocking a deliberate re-run a minute later.
 *
 * Kept free of any bullmq import so the dedup logic is testable everywhere, not only where the
 * queue's dependencies are installed.
 */
export function localJobId({ folder, flow, task, minute }) {
	// NUL-delimited so {folder:'a',task:'bc'} and {folder:'ab',task:'c'} cannot collide.
	const digest = createHash("sha256").update([folder, flow ?? "", task ?? "", minute].join("\0")).digest("hex");
	return `local-${digest.slice(0, 16)}`;
}
