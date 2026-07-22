import assert from "node:assert/strict";
import { test } from "node:test";
import { loadReceiverConfig } from "../src/config.mjs";

// A valid flows file, injected: exists and parses to a well-formed flow -> {any, all, none} rule map.
const validFlows = {
	fileExists: () => true,
	readFile: () => '{"frontend-fix":{"any":["pi:frontend"]}}',
};

/** Inject a flows file whose raw JSON is `json`, with WEBHOOK_SECRET present. */
function withFlows(json) {
	return () => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
}

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
	assert.deepEqual(c.labelFlows["frontend-fix"], { any: ["pi:frontend"] });
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

test("a none-only rule is a config error -- no positive selector would widen the trigger surface", () => {
	assert.throws(withFlows('{"fix":{"none":["blocked"]}}'), (e) => e.piDispatchConfig === true);
});

test("an empty rule {} is a config error (no positive selector)", () => {
	assert.throws(withFlows('{"fix":{}}'), (e) => e.piDispatchConfig === true);
});

test('a string selector (any:"foo") is rejected as non-array BEFORE the positive-selector count', () => {
	// The ordering guard: .length is truthy on a string, so a count-first check would accept this and let
	// the pure matchesRule throw on "foo".some(...). Array-ness is checked first, so this is a load error.
	assert.throws(withFlows('{"fix":{"any":"foo"}}'), (e) => e.piDispatchConfig === true);
});

test("a non-array selector (all:{}) is a config error", () => {
	assert.throws(withFlows('{"fix":{"all":{}}}'), (e) => e.piDispatchConfig === true);
});

test("an empty-string selector member is a config error", () => {
	assert.throws(withFlows('{"fix":{"any":["",""]}}'), (e) => e.piDispatchConfig === true);
});

test("a rule value that is not an object is a config error", () => {
	assert.throws(withFlows('{"fix":5}'), (e) => e.piDispatchConfig === true);
});

test("an integer-like flow key is a config error -- V8 reorders integer keys, breaking file order", () => {
	assert.throws(withFlows('{"1":{"any":["pi:x"]}}'), (e) => e.piDispatchConfig === true);
});

test("an all-only rule is accepted (all carries the requirement)", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => '{"fix":{"all":["a","b"]}}' });
	assert.deepEqual(c.labelFlows["fix"], { all: ["a", "b"] });
});

test("an explicit empty `any` alongside a non-empty `all` is accepted", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => '{"fix":{"any":[],"all":["a"]}}' });
	assert.deepEqual(c.labelFlows["fix"], { any: [], all: ["a"] });
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
