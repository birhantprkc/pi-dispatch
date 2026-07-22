/**
 * Receiver configuration, from the environment. Validated and fail-loud, mirroring the worker:
 * a misconfigured receiver refuses to start with a clear message rather than booting into a state
 * where webhooks silently go unverified or untriggered.
 *
 * The security-sensitive GitHub auth block is single-sourced from `@pi-dispatch/worker/config` --
 * `loadGitHubAuth` is parsed once, in one place, so the receiver and worker cannot drift on it.
 *
 * - `webhookSecret` is REQUIRED: without it the receiver cannot verify `X-Hub-Signature-256` over the
 *   raw body, and an unverified webhook is a forgeable paid-agent trigger (CONST-HMAC-OVER-RAW-BODY).
 * - `labelFlows` IS the label allowlist: each flow declares an `{any, all, none}` label rule, and only
 *   collaborators can apply labels, so the allowlist is the human approval gate (CONST-TRIGGER-AUTHOR-GATE).
 * - `bind` defaults to `0.0.0.0` (public): the receiver is the trigger surface that lives outside pi
 *   (DES-TRIGGER-OUTSIDE-PI). It carries no admin/dashboard config -- the admin surface is a pi extension
 *   in the operator's session and binds no port (DES-ADMIN-VIA-PI-EXTENSION), so there is none here.
 *
 * Errors are tagged `piDispatchConfig` (via the shared `configError`) so the entry can print them
 * cleanly and exit non-zero.
 */

import { existsSync, readFileSync } from "node:fs";
import { configError, loadGitHubAuth, positiveInt } from "@pi-dispatch/worker/config";

const DEFAULT_FLOWS_PATH = "deploy/receiver.flows.json";

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
		labelFlows: loadLabelFlows(env, readFile, fileExists),
		commentTrigger: {
			phrase: env.COMMENT_TRIGGER_PHRASE ?? "@pi",
			defaultFlow: env.COMMENT_DEFAULT_FLOW ?? null,
		},
		github: loadGitHubAuth(env, fileExists),
	};
}

/**
 * Load and validate the flow -> `{any, all, none}` rule allowlist from the flows file. The file is the
 * reviewed, committed source of truth for which label sets trigger which flow; a missing, unparseable, or
 * malformed file fails loud rather than degrading to an empty (silently trigger-nothing) allowlist.
 *
 * Each rule needs at least one positive selector (`any` or `all`): a `none`-only rule matches every
 * labeled event lacking the excluded labels, which is wider than today's single-label allowlist and would
 * weaken CONST-TRIGGER-AUTHOR-GATE. Selectors are validated as arrays of non-empty strings BEFORE the
 * positive-selector count, because `.length` is truthy on a string too -- a string selector that reached
 * the pure `matchesRule` would throw there, breaking the gate's never-throw invariant.
 */
function loadLabelFlows(env, readFile, fileExists) {
	const path = env.RECEIVER_FLOWS_PATH ?? DEFAULT_FLOWS_PATH;

	if (!fileExists(path)) {
		throw configError(`receiver flows file not found: ${path}`);
	}

	let parsed;
	try {
		parsed = JSON.parse(readFile(path, "utf8"));
	} catch {
		throw configError(`receiver flows file is not valid JSON: ${path}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw configError(`receiver flows file must be a JSON object of flow -> {any, all, none} rules: ${path}`);
	}
	for (const [flowName, rule] of Object.entries(parsed)) {
		if (flowName.trim() === "" || /^\d+$/.test(flowName)) {
			throw configError(`receiver flows file has an empty or integer-like flow name ${JSON.stringify(flowName)}: ${path}`);
		}
		if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
			throw configError(`receiver flows file flow ${JSON.stringify(flowName)} must map to an {any, all, none} rule object: ${path}`);
		}
		for (const key of ["any", "all", "none"]) {
			const selector = rule[key];
			if (selector === undefined) continue;
			if (!Array.isArray(selector) || selector.some((s) => typeof s !== "string" || s.trim() === "")) {
				throw configError(`receiver flows file flow ${JSON.stringify(flowName)} has a ${key} that is not an array of non-empty strings: ${path}`);
			}
		}
		if ((rule.any?.length ?? 0) + (rule.all?.length ?? 0) === 0) {
			throw configError(`receiver flows file flow ${JSON.stringify(flowName)} needs at least one positive selector (any or all): ${path}`);
		}
	}

	return parsed;
}
