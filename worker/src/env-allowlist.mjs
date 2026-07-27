import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";

function configError(message) {
	const error = new Error(message);
	error.piDispatchConfig = true;
	return error;
}

/**
 * Build the EXACT environment a job container receives. Never a pass-through.
 *
 * `no-broad-env-into-container` is a BLOCKER, and for good reason: `ANTHROPIC_OAUTH_TOKEN`
 * silently outranks `ANTHROPIC_API_KEY`, so one stray host variable would redirect which
 * credential every job spends, with no error and no log line. So we forward a closed set.
 *
 * The provider key variable is DERIVED from pi's own table, not hardcoded. `findEnvKeys(provider,
 * env)` returns the provider's key variable names that are actually PRESENT in `env`, in
 * precedence order (OAuth before API key). Deriving it means:
 *   - any of pi's ~30 providers works with no code change here;
 *   - the list cannot drift when pi adds a provider (a hand-copied table would);
 *   - `undefined` return === "this provider is not configured on this host" === refuse the job
 *     BEFORE spending, rather than launch a container that will fail auth on the first call.
 *
 * `getApiKeyEnvVars` (the full candidate list) is intentionally NOT exported by pi; `findEnvKeys`
 * against our own process.env is the right tool anyway, because we only ever forward keys we have.
 */
export function providerKeyVars(provider, hostEnv) {
	return findEnvKeys(provider, hostEnv);
}

/**
 * Resolve the provider credential(s) to inject, as `{ VAR_NAME: value }`.
 *
 * Primary source: the worker's own environment, by pi's expected variable name(s) (`findEnvKeys`).
 * Fallback (ON by default; `PI_AUTH_FROM_PI=0` forces env-only): when the env has none, read the credential
 * from the host's pi `auth.json`. This is a HOST-SIDE read of a host-held secret, injected via env exactly
 * like the env path — never a credential file mounted into the container (`CONST-TOKEN-SCOPED-PER-JOB`).
 * API-key credentials only; an OAuth/subscription login is refused (it expires, the container cannot refresh
 * it, and it is not the credential for an unattended service). Throws a config-tagged error (pre-spend
 * refusal) when neither source yields a credential.
 */
export function resolveProviderCredential({ provider, hostEnv, authFromPi = false, agentDir, readFile = readFileSync }) {
	const envNames = providerKeyVars(provider, hostEnv);
	if (envNames && envNames.length > 0) {
		return Object.fromEntries(envNames.map((name) => [name, hostEnv[name]]));
	}
	if (authFromPi) {
		const { name, value } = credentialFromPiAuth(provider, agentDir ?? defaultAgentDir(hostEnv), readFile);
		return { [name]: value };
	}
	throw configError(`provider ${provider} has no configured credential in the worker environment`);
}

function defaultAgentDir(hostEnv) {
	// pi's getAgentDir() default, resolved without importing the whole pi SDK into the worker.
	return hostEnv.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function credentialFromPiAuth(provider, agentDir, readFile) {
	const path = join(agentDir, "auth.json");
	let auth;
	try {
		auth = JSON.parse(readFile(path, "utf8"));
	} catch {
		throw configError(`no credential for provider "${provider}": not in the worker environment, and no pi login at ${path} — set the key in .env, or run \`pi login\``);
	}
	const cred = auth?.[provider];
	if (!cred) throw configError(`no credential for provider "${provider}": not in the worker environment, and ${path} has no "${provider}" login — set the key in .env, or run \`pi login\``);
	if (cred.type === "oauth") {
		throw configError(
			`the pi login for "${provider}" is an OAuth/subscription token, which cannot power an unattended service (it expires and the container cannot refresh it). Configure an API key — with a provider-side spend limit — instead.`,
		);
	}
	if (cred.type !== "api_key" || !cred.key) throw configError(`unsupported pi credential for "${provider}" in ${path} — set an API key in .env`);
	const name = resolveEnvName(provider, cred);
	if (!name) {
		throw configError(`could not determine the environment variable pi expects for provider "${provider}" — set it in the worker environment manually`);
	}
	return { name, value: cred.key };
}

/**
 * The env var name pi reads this provider's key from. Discovered through pi's OWN `findEnvKeys` (the
 * oracle) rather than a hand-maintained provider→var table that would drift: try the credential's own
 * `env` hint plus the conventional `<PROVIDER>_API_KEY`/`_KEY`, and forward the one pi recognizes.
 */
function resolveEnvName(provider, cred) {
	const upper = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	const candidates = [cred.env, `${upper}_API_KEY`, `${upper}_KEY`].filter((s) => typeof s === "string" && s.length > 0);
	const synthetic = Object.fromEntries(candidates.map((name) => [name, cred.key]));
	const recognized = findEnvKeys(provider, synthetic);
	return recognized?.[0] ?? null;
}

/**
 * Assemble the container env. `hostEnv` is the worker's process.env; `job` carries the resolved
 * config and the per-job scoped token (GitHub-backed jobs, and local cron jobs that opted in via
 * run.github).
 *
 * Throws if the provider is not configured -- a deterministic misconfiguration the caller maps to
 * a pre-spend refusal, never a launched-then-failed container.
 */
export function buildContainerEnv({ provider, model, maxTurns, maxTokens, jobId, githubToken, hostEnv, allowGlobalExtensions = false, forwardEnv = [], authFromPi = false, agentDir, readFile = readFileSync }) {
	// The provider credential(s), by pi's expected variable name(s) -- from the worker env, or (when
	// PI_AUTH_FROM_PI is set and the env has none) host-side from pi's auth.json. Throws (config) if
	// neither source yields one, which the processor turns into a pre-spend refusal.
	const credEnv = resolveProviderCredential({ provider, hostEnv, authFromPi, agentDir, readFile });

	const env = {
		PI_PROVIDER: provider,
		PI_MODEL: model,
		PI_MAX_TURNS: String(maxTurns),
		// The optional per-job token budget (issue #25). Absent/null => variable omitted (docker-run skips
		// undefined), so the runner attaches a pure meter with no cap. Never an empty string.
		PI_MAX_TOKENS: maxTokens === null || maxTokens === undefined ? undefined : String(maxTokens),
		PI_JOB_ID: jobId,
		// Baked into the image, but harmless to restate; kept here so the container contract is
		// visible in one place. INT-CONTAINER-RUNTIME-CONTRACT.
		PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
		PLAYWRIGHT_MCP_BROWSER: "chromium",
		PLAYWRIGHT_MCP_SANDBOX: "false",
		// Arms loading of the global overlay's extensions in the runner (REQ-GLOBAL-PI-OVERLAY). Fail-closed:
		// only set when the operator opted in, so an unset value keeps overlay extensions dormant.
		PI_GLOBAL_ALLOW_EXTENSIONS: allowGlobalExtensions ? "1" : undefined,
	};

	// The provider credential(s), under pi's expected variable name(s), so pi's own auth resolution finds them.
	Object.assign(env, credEnv);

	// Operator-declared extra vars (PI_FORWARD_ENV), forwarded by EXACT name -- the allowlist
	// no-broad-env-into-container prescribes, not a host pass-through. This is how a CUSTOM provider's
	// key (one pi's findEnvKeys table does not know) reaches the container. A name whose value is unset
	// on the host is skipped, never forwarded as empty.
	for (const name of forwardEnv) {
		if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
	}

	// GitHub-backed jobs, and local cron jobs that opted in via run.github. Other local-folder jobs
	// have no token (CONST-TOKEN-SCOPED-PER-JOB). The mint goes into BOTH variables because the gh
	// CLI prefers GH_TOKEN over GITHUB_TOKEN -- mirroring forecloses any precedence surprise inside
	// the container. This assignment deliberately sits AFTER the PI_FORWARD_ENV loop so a forwarded
	// name can never override the mint (and loadConfig refuses those names at load anyway).
	// Absent token => absent variable, never an empty one.
	if (githubToken) {
		env.GITHUB_TOKEN = githubToken;
		env.GH_TOKEN = githubToken;
	}

	return env;
}
