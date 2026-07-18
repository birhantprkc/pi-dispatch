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
	assert.equal(c.schedulesFile, null);
	assert.equal(c.schedulerStallMax, 2);
	assert.ok(c.logsDir.endsWith("/pi-dispatch/logs"), c.logsDir);
	assert.equal(c.captureJobLogs, false);
	assert.equal(c.logRetentionDays, 30);
});

test("run-history env overrides logsDir, captureJobLogs, and logRetentionDays", () => {
	const c = loadConfig({ PI_LOGS_DIR: "/x", PI_CAPTURE_JOB_LOGS: "1", PI_LOG_RETENTION_DAYS: "7" });
	assert.equal(c.logsDir, "/x");
	assert.equal(c.captureJobLogs, true);
	assert.equal(c.logRetentionDays, 7);
});

test("logsDir uses || so an empty PI_LOGS_DIR falls back to the default", () => {
	const c = loadConfig({ PI_LOGS_DIR: "" });
	assert.ok(c.logsDir.endsWith("/pi-dispatch/logs"), c.logsDir);
});

test("captureJobLogs is strict: only \"1\" enables it, everything else stays off", () => {
	for (const off of ["0", "true", "yes", "", undefined]) {
		const c = loadConfig(off === undefined ? {} : { PI_CAPTURE_JOB_LOGS: off });
		assert.equal(c.captureJobLogs, false, `PI_CAPTURE_JOB_LOGS=${JSON.stringify(off)}`);
	}
});

test("logRetentionDays accepts 0 (keep forever)", () => {
	const c = loadConfig({ PI_LOG_RETENTION_DAYS: "0" });
	assert.equal(c.logRetentionDays, 0);
});

test("logRetentionDays rejects negative and non-integer values as config errors", () => {
	for (const bad of ["-1", "abc", "1.5"]) {
		assert.throws(
			() => loadConfig({ PI_LOG_RETENTION_DAYS: bad }),
			(e) => e.piDispatchConfig === true,
			`PI_LOG_RETENTION_DAYS=${bad}`,
		);
	}
});

test("positiveInt is unchanged: a spend var of 0 still throws", () => {
	assert.throws(() => loadConfig({ PI_DAILY_CAP: "0" }), (e) => e.piDispatchConfig === true);
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

test("scheduler stall max 0 is rejected -- a 0 threshold would fail closed", () => {
	assert.throws(() => loadConfig({ PI_SCHEDULER_STALL_MAX: "0" }), (e) => e.piDispatchConfig === true);
});

test("scheduler stall max non-integer is a config error, not a silent NaN", () => {
	assert.throws(() => loadConfig({ PI_SCHEDULER_STALL_MAX: "abc" }), (e) => e.piDispatchConfig === true);
});

test("schedules file is honored verbatim -- no default path, null means cron disabled", () => {
	const c = loadConfig({ PI_SCHEDULES_FILE: "/abs/x.json" });
	assert.equal(c.schedulesFile, "/abs/x.json");
});

test("configError is tagged for clean CLI reporting", () => {
	assert.equal(configError("x").piDispatchConfig, true);
});

test("github auth defaults to gh source with no extra required vars", () => {
	const c = loadConfig({});
	assert.equal(c.github.source, "gh");
	assert.equal(c.github.patVar, "GITHUB_PAT");
});

test("source=pat with empty or absent PAT is a config error", () => {
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "pat" }),
		(e) => e.piDispatchConfig === true,
	);
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "   " }),
		(e) => e.piDispatchConfig === true,
	);
});

test("source=pat with a non-empty PAT parses and echoes patVar", () => {
	const c = loadConfig({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_x" });
	assert.equal(c.github.source, "pat");
	assert.equal(c.github.patVar, "GITHUB_PAT");
});

test("unknown GITHUB_AUTH_SOURCE is a config error", () => {
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "oauth" }),
		(e) => e.piDispatchConfig === true,
	);
});

test("source=app missing installationId or privateKeyPath is a config error", () => {
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" }),
		(e) => e.piDispatchConfig === true,
	);
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2" }),
		(e) => e.piDispatchConfig === true,
	);
});

test("source=app with all vars present but a missing key file is a config error", () => {
	assert.throws(
		() =>
			loadConfig(
				{
					GITHUB_AUTH_SOURCE: "app",
					GITHUB_APP_ID: "1",
					GITHUB_APP_INSTALLATION_ID: "2",
					GITHUB_APP_PRIVATE_KEY_PATH: "/nope.pem",
				},
				{ fileExists: () => false },
			),
		(e) => e.piDispatchConfig === true,
	);
});

test("source=app with all vars present and key file present parses the exact block shape", () => {
	const c = loadConfig(
		{
			GITHUB_AUTH_SOURCE: "app",
			GITHUB_APP_ID: "1",
			GITHUB_APP_INSTALLATION_ID: "2",
			GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem",
		},
		{ fileExists: () => true },
	);
	assert.deepEqual(c.github, {
		source: "app",
		patVar: "GITHUB_PAT",
		appId: "1",
		installationId: "2",
		privateKeyPath: "/k.pem",
	});
});

test("custom GITHUB_PAT_VAR reads the named env var for the PAT", () => {
	const c = loadConfig({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT_VAR: "MY_PAT", MY_PAT: "ghp_y" });
	assert.equal(c.github.patVar, "MY_PAT");
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT_VAR: "MY_PAT" }),
		(e) => e.piDispatchConfig === true,
	);
});
