/**
 * Worker configuration, from the environment. Validated and fail-loud: a misconfigured worker
 * should refuse to start with a clear message, not launch and fail per-job.
 *
 * Errors are tagged `piDispatchConfig` so the CLI/entry can print them cleanly and exit non-zero.
 */

import { existsSync } from "node:fs";

export function configError(message) {
	const error = new Error(message);
	error.piDispatchConfig = true;
	return error;
}

export function positiveInt(env, name, fallback) {
	const raw = env[name];
	if (raw === undefined || raw === "") {
		if (fallback !== undefined) return fallback;
		throw configError(`missing required env: ${name}`);
	}
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || n < 1 || String(n) !== String(raw).trim()) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (want a positive integer)`);
	}
	return n;
}

/**
 * Parse the worker's config from `env` (default process.env). All defaults are conservative:
 * spend controls (`PI_DAILY_CAP`, `PI_MAX_TURNS`) exist to bound money, so they default low, and a
 * cap of 0 would fail closed (budget.mjs refuses every job) rather than mean "unlimited".
 */
export function loadConfig(env = process.env, { fileExists = existsSync } = {}) {
	const model = env.PI_MODEL ?? "claude-sonnet-4-5-20250929"; // dated snapshot; deterministic per CONST-PI-VERSION-PINNED
	return {
		valkeyUrl: env.VALKEY_URL ?? "redis://127.0.0.1:6379",
		concurrency: positiveInt(env, "PI_CONCURRENCY", 3), // DES-CONCURRENCY-3
		dailyCap: positiveInt(env, "PI_DAILY_CAP", 25), // bounds container STARTS per day (money)
		provider: env.PI_PROVIDER ?? "anthropic",
		model,
		maxTurns: positiveInt(env, "PI_MAX_TURNS", 30), // pi has no turn limit; we impose one
		jobImage: env.PI_JOB_IMAGE ?? "pi-job:latest",
		jobsDir: env.PI_JOBS_DIR ?? defaultJobsDir(),
		schedulesFile: env.PI_SCHEDULES_FILE ?? null, // DES-CRON-VIA-BULLMQ-SCHEDULER: schedule list is a host file; null = cron disabled
		schedulerStallMax: positiveInt(env, "PI_SCHEDULER_STALL_MAX", 2), // CONST-RETRY-INFRA-ONLY: per-scheduler stall backstop; positiveInt rejects <1 so a 0 threshold fails closed
		github: loadGitHubAuth(env, fileExists),
	};
}

/**
 * Parse and validate the GitHub auth block consumed verbatim by `makeGitHubAuth(cfg)` in
 * get-token.mjs. Shape is fixed: `{ source, patVar, appId, installationId, privateKeyPath }`.
 * Fails loud at load time so a misconfigured worker refuses to boot rather than failing per-job.
 */
export function loadGitHubAuth(env, fileExists) {
	const source = env.GITHUB_AUTH_SOURCE ?? "gh";
	if (source !== "pat" && source !== "gh" && source !== "app") {
		throw configError(`invalid GITHUB_AUTH_SOURCE: ${source} (expected pat|gh|app)`);
	}

	const patVar = env.GITHUB_PAT_VAR ?? "GITHUB_PAT";
	const appId = env.GITHUB_APP_ID;
	const installationId = env.GITHUB_APP_INSTALLATION_ID;
	const privateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;

	if (source === "pat") {
		const pat = (env[patVar] ?? "").trim();
		if (!pat) {
			throw configError(`GITHUB_AUTH_SOURCE=pat requires a non-empty ${patVar}`);
		}
	}

	if (source === "app") {
		const missing = [];
		if (!appId) missing.push("GITHUB_APP_ID");
		if (!installationId) missing.push("GITHUB_APP_INSTALLATION_ID");
		if (!privateKeyPath) missing.push("GITHUB_APP_PRIVATE_KEY_PATH");
		if (missing.length > 0) {
			throw configError(`GITHUB_AUTH_SOURCE=app requires ${missing.join(", ")}`);
		}
		if (!fileExists(privateKeyPath)) {
			throw configError(`GITHUB_APP_PRIVATE_KEY_PATH does not exist: ${privateKeyPath}`);
		}
	}

	return { source, patVar, appId, installationId, privateKeyPath };
}

function defaultJobsDir() {
	// Under the OS temp dir by default. Holds only the read-only /job inputs (prompt + .pi/); the
	// workspace for a local job is the operator's own folder, not here.
	return `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/pi-dispatch/jobs`.replace(/\\/g, "/");
}
