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
 * The retry-idempotent jobId for a chained (outbox-requested) child job: `parent id + content-hash of
 * (flow, task)`, with NO time component. BullMQ's dedup is `EXISTS jobId`, so a retried parent
 * re-collects its outbox and re-enqueues IDENTICAL child ids -- the duplicate follow-up is rejected,
 * so a retry cannot fan out extra paid jobs (INT-OUTBOX-CONTRACT, DES-JOB-OUTBOX-CHAINING).
 *
 * localJobId's minute component is deliberately ABSENT here: a retry crossing a minute boundary would
 * otherwise mint a fresh id and double-chain. `parentJobId` is folded INTO the hash so two different
 * parents requesting the same flow+task resolve to distinct ids and cannot collide; the `chain-`
 * prefix carries no parent info of its own because the hash already binds it.
 *
 * Kept free of any bullmq import (mirrors localJobId/deliveryJobId) so the dedup key is derivable
 * everywhere, not only where the queue's dependencies are installed.
 */
export function chainedJobId({ parentJobId, flow, task }) {
	// NUL-delimited (localJobId's idiom) so distinct field splits cannot collide.
	const digest = createHash("sha256").update([String(parentJobId), flow ?? "", task ?? ""].join("\0")).digest("hex");
	return `chain-${digest.slice(0, 16)}`;
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
