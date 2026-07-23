/**
 * Per-scheduler stall accounting -- the money backstop for cron (constitution.md:203-216).
 *
 * BullMQ's `maxStalledCount` does not cover scheduler jobs: `moveStalledJobsToWait` derives
 * `isRepeatableJob` from the job's `rjk` field and skips the stall-fail for a live scheduler, so a
 * wedged scheduled run is re-processed -- paid -- on every stall, indefinitely. `maxStalledCount: 0`
 * bounds ordinary jobs; nothing in BullMQ bounds scheduler jobs. This guard counts stalls per
 * scheduler over a rolling window and tears the scheduler down once the count exceeds a threshold.
 *
 * Injected `redis` (ioredis-compatible), `removeJobScheduler`, and `log` keep the logic testable with
 * no queue, no bullmq import, and no real Valkey.
 *
 * Custom: per-scheduler stall accounting; BullMQ's maxStalledCount does not cover scheduler jobs -- constitution.md:203-216 carve-out ("BullMQ will never do this for us")
 */

// The Redis hash of per-scheduler stall counts (field = schedulerId, value = count). Exported so the admin
// panel can read it (HGETALL) for the cron drill-in without re-deriving the key string.
export const STALL_KEY = "pi-dispatch:sched-stalls";

// A rolling window: the EXPIRE is re-set on every stall, so a scheduler that stops stalling for a full
// day drops back to zero. This prevents unrelated transient stalls weeks apart from accumulating into a
// false teardown -- only sustained stalling inside one window trips the threshold.
const STALL_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Build the `stalled` listener. `threshold` is how many stalls a single scheduler may accrue before
 * teardown, compared STRICT `>` to mirror BullMQ's own `stalledCount > maxStalledJobCount`.
 * `removeJobScheduler(schedulerId)` tears a scheduler down; `log(event, fields)` records stable ids
 * only, never task or body content.
 *
 * The returned `onStalled` never rejects: BullMQ's `stalled` event is fire-and-forget (void-invoked),
 * so a rejection here would surface as an unhandled rejection with no handler to catch it.
 */
export function makeStallGuard({ redis, threshold, removeJobScheduler, log }) {
	return async function onStalled(jobId) {
		try {
			// Ordinary jobs are bounded by `maxStalledCount: 0`; only scheduler jobs reach this accounting.
			if (!jobId.startsWith("repeat:")) return;

			const schedulerId = jobId.slice("repeat:".length, jobId.lastIndexOf(":"));
			if (schedulerId === "") {
				// Degenerate `repeat:<n>` / `repeat::<n>` with no scheduler segment: an empty hash field would
				// pool every such id into one counter, so log and skip rather than hincrby an empty key.
				log("scheduler_stall_unparsed", { jobId });
				return;
			}

			const count = Number(await redis.hincrby(STALL_KEY, schedulerId, 1));
			await redis.expire(STALL_KEY, STALL_WINDOW_SECONDS);

			if (count > threshold) {
				try {
					await removeJobScheduler(schedulerId);
				} catch (error) {
					// A scheduler already gone (removed concurrently, or between the stall and now) is the goal
					// state, not an error -- swallow it so hdel and the teardown alert still run.
					log("scheduler_teardown_remove_failed", { schedulerId, error: error?.message });
				}
				await redis.hdel(STALL_KEY, schedulerId);
				// The loud log is the "alert" half of the constitution's "removeJobScheduler -- or alert".
				log("scheduler_torn_down", { schedulerId, stalls: count });
			}
		} catch (error) {
			log("scheduler_stall_guard_error", { jobId, error: error?.message });
		}
	};
}
