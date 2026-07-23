import assert from "node:assert/strict";
import { test } from "node:test";
import { loadReceiverConfig } from "../src/config.mjs";

// A valid unified triggers file, injected: exists and parses to one of each webhook type. The exhaustive
// schema validation lives in the shared validator's own suite (worker/test/triggers.test.mjs); here we
// assert the receiver surfaces those errors fail-loud and groups the webhook triggers for the filter.
const TRIGGERS_JSON = JSON.stringify({
	triggers: [
		{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix" } },
		{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage" } },
		{ on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review" } },
	],
});
const validTriggers = { fileExists: () => true, readFile: () => TRIGGERS_JSON };

/** Inject a triggers file whose raw JSON is `json`, with WEBHOOK_SECRET present. */
function withTriggers(json) {
	return () => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
}

test("missing WEBHOOK_SECRET is a config error -- never boot unable to verify signatures", () => {
	assert.throws(() => loadReceiverConfig({}, validTriggers), (e) => e.piDispatchConfig === true);
});

test("empty/whitespace WEBHOOK_SECRET is a config error", () => {
	assert.throws(() => loadReceiverConfig({ WEBHOOK_SECRET: "" }, validTriggers), (e) => e.piDispatchConfig === true);
	assert.throws(() => loadReceiverConfig({ WEBHOOK_SECRET: "   " }, validTriggers), (e) => e.piDispatchConfig === true);
});

test("a valid secret + triggers file yields conservative defaults and grouped webhook triggers", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
	assert.equal(c.webhookSecret, "shh");
	assert.equal(c.bind, "0.0.0.0");
	assert.equal(c.port, 3000);

	// label rules, in file order.
	assert.equal(c.triggers.label.length, 1);
	assert.equal(c.triggers.label[0].flow, "frontend-fix");
	assert.deepEqual(c.triggers.label[0].predicate.any, ["pi:frontend"]);

	// the single comment trigger.
	assert.deepEqual(c.triggers.comment, { phrase: "@pi", defaultFlow: "triage" });

	// pull_request rules: actions is a Set, predicate carries the label selectors.
	assert.equal(c.triggers.pullRequest.length, 1);
	assert.equal(c.triggers.pullRequest[0].flow, "review");
	assert.ok(c.triggers.pullRequest[0].actions.has("labeled"));
	assert.deepEqual(c.triggers.pullRequest[0].predicate.any, ["pi:review"]);

	// knownFlows spans every webhook flow (the comment `<phrase> <flow>` override allowlist).
	assert.deepEqual([...c.triggers.knownFlows].sort(), ["frontend-fix", "review", "triage"]);
});

test("no comment trigger in the file -> c.triggers.comment is null (comment path disabled)", () => {
	const json = JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix" } }] });
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.comment, null);
});

test("cron triggers in the shared file are validated but ignored by the receiver's groups", () => {
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/p", flow: "tidy", task: "t" } },
			{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.label.length, 1);
	assert.equal(c.triggers.pullRequest.length, 0);
	assert.equal(c.triggers.comment, null);
});

test("RECEIVER_PORT and RECEIVER_BIND overrides are honored", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh", RECEIVER_PORT: "8080", RECEIVER_BIND: "127.0.0.1" }, validTriggers);
	assert.equal(c.port, 8080);
	assert.equal(c.bind, "127.0.0.1");
});

test("valkeyUrl defaults to the local Valkey, mirroring the worker default", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
	assert.equal(c.valkeyUrl, "redis://127.0.0.1:6379");
});

test("VALKEY_URL override is honored", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh", VALKEY_URL: "redis://valkey:6380/2" }, validTriggers);
	assert.equal(c.valkeyUrl, "redis://valkey:6380/2");
});

test("a malformed RECEIVER_PORT is a config error, not a silent NaN", () => {
	assert.throws(() => loadReceiverConfig({ WEBHOOK_SECRET: "shh", RECEIVER_PORT: "nope" }, validTriggers), (e) => e.piDispatchConfig === true);
});

// -- the receiver surfaces the shared validator's errors fail-loud -------------------------------

test("a missing triggers file is a config error -- no silent empty allowlist", () => {
	assert.throws(
		() => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => false, readFile: () => "" }),
		(e) => e.piDispatchConfig === true,
	);
});

test("malformed triggers JSON is a config error", () => {
	assert.throws(withTriggers("{not json"), (e) => e.piDispatchConfig === true);
});

test("a none-only label rule is a config error -- no positive selector would widen the trigger surface", () => {
	assert.throws(withTriggers(JSON.stringify({ triggers: [{ on: { type: "label", none: ["blocked"] }, run: { kind: "github", flow: "fix" } }] })), (e) => e.piDispatchConfig === true);
});

test("the on x run diagonal is enforced at load: a cron -> github trigger is a config error", () => {
	assert.throws(withTriggers(JSON.stringify({ triggers: [{ on: { type: "cron", id: "x", pattern: "0 3 * * *" }, run: { kind: "github", flow: "fix" } }] })), (e) => e.piDispatchConfig === true);
});

test("a triggers file that is not a {triggers:[...]} object is a config error", () => {
	assert.throws(withTriggers(JSON.stringify(["frontend-fix"])), (e) => e.piDispatchConfig === true);
	assert.throws(withTriggers(JSON.stringify({ nope: [] })), (e) => e.piDispatchConfig === true);
});

// -- github auth block (unchanged, single-sourced from the worker loader) ------------------------

test("github block is produced by the shared worker loader -- default gh source, exact block shape", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
	assert.deepEqual(c.github, {
		source: "gh",
		patVar: "GITHUB_PAT",
		appId: undefined,
		installationId: undefined,
		privateKeyPath: undefined,
	});
});

test("github block reflects env just as the worker loader does (source=pat echoes patVar)", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_x" }, validTriggers);
	assert.equal(c.github.source, "pat");
	assert.equal(c.github.patVar, "GITHUB_PAT");
});
