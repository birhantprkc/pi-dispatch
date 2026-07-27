import assert from "node:assert/strict";
import { test } from "node:test";

// env-allowlist imports @earendil-works/pi-ai (for findEnvKeys). That needs node >=22.19.0 and
// installed deps, so it skips on a below-floor dev box and runs in CI, where
// PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a skip into a hard failure. A skipped security test is
// an unverified one -- the same discipline as the runner's loader tests.
let mod;
let importError;
try {
	mod = await import("../src/env-allowlist.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`env-allowlist tests are REQUIRED here but pi-ai could not import.\n${importError}`);
}
const skip = mod ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;
const { buildContainerEnv, providerKeyVars } = mod ?? {};

const HOST = {
	ANTHROPIC_API_KEY: "sk-ant-real",
	OPENAI_API_KEY: "sk-openai-real",
	// The stray host variable no-broad-env-into-container exists to defend against:
	AWS_SECRET_ACCESS_KEY: "must-not-leak",
	HOME: "/root",
	PATH: "/usr/bin",
};

test("derives the provider key var from the host env, in precedence order", { skip }, () => {
	assert.deepEqual(providerKeyVars("anthropic", HOST), ["ANTHROPIC_API_KEY"]);
	assert.deepEqual(providerKeyVars("openai", HOST), ["OPENAI_API_KEY"]);
	// OAuth outranks API key -- the array order is the precedence.
	assert.deepEqual(
		providerKeyVars("anthropic", { ...HOST, ANTHROPIC_OAUTH_TOKEN: "oauth" }),
		["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	);
});

test("an unconfigured provider yields undefined (=> refuse before spend)", { skip }, () => {
	assert.equal(providerKeyVars("google", HOST), undefined);
});

test("the container env is a CLOSED set: only the provider key, never the whole host", { skip }, () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "claude-x",
		maxTurns: 20,
		jobId: "abc",
		githubToken: "ghs_scoped",
		hostEnv: HOST,
	});
	assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-real");
	assert.equal(env.GITHUB_TOKEN, "ghs_scoped");
	assert.equal(env.PI_PROVIDER, "anthropic");
	// The stray host secrets are NOT forwarded.
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(env.HOME, undefined);
	assert.equal(env.OPENAI_API_KEY, undefined); // wrong provider's key not forwarded either
});

test("a local-folder job (no token) gets NO GITHUB_TOKEN or GH_TOKEN var at all -- not an empty one", { skip }, () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		jobId: "j",
		githubToken: undefined,
		hostEnv: HOST,
	});
	assert.ok(!("GITHUB_TOKEN" in env), "absent token must mean absent variable");
	assert.ok(!("GH_TOKEN" in env), "the mirror var is absent too, never an empty one");
});

test("the minted token is mirrored into BOTH GITHUB_TOKEN and GH_TOKEN (gh prefers GH_TOKEN)", { skip }, () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		jobId: "j",
		githubToken: "ghs_scoped",
		hostEnv: HOST,
	});
	assert.equal(env.GITHUB_TOKEN, "ghs_scoped");
	assert.equal(env.GH_TOKEN, "ghs_scoped", "gh reads GH_TOKEN first -- both must carry the same mint");
});

test("a forwarded GH_TOKEN can never override the mint -- the token assignment sits after the forward loop", { skip }, () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		jobId: "j",
		githubToken: "minted-token",
		hostEnv: { ...HOST, GH_TOKEN: "operator-token" },
		forwardEnv: ["GH_TOKEN"],
	});
	assert.equal(env.GH_TOKEN, "minted-token", "the operator token must not beat the per-job mint");
	assert.equal(env.GITHUB_TOKEN, "minted-token");
});

test("PI_MAX_TOKENS is forwarded only when the per-job budget is set", { skip }, () => {
	const withCap = buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 5, maxTokens: 500000, jobId: "j", hostEnv: HOST });
	assert.equal(withCap.PI_MAX_TOKENS, "500000", "a set cap is forwarded as a string, like PI_MAX_TURNS");

	// null/absent => undefined, which docker-run.mjs skips -> the runner attaches a pure meter, no cap.
	const noCap = buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 5, maxTokens: null, jobId: "j", hostEnv: HOST });
	assert.equal(noCap.PI_MAX_TOKENS, undefined, "an unset cap is omitted, never an empty string");
});

test("an unconfigured provider throws a config-tagged error (=> pre-spend refusal)", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ provider: "google", model: "m", maxTurns: 5, jobId: "j", hostEnv: HOST }),
		(e) => e.piDispatchConfig === true,
	);
});

test("PI_GLOBAL_ALLOW_EXTENSIONS is forwarded only when armed (fail-closed)", { skip }, () => {
	const base = { provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", hostEnv: HOST };
	assert.equal(buildContainerEnv({ ...base, allowGlobalExtensions: true }).PI_GLOBAL_ALLOW_EXTENSIONS, "1");
	assert.equal(buildContainerEnv(base).PI_GLOBAL_ALLOW_EXTENSIONS, undefined, "unset by default -> overlay extensions stay dormant");
});

test("PI_FORWARD_ENV forwards ONLY the named vars that are present, never a pass-through", { skip }, () => {
	const host = { ...HOST, MY_PROVIDER_KEY: "sk-custom", UNLISTED: "nope" };
	const env = buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", hostEnv: host, forwardEnv: ["MY_PROVIDER_KEY", "ABSENT_VAR"] });
	assert.equal(env.MY_PROVIDER_KEY, "sk-custom", "a listed, present var is forwarded (a custom provider's key)");
	assert.equal(env.ABSENT_VAR, undefined, "a listed but unset var is skipped, never forwarded as empty");
	assert.equal(env.UNLISTED, undefined, "an unlisted host var is never forwarded");
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, "the stray host secret still does not ride along");
});

// --- PI_AUTH_FROM_PI: source the provider key from pi's auth.json when the env has none ---
const authBase = { provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", agentDir: "/home/u/.pi/agent" };
const authReader = (json) => (p) => {
	assert.match(p, /auth\.json$/, "reads auth.json under the agent dir");
	if (json === null) throw new Error("ENOENT");
	return typeof json === "string" ? json : JSON.stringify(json);
};

test("PI_AUTH_FROM_PI injects the api key from auth.json under pi's expected var name", { skip }, () => {
	const env = buildContainerEnv({
		...authBase,
		hostEnv: { HOME: "/root" }, // no ANTHROPIC_API_KEY on the host
		authFromPi: true,
		readFile: authReader({ anthropic: { type: "api_key", key: "sk-from-pi" } }),
	});
	assert.equal(env.ANTHROPIC_API_KEY, "sk-from-pi", "pi's own findEnvKeys resolves the var name -- no hand table");
});

test("PI_AUTH_FROM_PI: the env wins when the key is present (fallback only, auth.json never read)", { skip }, () => {
	const env = buildContainerEnv({
		...authBase,
		hostEnv: { ANTHROPIC_API_KEY: "sk-env" },
		authFromPi: true,
		readFile: () => assert.fail("auth.json must not be read when the env already has the key"),
	});
	assert.equal(env.ANTHROPIC_API_KEY, "sk-env");
});

test("PI_AUTH_FROM_PI refuses an OAuth/subscription login (pre-spend)", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ ...authBase, hostEnv: {}, authFromPi: true, readFile: authReader({ anthropic: { type: "oauth", access_token: "x" } }) }),
		(e) => e.piDispatchConfig === true && /OAuth|subscription/i.test(e.message),
	);
});

test("PI_AUTH_FROM_PI refuses when auth.json is missing/unreadable, with guidance", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ ...authBase, hostEnv: {}, authFromPi: true, readFile: authReader(null) }),
		(e) => e.piDispatchConfig === true && /pi login|environment/i.test(e.message),
	);
});

test("without PI_AUTH_FROM_PI, a missing env key still refuses and auth.json is never consulted", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ ...authBase, hostEnv: {}, authFromPi: false, readFile: () => assert.fail("must not read auth.json when PI_AUTH_FROM_PI is off") }),
		(e) => e.piDispatchConfig === true,
	);
});
