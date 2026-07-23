/**
 * Select the worker's cron schedules from the unified triggers file (DES-CRON-VIA-BULLMQ-SCHEDULER,
 * issue #20). The worker owns exactly the `on.type:"cron"` entries; the receiver owns the webhook types.
 * The shared validator (`triggers.mjs`) parses and validates the WHOLE file fail-loud -- the diagonal,
 * the `id` charset, cron field count -- so this module only selects the cron subset, checks that each
 * `run.folder` exists on disk (the one fs-dependent check the pure validator cannot make), and normalizes
 * to the shape the caller hands to BullMQ's `upsertJobScheduler` (`schedulerId`, `name`, `pattern`, and
 * the `data`/`opts` job template).
 *
 * Fail-loud, like config.mjs: a misconfigured triggers file makes the worker refuse to start with a clear
 * message rather than upserting a broken scheduler that silently never fires. Every load-time rejection is
 * a `configError` so the CLI/entry prints it cleanly and exits non-zero.
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { configError } from "./config.mjs";
import { parseTriggers } from "./triggers.mjs";

/**
 * Parse, validate, and select the cron schedules from the triggers file named by `config.triggersFile`.
 * Returns `[]` when cron is disabled (`triggersFile` null/absent) -- a worker with no cron triggers is a
 * valid deployment. `readFileSync`/`existsSync` are injectable so tests exercise the full path with no
 * real filesystem.
 */
export function loadSchedules(config, { readFileSync = fsReadFileSync, existsSync = fsExistsSync } = {}) {
	const path = config.triggersFile;
	if (path === null || path === undefined) return []; // cron disabled

	if (!existsSync(path)) {
		throw configError(`triggers file does not exist: ${path}`);
	}

	const triggers = parseTriggers(readFileSync(path, "utf8"), path);

	return triggers.filter((t) => t.on.type === "cron").map((t) => normalizeCronSchedule(t, path, existsSync));
}

function normalizeCronSchedule({ on, run }, path, existsSync) {
	// The pure validator already guaranteed a non-empty, `:`-free, charset-valid, unique id and a
	// well-formed pattern; folder existence is the one fs-dependent check it deferred to here.
	if (!existsSync(run.folder)) {
		throw configError(`cron trigger "${on.id}": run.folder does not exist: ${run.folder} (${path})`);
	}

	// Absent provider/model/maxTurns stay absent (undefined) so the value resolves at job start against the
	// settings overlay/env, not a default frozen here (INT-CONFIG-OVERLAY-CONTRACT). data key order matches
	// queue.mjs -- the shape the processor's runJob consumes.
	const data = { kind: "local", folder: run.folder, flow: run.flow, task: run.task, provider: run.provider, model: run.model, maxTurns: run.maxTurns };
	// Retention only; the deterministic repeat:<id>:<millis> jobId supplies dedup, so no jobId here, and
	// scheduler jobs are not retried (DES-CRON-VIA-BULLMQ-SCHEDULER) so no attempts/backoff.
	const opts = { removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } };

	return { schedulerId: on.id, name: "local", pattern: on.pattern, data, opts };
}
