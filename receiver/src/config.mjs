/**
 * Receiver configuration, from the environment. Validated and fail-loud, mirroring the worker:
 * a misconfigured receiver refuses to start with a clear message rather than booting into a state
 * where webhooks silently go unverified or untriggered.
 *
 * The security-sensitive GitHub auth block is single-sourced from `@pi-dispatch/worker/config` --
 * `loadGitHubAuth` is parsed once, in one place, so the receiver and worker cannot drift on it. The
 * trigger schema is likewise single-sourced from `@pi-dispatch/worker/triggers` -- both services validate
 * the WHOLE unified triggers file and each selects the `on.type` it owns (issue #20).
 *
 * - `webhookSecret` is REQUIRED: without it the receiver cannot verify `X-Hub-Signature-256` over the
 *   raw body, and an unverified webhook is a forgeable paid-agent trigger (CONST-HMAC-OVER-RAW-BODY).
 * - `triggers` is the receiver's webhook allowlist, grouped by type: label rules (the label IS the
 *   collaborator approval), the single comment trigger (phrase + default flow), and pull_request rules.
 *   Only collaborators can apply labels, so the label/PR-label allowlist is the human approval gate
 *   (CONST-TRIGGER-AUTHOR-GATE).
 * - `bind` defaults to `0.0.0.0` (public): the receiver is the trigger surface that lives outside pi
 *   (DES-TRIGGER-OUTSIDE-PI). It carries no admin/dashboard config -- the admin surface is a pi extension
 *   in the operator's session and binds no port (DES-ADMIN-VIA-PI-EXTENSION), so there is none here.
 *
 * Errors are tagged `piDispatchConfig` (via the shared `configError`) so the entry can print them
 * cleanly and exit non-zero.
 */

import { existsSync, readFileSync } from "node:fs";
import { configError, loadGitHubAuth, positiveInt } from "@pi-dispatch/worker/config";
import { parseTriggers } from "@pi-dispatch/worker/triggers";

const DEFAULT_TRIGGERS_PATH = "deploy/triggers.json";

/**
 * Parse the receiver's config from `env` (default process.env). Filesystem access is injected
 * (`readFile`, `fileExists`) so the loader is hermetically testable and never touches disk in tests.
 */
export function loadReceiverConfig(env = process.env, { readFile = readFileSync, fileExists = existsSync } = {}) {
	const webhookSecret = env.WEBHOOK_SECRET;
	if (webhookSecret === undefined || webhookSecret.trim() === "") {
		throw configError("WEBHOOK_SECRET is required; refusing to start a receiver that cannot verify signatures");
	}

	return {
		webhookSecret,
		valkeyUrl: env.VALKEY_URL ?? "redis://127.0.0.1:6379", // mirrors worker config: producer and consumer share one queue
		port: positiveInt(env, "RECEIVER_PORT", 3000),
		bind: env.RECEIVER_BIND ?? "0.0.0.0",
		triggers: loadTriggers(env, readFile, fileExists),
		github: loadGitHubAuth(env, fileExists),
	};
}

/**
 * Load, validate, and group the receiver's webhook triggers from the unified triggers file. The file is
 * the reviewed, committed source of truth for which events trigger which flow; a missing, unparseable, or
 * malformed file fails loud rather than degrading to an empty (silently trigger-nothing) allowlist.
 *
 * The shared `parseTriggers` validates the WHOLE file (including the on x run matrix and cron entries the
 * worker owns); this loader keeps only the webhook types and groups them PER FORGE, so `cfg.triggers` is
 * `{ github: <group>, gitlab: <group>, knownFlows }` where each group is:
 *   - `label`:       ordered `{ index, predicate, flow, packages, image }` rules (first match wins in the filter).
 *   - `comment`:     the single `{ index, phrase, defaultFlow, packages, image }` (or null when no comment trigger is configured).
 *   - `pullRequest`: ordered `{ index, actions:Set, predicate, flow, packages, image }` rules.
 * and `knownFlows` is every webhook `run.flow`, so a comment's `<phrase> <flow>` override cannot summon an
 * unlisted flow.
 *
 * Grouping by forge FIRST is what keeps each forge's gate reading only its own rules: a GitLab delivery
 * can never match a rule an operator wrote for GitHub, even when both name the same label. `knownFlows`
 * stays shared deliberately -- a flow is a skill in a repo, not a property of the forge that asked for it,
 * and the set exists to bound which names a comment may summon, which is the same bound either way.
 *
 * `packages` (load the operator-staged pi packages) and `image` (which container image the job runs in) are
 * the entry's per-trigger execution fields (INT-TRIGGERS-FILE-CONTRACT, REQ-GLOBAL-PI-OVERLAY). Both ride on
 * the RULE, not on the group, because the filter resolves them from the rule that actually matched -- two
 * rules in one file may name different images, and picking the group's would run the wrong toolchain for
 * whichever rule lost. Absent stays undefined so the filter can omit it entirely and leave an unflagged job
 * byte-identical to today's.
 *
 * Each grouped rule carries `index`: its 0-based position in the RAW `triggers` array, cron entries
 * counted. The raw file index is the rule's identity -- the filter reports it on the job as
 * `trigger.matched.index`, so a run is explainable back to the exact triggers.json entry that fired it.
 */
function loadTriggers(env, readFile, fileExists) {
	const path = env.PI_TRIGGERS_FILE ?? DEFAULT_TRIGGERS_PATH;

	if (!fileExists(path)) {
		throw configError(`triggers file not found: ${path}`);
	}

	const parsed = parseTriggers(readFile(path, "utf8"), path); // fail-loud

	// Every forge gets a group whether or not the file names it, so the filter can read
	// `cfg.triggers[kind].label` without a presence check and an unconfigured forge simply matches nothing.
	const groups = { github: emptyGroup(), gitlab: emptyGroup() };
	const knownFlows = new Set();

	for (const [index, { on, run }] of parsed.entries()) {
		if (on.type === "cron") continue; // the worker owns cron; the receiver never fires it -- but it keeps its index
		knownFlows.add(run.flow);
		const group = groups[run.kind];
		if (on.type === "label") {
			group.label.push({ index, predicate: { any: on.any, all: on.all, none: on.none }, flow: run.flow, packages: run.packages, image: run.image });
		} else if (on.type === "comment") {
			group.comment = { index, phrase: on.phrase, defaultFlow: run.flow, packages: run.packages, image: run.image }; // parseTriggers guarantees at most one per forge
		} else if (on.type === "pull_request") {
			group.pullRequest.push({ index, actions: new Set(on.action), predicate: { any: on.any, all: on.all, none: on.none }, flow: run.flow, packages: run.packages, image: run.image });
		}
	}

	return { ...groups, knownFlows };
}

function emptyGroup() {
	return { label: [], comment: null, pullRequest: [] };
}

/** The triggers file path the receiver reads (env override or the committed deploy default). */
export function triggersFilePath(env = process.env) {
	return env.PI_TRIGGERS_FILE ?? DEFAULT_TRIGGERS_PATH;
}

/**
 * Live-reload the receiver's triggers: re-read + re-group the file and swap `cfg.triggers` IN PLACE, so the
 * already-wired handler (which closes over `cfg`) picks up the new triggers on its next request -- no
 * restart, mirroring how the worker re-reads the settings overlay per job. If the new file is
 * missing/unparseable/invalid, the running triggers are KEPT (never crash a live receiver on a bad edit)
 * and the reason is returned. Returns `{ ok: true }` or `{ invalid }`.
 */
export function reloadTriggers(env, cfg, { readFile = readFileSync, fileExists = existsSync } = {}) {
	try {
		cfg.triggers = loadTriggers(env, readFile, fileExists);
		return { ok: true };
	} catch (e) {
		return { invalid: e?.message ?? String(e) };
	}
}
