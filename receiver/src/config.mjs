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
 * The shared `parseTriggers` validates the WHOLE file (including the on x run diagonal and cron entries the
 * worker owns); this loader keeps only the webhook types and groups them for the filter:
 *   - `label`:       ordered `{ predicate, flow }` rules (first match wins in the filter).
 *   - `comment`:     the single `{ phrase, defaultFlow }` (or null when no comment trigger is configured).
 *   - `pullRequest`: ordered `{ actions:Set, predicate, flow }` rules.
 *   - `knownFlows`:  every webhook `run.flow`, so a comment's `<phrase> <flow>` override cannot summon an
 *                    unlisted flow.
 */
function loadTriggers(env, readFile, fileExists) {
	const path = env.PI_TRIGGERS_FILE ?? DEFAULT_TRIGGERS_PATH;

	if (!fileExists(path)) {
		throw configError(`triggers file not found: ${path}`);
	}

	const parsed = parseTriggers(readFile(path, "utf8"), path); // fail-loud

	const label = [];
	let comment = null;
	const pullRequest = [];
	const knownFlows = new Set();

	for (const { on, run } of parsed) {
		if (on.type === "cron") continue; // the worker owns cron; the receiver never fires it
		knownFlows.add(run.flow);
		if (on.type === "label") {
			label.push({ predicate: { any: on.any, all: on.all, none: on.none }, flow: run.flow });
		} else if (on.type === "comment") {
			comment = { phrase: on.phrase, defaultFlow: run.flow }; // parseTriggers guarantees at most one
		} else if (on.type === "pull_request") {
			pullRequest.push({ actions: new Set(on.action), predicate: { any: on.any, all: on.all, none: on.none }, flow: run.flow });
		}
	}

	return { label, comment, pullRequest, knownFlows };
}
