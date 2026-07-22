import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunnerEnv } from "../src/config.mjs";
import { EXIT_POLICY } from "../src/outcome.mjs";

const base = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-x", PI_MAX_TURNS: "20" };

test("parses a valid environment", () => {
	const cfg = parseRunnerEnv(base);
	assert.equal(cfg.provider, "anthropic");
	assert.equal(cfg.model, "claude-x");
	assert.equal(cfg.maxTurns, 20);
	assert.equal(cfg.maxTokens, null); // optional, unset -> cap disabled
	assert.equal(cfg.retry.maxRetries, 2); // default
	assert.equal(cfg.retry.baseDelayMs, 2000); // default
});

test("PI_MAX_TOKENS is optional: unset is null, a valid value parses", () => {
	assert.equal(parseRunnerEnv({ ...base }).maxTokens, null);
	assert.equal(parseRunnerEnv({ ...base, PI_MAX_TOKENS: "" }).maxTokens, null);
	assert.equal(parseRunnerEnv({ ...base, PI_MAX_TOKENS: "500000" }).maxTokens, 500000);
});

test("a malformed PI_MAX_TOKENS is a config error, not a silently-ignored cap", () => {
	for (const bad of ["0", "-1", "1.5", "abc", "12x", " "]) {
		try {
			parseRunnerEnv({ ...base, PI_MAX_TOKENS: bad });
			assert.fail(`expected throw for PI_MAX_TOKENS=${JSON.stringify(bad)}`);
		} catch (error) {
			assert.equal(error.piDispatchExit, EXIT_POLICY, `PI_MAX_TOKENS=${JSON.stringify(bad)}`);
		}
	}
});

// Every deterministic misconfiguration must be a TAGGED config error (exit 2), so the queue
// does not retry a worker-template typo forever. These threw plain Errors before -- routed
// through a regex tuned for pi's vocabulary that did not match them -- landing on exit 1.
test("missing required vars are config errors (exit 2)", () => {
	for (const missing of ["PI_PROVIDER", "PI_MODEL", "PI_MAX_TURNS"]) {
		const env = { ...base };
		delete env[missing];
		try {
			parseRunnerEnv(env);
			assert.fail(`expected throw for missing ${missing}`);
		} catch (error) {
			assert.equal(error.piDispatchExit, EXIT_POLICY, `${missing} must be exit 2`);
		}
	}
});

test("a malformed PI_MAX_TURNS is a config error, not a retryable NaN", () => {
	for (const bad of ["0", "-1", "1.5", "abc", "", "12x", " "]) {
		try {
			parseRunnerEnv({ ...base, PI_MAX_TURNS: bad });
			assert.fail(`expected throw for PI_MAX_TURNS=${JSON.stringify(bad)}`);
		} catch (error) {
			assert.equal(error.piDispatchExit, EXIT_POLICY, `PI_MAX_TURNS=${JSON.stringify(bad)}`);
		}
	}
});

test("optional retry knobs override their defaults and are validated too", () => {
	const cfg = parseRunnerEnv({ ...base, PI_RETRY_MAX: "5", PI_RETRY_BASE_MS: "500" });
	assert.equal(cfg.retry.maxRetries, 5);
	assert.equal(cfg.retry.baseDelayMs, 500);
	assert.throws(() => parseRunnerEnv({ ...base, PI_RETRY_MAX: "0" }), (e) => e.piDispatchExit === EXIT_POLICY);
});
