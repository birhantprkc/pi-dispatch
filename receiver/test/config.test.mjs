import assert from "node:assert/strict";
import { test } from "node:test";
import { loadReceiverConfig } from "../src/config.mjs";

// A valid flows file, injected: exists and parses to a well-formed label -> flow map.
const validFlows = {
	fileExists: () => true,
	readFile: () => '{"pi:frontend":"frontend-fix"}',
};

test("missing WEBHOOK_SECRET is a config error -- never boot unable to verify signatures", () => {
	assert.throws(() => loadReceiverConfig({}, validFlows), (e) => e.piDispatchConfig === true);
});

test("empty/whitespace WEBHOOK_SECRET is a config error", () => {
	assert.throws(() => loadReceiverConfig({ WEBHOOK_SECRET: "" }, validFlows), (e) => e.piDispatchConfig === true);
	assert.throws(() => loadReceiverConfig({ WEBHOOK_SECRET: "   " }, validFlows), (e) => e.piDispatchConfig === true);
});

test("a valid secret + injected flows yields conservative defaults and the parsed allowlist", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validFlows);
	assert.equal(c.webhookSecret, "shh");
	assert.equal(c.bind, "0.0.0.0");
	assert.equal(c.port, 3000);
	assert.equal(c.labelFlows["pi:frontend"], "frontend-fix");
});

test("RECEIVER_PORT and RECEIVER_BIND overrides are honored", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh", RECEIVER_PORT: "8080", RECEIVER_BIND: "127.0.0.1" }, validFlows);
	assert.equal(c.port, 8080);
	assert.equal(c.bind, "127.0.0.1");
});

test("valkeyUrl defaults to the local Valkey, mirroring the worker default", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validFlows);
	assert.equal(c.valkeyUrl, "redis://127.0.0.1:6379");
});

test("VALKEY_URL override is honored", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh", VALKEY_URL: "redis://valkey:6380/2" }, validFlows);
	assert.equal(c.valkeyUrl, "redis://valkey:6380/2");
});

test("a malformed RECEIVER_PORT is a config error, not a silent NaN", () => {
	assert.throws(
		() => loadReceiverConfig({ WEBHOOK_SECRET: "shh", RECEIVER_PORT: "nope" }, validFlows),
		(e) => e.piDispatchConfig === true,
	);
});

test("a missing flows file is a config error -- no silent empty allowlist", () => {
	assert.throws(
		() => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => false, readFile: () => "" }),
		(e) => e.piDispatchConfig === true,
	);
});

test("malformed flows JSON is a config error", () => {
	assert.throws(
		() => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => "{not json" }),
		(e) => e.piDispatchConfig === true,
	);
});

test("a non-string flow value is a config error", () => {
	assert.throws(
		() => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => '{"pi:x": 5}' }),
		(e) => e.piDispatchConfig === true,
	);
});

test("a non-object flows file (JSON array) is a config error", () => {
	assert.throws(
		() => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => '["frontend-fix"]' }),
		(e) => e.piDispatchConfig === true,
	);
});

test("commentTrigger defaults to the @pi phrase with no default flow", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validFlows);
	assert.equal(c.commentTrigger.phrase, "@pi");
	assert.equal(c.commentTrigger.defaultFlow, null);
});

test("commentTrigger honors env overrides", () => {
	const c = loadReceiverConfig(
		{ WEBHOOK_SECRET: "shh", COMMENT_TRIGGER_PHRASE: "@bot", COMMENT_DEFAULT_FLOW: "backend-fix" },
		validFlows,
	);
	assert.equal(c.commentTrigger.phrase, "@bot");
	assert.equal(c.commentTrigger.defaultFlow, "backend-fix");
});

test("github block is produced by the shared worker loader -- default gh source, exact block shape", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validFlows);
	assert.deepEqual(c.github, {
		source: "gh",
		patVar: "GITHUB_PAT",
		appId: undefined,
		installationId: undefined,
		privateKeyPath: undefined,
	});
});

test("github block reflects env just as the worker loader does (source=pat echoes patVar)", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_x" }, validFlows);
	assert.equal(c.github.source, "pat");
	assert.equal(c.github.patVar, "GITHUB_PAT");
});
