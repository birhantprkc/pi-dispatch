/**
 * Shared trigger-file schema + validator (issue #20). One `triggers.json` of `{ on, run }` entries is
 * the single reviewed source of standing triggers for BOTH services: the worker owns `on.type:"cron"`
 * (local jobs), the receiver owns the webhook types (`label|comment|pull_request` -> github jobs). Each
 * service validates the WHOLE file, then selects the `on.type` it owns, so a malformed file fails both
 * identically and the two cannot drift.
 *
 * The on x run diagonal IS the trust boundary (DES-TRIGGERS-UNIFIED-FILE): a cron trigger carries no
 * webhook delivery GUID, issue/PR number, title, or body, so it can only produce a `local` run; a webhook
 * trigger is adversarial input and always produces a `github` run. Off-diagonal is rejected fail-loud at
 * load, exactly as the old schedules loader refused a `kind:"github"` schedule.
 *
 * Pure and fs-free (mirrors job-id.mjs): takes the file TEXT, returns a normalized array, throws
 * `configError` on any problem. Folder existence (fs-dependent) is layered on by the worker, not here.
 *
 * Custom: triggers validated inline per config.mjs/schedules.mjs precedent; zod not in deps
 */

import { configError } from "./config.mjs";

const ON_TYPES = new Set(["cron", "label", "comment", "pull_request"]);
const RUN_KINDS = new Set(["local", "github"]);
const PR_ACTIONS = new Set(["labeled", "opened", "synchronize", "reopened"]);

// A cron id flows into BullMQ's deterministic `repeat:<id>:<nextMillis>` jobId, so a `:` corrupts that
// parse; the charset also excludes `:` and the dedicated check names the reason.
const ID_CHARSET = /^[A-Za-z0-9._-]+$/;

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * Parse, validate, and normalize the unified triggers file text. Returns an array of normalized
 * `{ on, run }` entries (unknown fields dropped, so consumers only ever read validated fields). Throws
 * `configError` (fail-loud) on any malformed entry. The `path` is for error messages only.
 */
export function parseTriggers(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw configError(`triggers file is not valid JSON: ${path} (${error.message})`);
	}

	const entries = parsed?.triggers;
	if (!Array.isArray(entries)) {
		throw configError(`triggers file must have a "triggers" array: ${path}`);
	}

	const state = { seenCronIds: new Set(), commentCount: 0 };
	return entries.map((entry, index) => normalizeTrigger(entry, index, path, state));
}

function normalizeTrigger(entry, index, path, state) {
	const at = `trigger at index ${index}`;

	if (entry === null || typeof entry !== "object") {
		throw configError(`${at}: must be an object: ${path}`);
	}
	const { on, run } = entry;
	if (on === null || typeof on !== "object") {
		throw configError(`${at}: "on" must be an object: ${path}`);
	}
	if (run === null || typeof run !== "object") {
		throw configError(`${at}: "run" must be an object: ${path}`);
	}
	if (!ON_TYPES.has(on.type)) {
		throw configError(`${at}: on.type must be one of cron|label|comment|pull_request (got ${JSON.stringify(on.type)}): ${path}`);
	}
	if (!RUN_KINDS.has(run.kind)) {
		throw configError(`${at}: run.kind must be one of local|github (got ${JSON.stringify(run.kind)}): ${path}`);
	}

	// The on x run diagonal -- the trust boundary, fail-loud (mirrors the old schedules kind:github refusal).
	if (on.type === "cron") {
		if (run.kind !== "local") {
			throw configError(`${at}: a cron trigger has no webhook delivery, issue/PR number, title, or body; run.kind must be "local" (got ${JSON.stringify(run.kind)}): ${path}`);
		}
		return normalizeCron(on, run, index, path, state);
	}
	if (run.kind !== "github") {
		throw configError(`${at}: a ${on.type} trigger produces a github job; run.kind must be "github" (got ${JSON.stringify(run.kind)}): ${path}`);
	}
	if (on.type === "label") return normalizeLabel(on, run, index, path);
	if (on.type === "comment") return normalizeComment(on, run, index, path, state);
	return normalizePullRequest(on, run, index, path);
}

function normalizeCron(on, run, index, path, state) {
	const at = `trigger at index ${index}`;

	const id = on.id;
	if (!isNonEmptyString(id)) {
		throw configError(`${at}: cron on.id must be a non-empty string: ${path}`);
	}
	if (id.includes(":")) {
		throw configError(`cron trigger "${id}": on.id must not contain ":" -- it corrupts the repeat:<id>:<millis> jobId parsing in the stall guard: ${path}`);
	}
	if (!ID_CHARSET.test(id)) {
		throw configError(`cron trigger "${id}": on.id must match [A-Za-z0-9._-]+: ${path}`);
	}
	if (state.seenCronIds.has(id)) {
		throw configError(`cron trigger "${id}": duplicate on.id (cron ids must be unique): ${path}`);
	}
	state.seenCronIds.add(id);

	const pattern = on.pattern;
	if (!isNonEmptyString(pattern)) {
		throw configError(`cron trigger "${id}": on.pattern must be a non-empty string: ${path}`);
	}
	const fieldCount = pattern.trim().split(/\s+/).length;
	if (fieldCount !== 5 && fieldCount !== 6) {
		throw configError(`cron trigger "${id}": on.pattern must have 5 or 6 space-separated fields, got ${fieldCount}: ${path}`);
	}

	if (!isNonEmptyString(run.folder)) {
		throw configError(`cron trigger "${id}": run.folder must be a non-empty string: ${path}`);
	}
	if (!isNonEmptyString(run.flow)) {
		throw configError(`cron trigger "${id}": run.flow must be a non-empty string: ${path}`);
	}
	if (!isNonEmptyString(run.task)) {
		throw configError(`cron trigger "${id}": run.task must be a non-empty string: ${path}`);
	}

	// provider/model/maxTurns stay absent when omitted so the value resolves at job start against the
	// settings overlay/env, not a default frozen here (INT-CONFIG-OVERLAY-CONTRACT).
	return {
		on: { type: "cron", id, pattern },
		run: { kind: "local", folder: run.folder, flow: run.flow, task: run.task, provider: run.provider, model: run.model, maxTurns: run.maxTurns },
	};
}

/**
 * Validate an `{any, all, none}` label predicate. Selectors are validated as arrays of non-empty strings
 * BEFORE the positive-selector count, because `.length` is truthy on a string too -- a string selector
 * that reached the pure `matchesRule` in the receiver would throw there, breaking the gate's never-throw
 * invariant. Returns the normalized `{any, all, none}`.
 */
function validatePredicate(on, index, path, requirePositive) {
	const at = `trigger at index ${index}`;
	for (const key of ["any", "all", "none"]) {
		const selector = on[key];
		if (selector === undefined) continue;
		if (!Array.isArray(selector) || selector.some((s) => typeof s !== "string" || s.trim() === "")) {
			throw configError(`${at}: on.${key} must be an array of non-empty strings: ${path}`);
		}
	}
	// A `none`-only rule matches every event lacking the excluded labels -- wider than a single-label
	// allowlist, which would weaken CONST-TRIGGER-AUTHOR-GATE. Require a positive selector where the
	// predicate IS the approval gate (label triggers, and `labeled` PR triggers).
	if (requirePositive && (on.any?.length ?? 0) + (on.all?.length ?? 0) === 0) {
		throw configError(`${at}: needs at least one positive selector (on.any or on.all): ${path}`);
	}
	return { any: on.any, all: on.all, none: on.none };
}

function normalizeLabel(on, run, index, path) {
	const at = `trigger at index ${index}`;
	const predicate = validatePredicate(on, index, path, true);
	if (!isNonEmptyString(run.flow)) {
		throw configError(`${at}: label trigger run.flow must be a non-empty string: ${path}`);
	}
	return { on: { type: "label", any: predicate.any, all: predicate.all, none: predicate.none }, run: { kind: "github", flow: run.flow } };
}

function normalizeComment(on, run, index, path, state) {
	const at = `trigger at index ${index}`;
	if (!isNonEmptyString(on.phrase)) {
		throw configError(`${at}: comment trigger on.phrase must be a non-empty string: ${path}`);
	}
	if (!isNonEmptyString(run.flow)) {
		throw configError(`${at}: comment trigger run.flow (the default flow) must be a non-empty string: ${path}`);
	}
	state.commentCount += 1;
	if (state.commentCount > 1) {
		throw configError(`${at}: at most one comment trigger is allowed: ${path}`);
	}
	return { on: { type: "comment", phrase: on.phrase }, run: { kind: "github", flow: run.flow } };
}

function normalizePullRequest(on, run, index, path) {
	const at = `trigger at index ${index}`;

	const actions = on.action;
	if (!Array.isArray(actions) || actions.length === 0) {
		throw configError(`${at}: pull_request on.action must be a non-empty array: ${path}`);
	}
	for (const a of actions) {
		if (!PR_ACTIONS.has(a)) {
			throw configError(`${at}: pull_request on.action has an unsupported action ${JSON.stringify(a)} (expected labeled|opened|synchronize|reopened): ${path}`);
		}
	}

	// A `labeled` PR trigger is gated by its label predicate (the collaborator-applied label is the
	// approval), so it MUST carry a positive selector -- exactly as a label trigger does. Auto actions
	// (opened/synchronize/reopened) are gated by author_association in the filter, so a predicate is
	// optional there and only narrows scope when present.
	const requirePositive = actions.includes("labeled");
	const predicate = validatePredicate(on, index, path, requirePositive);
	if (!isNonEmptyString(run.flow)) {
		throw configError(`${at}: pull_request trigger run.flow must be a non-empty string: ${path}`);
	}
	return {
		on: { type: "pull_request", action: [...actions], any: predicate.any, all: predicate.all, none: predicate.none },
		run: { kind: "github", flow: run.flow },
	};
}
