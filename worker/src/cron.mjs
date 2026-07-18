/**
 * Reconcile the Redis-resident BullMQ job schedulers with the host-side schedule config
 * (DES-CRON-VIA-BULLMQ-SCHEDULER). Given the normalized schedules from schedules.mjs, upsert each one
 * and prune any resident scheduler the config no longer names. Idempotency is BullMQ's: upsert is keyed
 * by schedulerId, so re-running with unchanged config installs the same set and removes nothing.
 *
 * The queue is injected, so this module carries no bullmq import and runs anywhere -- the whole
 * reconcile is exercised in tier-1 tests against a fake queue, with no real Valkey.
 *
 * A `-10` (SchedulerJobIdCollision) or `-11` (SchedulerJobSlotsBusy) from upsertJobScheduler is a
 * sentinel, not a success: swallowing it makes a schedule edit a silent no-op that looks identical to a
 * clean install (design.md:231-232). Whether the SDK throws or returns the sentinel is unconfirmed until
 * it runs against live Valkey, so BOTH the thrown path and the negative-return path are loud failures.
 */

import { configError } from "./config.mjs";

function sentinelName(code) {
	if (code === -10) return "SchedulerJobIdCollision";
	if (code === -11) return "SchedulerJobSlotsBusy";
	return "unknown scheduler sentinel";
}

/**
 * Install `schedules` (the normalized `{ schedulerId, name, pattern, data, opts }` shape from
 * schedules.mjs) and prune orphans. `queue` supplies `upsertJobScheduler` / `getJobSchedulers` /
 * `removeJobScheduler`; `log(event, fields)` records stable scheduler ids only. Returns
 * `{ installed, removed }`.
 */
export async function reconcile(queue, schedules, { log = () => {} } = {}) {
	for (const { schedulerId, name, pattern, data, opts } of schedules) {
		let res;
		try {
			// No custom jobId: BullMQ mints the deterministic repeat:<schedulerId>:<nextMillis> id itself.
			res = await queue.upsertJobScheduler(schedulerId, { pattern }, { name, data, opts });
		} catch (error) {
			const loud = configError(`scheduler "${schedulerId}": upsertJobScheduler threw: ${error?.message ?? error}`);
			loud.cause = error;
			throw loud;
		}

		if (typeof res === "number" && res < 0) {
			throw configError(
				`scheduler "${schedulerId}": upsertJobScheduler returned ${res} (${sentinelName(res)}); a schedule edit would be a silent no-op`,
			);
		}
	}

	const resident = await queue.getJobSchedulers(0, -1, true);
	const configIds = new Set(schedules.map((s) => s.schedulerId));

	// Custom: trivial set-diff over getJobSchedulers; no package warranted
	const orphanIds = resident
		.map((d) => (typeof d === "string" ? d : (d.key ?? d.id ?? d.name)))
		.filter((rid) => !configIds.has(rid));

	for (const rid of orphanIds) {
		try {
			await queue.removeJobScheduler(rid);
		} catch {
			// A scheduler already gone (a concurrent reconcile pruned it) is the goal state, not an error.
		}
		log("scheduler_removed_orphan", { schedulerId: rid });
	}

	return { installed: schedules.length, removed: orphanIds.length };
}
