import assert from "node:assert/strict";
import { test } from "node:test";
import { loadReceiverConfig, reloadTriggers } from "../src/config.mjs";

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

	// label rules, in file order; each carries its raw-file index (the rule's identity for matched.index).
	assert.equal(c.triggers.label.length, 1);
	assert.equal(c.triggers.label[0].index, 0);
	assert.equal(c.triggers.label[0].flow, "frontend-fix");
	assert.deepEqual(c.triggers.label[0].predicate.any, ["pi:frontend"]);

	// the single comment trigger. `packages` is asserted present-and-undefined: the grouper builds the key
	// by construction and this whole-object deepEqual (assert/strict) counts an own undefined-valued key.
	assert.deepEqual(c.triggers.comment, { index: 1, phrase: "@pi", defaultFlow: "triage", packages: undefined, image: undefined });

	// pull_request rules: actions is a Set, predicate carries the label selectors.
	assert.equal(c.triggers.pullRequest.length, 1);
	assert.equal(c.triggers.pullRequest[0].index, 2);
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

test("rule indices are RAW file positions -- a leading cron entry still occupies index 0", () => {
	// The index is the entry's identity IN THE FILE, so a skipped cron rule must shift the webhook
	// rules' indices, never compact them: matched.index must point back at the exact triggers.json entry.
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/p", flow: "tidy", task: "t" } },
			{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix" } },
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage" } },
			{ on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.label[0].index, 1);
	assert.equal(c.triggers.comment.index, 2);
	assert.equal(c.triggers.pullRequest[0].index, 3);
});

// -- the per-trigger pi-packages opt-in (INT-TRIGGERS-FILE-CONTRACT, REQ-GLOBAL-PI-OVERLAY) -------

test("each grouped webhook rule carries its own run.packages flag through to the filter", () => {
	// Deliberately MIXED: the flag rides on the RULE, so a file where rules disagree must group them
	// disagreeing -- the filter resolves it from whichever rule matched, never from a file-wide default.
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix", packages: true } },
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage", packages: true } },
			{ on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review", packages: false } },
			{ on: { type: "label", any: ["pi:docs"] }, run: { kind: "github", flow: "docs" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.label[0].packages, true);
	assert.equal(c.triggers.comment.packages, true);
	assert.equal(c.triggers.pullRequest[0].packages, false, "an explicit opt-out is grouped as false, never dropped");
	assert.equal(c.triggers.label[1].packages, undefined, "an unflagged rule in the same file stays unflagged");
});

test("each grouped webhook rule carries its own run.image through to the filter", () => {
	// Deliberately MIXED. `image` rides on the RULE for a sharper reason than packages: two rules in one file
	// may name DIFFERENT images, and grouping a file-wide value would run the wrong toolchain for whichever
	// rule lost.
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix", image: "node-playwright:1.4.0" } },
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage", image: "my-python:1.2.0" } },
			{ on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review", image: "reviewer:2.0" } },
			{ on: { type: "label", any: ["pi:docs"] }, run: { kind: "github", flow: "docs" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.label[0].image, "node-playwright:1.4.0");
	assert.equal(c.triggers.comment.image, "my-python:1.2.0");
	assert.equal(c.triggers.pullRequest[0].image, "reviewer:2.0");
	assert.equal(c.triggers.label[1].image, undefined, "an unflagged rule in the same file runs the deployment default");
});

test("an unflagged triggers file groups packages as undefined on every rule -- the no-third-party-code default", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
	assert.equal(c.triggers.label[0].packages, undefined);
	assert.equal(c.triggers.comment.packages, undefined);
	assert.equal(c.triggers.pullRequest[0].packages, undefined);
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

// -- live reload (the testable core of the receiver's trigger watcher) ---------------------------

test("reloadTriggers swaps cfg.triggers in place from the new file (live, no restart)", () => {
	const cfg = { triggers: { label: [{ predicate: { any: ["old"] }, flow: "old-flow" }], comment: null, pullRequest: [], knownFlows: new Set(["old-flow"]) } };
	const json = JSON.stringify({ triggers: [{ on: { type: "label", any: ["new"] }, run: { kind: "github", flow: "new-flow" } }] });
	const res = reloadTriggers({}, cfg, { fileExists: () => true, readFile: () => json });
	assert.deepEqual(res, { ok: true });
	assert.equal(cfg.triggers.label[0].flow, "new-flow");
	assert.deepEqual(cfg.triggers.label[0].predicate.any, ["new"]);
});

test("reloadTriggers keeps the running triggers when the new file is invalid (never crash a live receiver)", () => {
	const original = { label: [{ predicate: { any: ["old"] }, flow: "keep" }], comment: null, pullRequest: [], knownFlows: new Set() };
	const cfg = { triggers: original };
	const res = reloadTriggers({}, cfg, { fileExists: () => true, readFile: () => "{ not json" });
	assert.ok(res.invalid, "an invalid reload reports the reason");
	assert.equal(cfg.triggers, original, "cfg.triggers is left untouched on an invalid reload");
});

test("reloadTriggers keeps the running triggers when the file goes missing", () => {
	const original = { label: [], comment: null, pullRequest: [], knownFlows: new Set() };
	const cfg = { triggers: original };
	const res = reloadTriggers({}, cfg, { fileExists: () => false, readFile: () => "" });
	assert.ok(res.invalid);
	assert.equal(cfg.triggers, original);
});
