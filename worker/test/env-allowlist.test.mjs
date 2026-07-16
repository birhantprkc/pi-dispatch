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

test("a local-folder job (no token) gets NO GITHUB_TOKEN var at all -- not an empty one", { skip }, () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		jobId: "j",
		githubToken: undefined,
		hostEnv: HOST,
	});
	assert.ok(!("GITHUB_TOKEN" in env), "absent token must mean absent variable");
});

test("an unconfigured provider throws a config-tagged error (=> pre-spend refusal)", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ provider: "google", model: "m", maxTurns: 5, jobId: "j", hostEnv: HOST }),
		(e) => e.piDispatchConfig === true,
	);
});
