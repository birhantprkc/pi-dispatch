import { existsSync } from "node:fs";
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
		// REQ-GLOBAL-PI-OVERLAY: arm loading of the global overlay's extensions. Fail-closed -- anything
		// but the exact string "1" leaves overlay extensions dormant. Not a configError: an unset flag is
		// the normal, safe state, not a misconfiguration.
		allowGlobalExtensions: env.PI_GLOBAL_ALLOW_EXTENSIONS === "1",
		// INT-CONTAINER-JOB-INPUTS: the staged pi packages this trigger opted into, as ABSOLUTE
		// container paths under /opt/pi-global/packages. Empty for every trigger that did not opt in.
		packages: parsePackagePaths(env, "PI_PACKAGES"),
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

/**
 * Parse a ":"-delimited list of staged pi package roots (INT-CONTAINER-JOB-INPUTS).
 *
 * Unset or empty is `[]` -- a trigger that opted into no packages is the normal state, not a
 * misconfiguration. Every present entry must be an ABSOLUTE path with no `..` segment, or it is a
 * configError (exit 2, not retried).
 *
 * The validation lives HERE, before pi ever sees the value, because pi's own resolver gives no
 * second chance:
 *
 * - A local source that does not resolve is SKIPPED with no error and no diagnostic
 *   (package-manager resolveLocalExtensionSource: `if (!existsSync(resolved)) return;`). A typo
 *   therefore reads exactly like "this trigger staged nothing" -- clean exit 0, no tools.
 * - A RELATIVE entry is resolved against the process cwd, which is `/workspace` -- the adversarial
 *   clone. `PI_PACKAGES=packages/tools` would load an extension out of the checked-out branch, which
 *   is the entire trust boundary the runner exists to hold. Absolute-only closes that by construction,
 *   and rejecting `..` stops an entry from climbing out of the read-only staging mount.
 */
function parsePackagePaths(env, name) {
	const raw = env[name];
	if (raw === undefined || raw === "") return [];

	const paths = [];
	for (const entry of raw.split(":")) {
		// Empty segments are the shape a shell leaves behind ("a::b", a trailing ":"), not an error.
		if (entry === "") continue;
		if (!entry.startsWith("/")) {
			throw configError(`invalid ${name} entry: ${JSON.stringify(entry)} (want an absolute container path)`);
		}
		if (entry.split("/").includes("..")) {
			throw configError(`invalid ${name} entry: ${JSON.stringify(entry)} (must not contain a ".." segment)`);
		}
		paths.push(entry);
	}
	return paths;
}

/**
 * Assert every staged package root is actually present on disk.
 *
 * Separate from parseRunnerEnv on purpose: parseRunnerEnv promises to be PURE, and this touches the
 * filesystem. `fileExists` is injected so the check is unit-testable without a container.
 *
 * This is the only thing that turns a mount failure into a visible failure. The SDK will not tell
 * you: pi skips an absent local package source silently (no error, no diagnostic), and the one error
 * it does raise lands in `extensionsResult.errors`, which nothing reads -- and which already carries
 * an entry for `/job/pi/extensions` on EVERY job, so it can never be surfaced wholesale. A job whose
 * packages never mounted would otherwise run to a clean exit 0 without the tools its flow was
 * written for, and report success for work it could not have done.
 */
export function assertPackagePathsExist(paths, { fileExists = existsSync } = {}) {
	for (const path of paths) {
		if (!fileExists(path)) {
			throw configError(`staged package path does not exist: ${path} (PI_PACKAGES)`);
		}
	}
}

/**
 * Force pi's offline mode on for this process (INT-SDK-SESSION-OPTIONS).
 *
 * Offline is a property of the RUNNER, not of its caller. The worker sets PI_OFFLINE=1 on every job
 * today, but a hand-run container, a debugging `docker run`, or a future worker regression must not
 * be able to re-arm pi's job-time-install path: with offline off, an unresolved package source is a
 * live `npm install` from inside the job, against a network the job's own input can influence, at
 * agent runtime. Setting it here means the guarantee cannot be dropped by whoever starts us.
 *
 * Idempotent, and only ever tightens: an env that already says exactly "1" is left untouched.
 * Anything else -- unset, "0", "true", "yes" -- is overwritten with "1". pi's own
 * isOfflineModeEnabled accepts "true"/"yes" too, but writing the canonical "1" keeps the value we
 * assert on and the value pi reads identical.
 */
export function enforceOfflineMode(env = process.env) {
	if (env.PI_OFFLINE === "1") return;
	env.PI_OFFLINE = "1";
}
