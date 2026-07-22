import { configError } from "./outcome.mjs";

/**
 * Parse and VALIDATE the runner's environment.
 *
 * Every failure here is a deterministic misconfiguration -- a forgotten or malformed env var
 * that a worker template bug ships to every job, not a transient fault. So each throws a
 * configError (exit 2, not retried); routing them through the queue's retry would pay to
 * rediscover the same typo forever. This is a pure function so the classification is testable
 * without a container or a real pi.
 */
export function parseRunnerEnv(env) {
	const provider = requireEnv(env, "PI_PROVIDER");
	const model = requireEnv(env, "PI_MODEL");
	const maxTurns = parsePositiveInt(env, "PI_MAX_TURNS");
	const maxTokens = parseOptionalPositiveInt(env, "PI_MAX_TOKENS");

	return {
		provider,
		model,
		maxTurns,
		maxTokens,
		retry: {
			maxRetries: parsePositiveInt(env, "PI_RETRY_MAX", 2),
			baseDelayMs: parsePositiveInt(env, "PI_RETRY_BASE_MS", 2000),
		},
	};
}

function requireEnv(env, name) {
	const value = env[name];
	if (!value) throw configError(`missing required env: ${name}`);
	return value;
}

function parsePositiveInt(env, name, fallback) {
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
 * An OPTIONAL positive-int knob: an absent or empty var is `null` (the cap is disabled), not an
 * error. A present value is validated identically to parsePositiveInt -- a malformed cap is a
 * config error (exit 2), never a silently-ignored knob. This is the "unset means off" shape
 * parsePositiveInt cannot express, used by the optional PI_MAX_TOKENS budget.
 */
function parseOptionalPositiveInt(env, name) {
	const raw = env[name];
	if (raw === undefined || raw === "") return null;
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || n < 1 || String(n) !== String(raw).trim()) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (want a positive integer)`);
	}
	return n;
}
