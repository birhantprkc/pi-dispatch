import assert from "node:assert/strict";
import { test } from "node:test";
import { configError, loadConfig } from "../src/config.mjs";

test("loads conservative defaults with an empty-ish env", () => {
	const c = loadConfig({});
	assert.equal(c.concurrency, 3);
	assert.equal(c.dailyCap, 25);
	assert.equal(c.provider, "anthropic");
	assert.equal(c.model, "claude-sonnet-4-5-20250929"); // dated, deterministic
	assert.equal(c.maxTurns, 30);
	assert.equal(c.valkeyUrl, "redis://127.0.0.1:6379");
	assert.equal(c.jobImage, "pi-job:latest");
	assert.ok(c.jobsDir.length > 0);
});

test("env overrides every field", () => {
	const c = loadConfig({
		VALKEY_URL: "redis://valkey:6379",
		PI_CONCURRENCY: "6",
		PI_DAILY_CAP: "100",
		PI_PROVIDER: "openai",
		PI_MODEL: "gpt-x",
		PI_MAX_TURNS: "50",
		PI_JOB_IMAGE: "pi-job:0.1.0",
		PI_JOBS_DIR: "/srv/jobs",
	});
	assert.equal(c.concurrency, 6);
	assert.equal(c.dailyCap, 100);
	assert.equal(c.provider, "openai");
	assert.equal(c.model, "gpt-x");
	assert.equal(c.jobsDir, "/srv/jobs");
});

test("a malformed integer is a config error, not a silent NaN", () => {
	for (const bad of ["0", "-1", "3.5", "abc", "3x"]) {
		assert.throws(() => loadConfig({ PI_CONCURRENCY: bad }), (e) => e.piDispatchConfig === true, `PI_CONCURRENCY=${bad}`);
	}
});

test("cap 0 is rejected -- it would fail closed, and is more likely a typo than intent", () => {
	assert.throws(() => loadConfig({ PI_DAILY_CAP: "0" }), (e) => e.piDispatchConfig === true);
});

test("configError is tagged for clean CLI reporting", () => {
	assert.equal(configError("x").piDispatchConfig, true);
});
