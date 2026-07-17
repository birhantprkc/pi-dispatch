import { createHash } from "node:crypto";
import { configError } from "./config.mjs";

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

/**
 * The deterministic jobId for a GitHub-triggered job: the `X-GitHub-Delivery` GUID, prefixed.
 * BullMQ's dedup is `EXISTS jobId`, so a redelivered webhook (GitHub retries on timeout) carries
 * the same GUID, resolves to the same id, and the duplicate paid run is rejected --
 * REQ-DEDUP-BY-DELIVERY-GUID.
 *
 * Kept free of any bullmq import (mirrors localJobId) so the dedup key is derivable everywhere, not
 * only where the queue's dependencies are installed. A missing GUID is a caller bug -- the receiver
 * rejects a missing deliveryId before enqueue (D2) -- so this throws rather than inventing a random
 * id, which would silently defeat dedup and let a redelivery double-spend.
 */
export function deliveryJobId(guid) {
	if (typeof guid !== "string" || guid === "") {
		throw configError("deliveryJobId requires a non-empty X-GitHub-Delivery GUID");
	}
	return `gh-${guid}`;
}
