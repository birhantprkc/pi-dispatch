import { findEnvKeys } from "@earendil-works/pi-ai/compat";

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
 * Assemble the container env. `hostEnv` is the worker's process.env; `job` carries the resolved
 * config and the per-job scoped token (GitHub-backed jobs only).
 *
 * Throws if the provider is not configured -- a deterministic misconfiguration the caller maps to
 * a pre-spend refusal, never a launched-then-failed container.
 */
export function buildContainerEnv({ provider, model, maxTurns, maxTokens, jobId, githubToken, hostEnv, allowGlobalExtensions = false, forwardEnv = [] }) {
	const keyVars = providerKeyVars(provider, hostEnv);
	if (!keyVars || keyVars.length === 0) {
		const error = new Error(`provider ${provider} has no configured credential in the worker environment`);
		error.piDispatchConfig = true;
		throw error;
	}

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

	// The provider credential(s), by their real names, copied from the host by EXACT name. Passing
	// the value under pi's expected variable name is what lets pi's own auth resolution find it.
	for (const name of keyVars) {
		env[name] = hostEnv[name];
	}

	// Operator-declared extra vars (PI_FORWARD_ENV), forwarded by EXACT name -- the allowlist
	// no-broad-env-into-container prescribes, not a host pass-through. This is how a CUSTOM provider's
	// key (one pi's findEnvKeys table does not know) reaches the container. A name whose value is unset
	// on the host is skipped, never forwarded as empty.
	for (const name of forwardEnv) {
		if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
	}

	// GitHub-backed jobs only. Local-folder jobs have no token (CONST-TOKEN-SCOPED-PER-JOB is
	// scoped to GitHub jobs). Absent token => absent variable, never an empty one.
	if (githubToken) env.GITHUB_TOKEN = githubToken;

	return env;
}
