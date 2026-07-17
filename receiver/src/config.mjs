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
 * - `labelFlows` IS the label allowlist: only labels present here map to a flow, and only collaborators
 *   can apply labels, so the map is the human approval gate (CONST-TRIGGER-AUTHOR-GATE).
 * - `bind` defaults to `0.0.0.0` (public): the receiver is the trigger surface that lives outside pi
 *   (DES-TRIGGER-OUTSIDE-PI). It carries no panel/admin/dashboard config -- the panel is a separate
 *   service on a separate bind (DES-PANEL-SEPARATE-FROM-RECEIVER), so there is no admin surface here.
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
 * Load and validate the label->flow allowlist from the flows file. The file is the reviewed, committed
 * source of truth for which labels trigger which flow; a missing, unparseable, or malformed file fails
 * loud rather than degrading to an empty (silently trigger-nothing) allowlist.
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
		throw configError(`receiver flows file must be a JSON object of label -> flow strings: ${path}`);
	}
	for (const [label, flow] of Object.entries(parsed)) {
		if (typeof flow !== "string" || flow.trim() === "") {
			throw configError(`receiver flows file has a non-string or empty flow for label ${JSON.stringify(label)}: ${path}`);
		}
	}

	return parsed;
}
