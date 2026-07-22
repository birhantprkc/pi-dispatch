/**
 * Load and validate the host-side schedule list (DES-CRON-VIA-BULLMQ-SCHEDULER). A schedule is a
 * trigger, not a job kind: each entry names a local folder + flow + task and a cron pattern, and
 * normalizes to the shape the caller hands to BullMQ's `upsertJobScheduler`
 * (`schedulerId`, `name`, `pattern`, and the `data`/`opts` job template).
 *
 * Fail-loud, like config.mjs: a misconfigured schedule file makes the worker refuse to start with a
 * clear message rather than upserting a broken scheduler that silently never fires. Every load-time
 * rejection is a `configError` so the CLI/entry prints it cleanly and exits non-zero.
 *
 * Kept free of any bullmq import (mirrors job-id.mjs) so validation is testable everywhere, not only
 * where the queue's dependencies are installed.
 *
 * Custom: schedules validated inline per config.mjs precedent; zod not in deps
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { configError } from "./config.mjs";

// A schedulerId flows into BullMQ's deterministic `repeat:<id>:<nextMillis>` jobId, so a `:` in the
// id would corrupt that parsing. The charset also excludes `:`; the dedicated check names the reason.
const ID_CHARSET = /^[A-Za-z0-9._-]+$/;

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * Parse, validate, and normalize the schedule file named by `config.schedulesFile`. Returns `[]` when
 * cron is disabled (`schedulesFile` null/absent). `readFileSync`/`existsSync` are injectable so tests
 * exercise the full validation path with no real filesystem.
 */
export function loadSchedules(config, { readFileSync = fsReadFileSync, existsSync = fsExistsSync } = {}) {
	const path = config.schedulesFile;
	if (path === null || path === undefined) return []; // cron disabled

	if (!existsSync(path)) {
		throw configError(`schedules file does not exist: ${path}`);
	}

	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw configError(`schedules file is not valid JSON: ${path} (${error.message})`);
	}

	const entries = parsed?.schedules;
	if (!Array.isArray(entries)) {
		throw configError(`schedules file must have a "schedules" array: ${path}`);
	}

	const seenIds = new Set();
	return entries.map((entry, index) => normalizeSchedule(entry, index, seenIds, existsSync));
}

function normalizeSchedule(entry, index, seenIds, existsSync) {
	const at = `schedule at index ${index}`;

	if (entry === null || typeof entry !== "object") {
		throw configError(`${at}: must be an object`);
	}

	const { id, kind, cron, folder, flow, task } = entry;

	if (!isNonEmptyString(id)) {
		throw configError(`${at}: id must be a non-empty string`);
	}
	if (id.includes(":")) {
		throw configError(`schedule "${id}": id must not contain ":" -- it corrupts the repeat:<id>:<millis> jobId parsing in the stall guard`);
	}
	if (!ID_CHARSET.test(id)) {
		throw configError(`schedule "${id}": id must match [A-Za-z0-9._-]+`);
	}
	if (seenIds.has(id)) {
		throw configError(`schedule "${id}": duplicate id (ids must be unique)`);
	}
	seenIds.add(id);

	if (kind !== "local") {
		throw configError(`schedule "${id}": scheduled github jobs are not supported: a schedule has no webhook delivery, issue number, title, or body; use a local schedule (kind must be "local", got ${JSON.stringify(kind)})`);
	}

	if (!isNonEmptyString(cron)) {
		throw configError(`schedule "${id}": cron must be a non-empty string`);
	}
	const fieldCount = cron.trim().split(/\s+/).length;
	if (fieldCount !== 5 && fieldCount !== 6) {
		throw configError(`schedule "${id}": cron must have 5 or 6 space-separated fields, got ${fieldCount}`);
	}

	if (!isNonEmptyString(folder)) {
		throw configError(`schedule "${id}": folder must be a non-empty string`);
	}
	if (!existsSync(folder)) {
		throw configError(`schedule "${id}": folder does not exist: ${folder}`);
	}

	if (!isNonEmptyString(flow)) {
		throw configError(`schedule "${id}": flow must be a non-empty string`);
	}
	if (!isNonEmptyString(task)) {
		throw configError(`schedule "${id}": task must be a non-empty string`);
	}

	// Absent entry fields stay absent (undefined) so the value resolves at job start against the
	// settings overlay/env, not a default frozen here (INT-CONFIG-OVERLAY-CONTRACT).
	// data key order matches queue.mjs:21 -- the shape the processor's runJob consumes.
	const data = { kind: "local", folder, flow, task, provider: entry.provider, model: entry.model, maxTurns: entry.maxTurns };
	// Retention only; the deterministic repeat:<id>:<millis> jobId supplies dedup, so no jobId here,
	// and scheduler jobs are not retried (DES-CRON-VIA-BULLMQ-SCHEDULER) so no attempts/backoff.
	const opts = { removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } };

	return { schedulerId: id, name: "local", pattern: cron, data, opts };
}
