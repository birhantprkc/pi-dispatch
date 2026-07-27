import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriggers } from "../src/triggers.mjs";

// parseTriggers is pure over the file TEXT -- no fs, no bullmq. `parse` serializes triggers and feeds
// them through with a stable path for the "names the path" assertions.
const PATH = "/triggers.json";
const parse = (triggers) => parseTriggers(JSON.stringify({ triggers }), PATH);
const isConfigError = (e) => e.piDispatchConfig === true;

const CRON = { on: { type: "cron", id: "nightly-tidy", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/proj", flow: "tidy", task: "run the tidy pass" } };
const LABEL = { on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix" } };
const COMMENT = { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } };
const PR_LABELED = { on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review" } };
const PR_AUTO = { on: { type: "pull_request", action: ["opened", "synchronize"] }, run: { kind: "github", flow: "review" } };

test("invalid JSON is a config error naming the path", () => {
	assert.throws(() => parseTriggers("{ not json", PATH), (e) => isConfigError(e) && e.message.includes(PATH));
});

test('missing "triggers" array is a config error naming the path', () => {
	assert.throws(() => parseTriggers(JSON.stringify({ nope: [] }), PATH), (e) => isConfigError(e) && e.message.includes(PATH));
});

test("empty triggers array is valid -> []", () => {
	assert.deepEqual(parse([]), []);
});

// --- diagonal: on x run trust boundary ---

test('cron -> github is rejected (a cron has no webhook payload)', () => {
	assert.throws(() => parse([{ ...CRON, run: { ...CRON.run, kind: "github" } }]), (e) => isConfigError(e) && /local/.test(e.message));
});

test("label -> local is rejected (a webhook trigger produces a github job)", () => {
	assert.throws(() => parse([{ ...LABEL, run: { kind: "local", flow: "x" } }]), (e) => isConfigError(e) && /github/.test(e.message));
});

test("comment -> local and pull_request -> local are rejected", () => {
	assert.throws(() => parse([{ ...COMMENT, run: { kind: "local", flow: "x" } }]), (e) => isConfigError(e) && /github/.test(e.message));
	assert.throws(() => parse([{ ...PR_AUTO, run: { kind: "local", flow: "x" } }]), (e) => isConfigError(e) && /github/.test(e.message));
});

test("unknown on.type and unknown run.kind are config errors", () => {
	assert.throws(() => parse([{ on: { type: "push" }, run: { kind: "github", flow: "x" } }]), isConfigError);
	assert.throws(() => parse([{ ...LABEL, run: { kind: "remote", flow: "x" } }]), isConfigError);
});

test("a non-object entry / on / run is a config error", () => {
	assert.throws(() => parse([7]), isConfigError);
	assert.throws(() => parse([{ on: "x", run: { kind: "github", flow: "y" } }]), isConfigError);
	assert.throws(() => parse([{ on: { type: "label" }, run: "x" }]), isConfigError);
});

// --- cron (ported from schedules.test.mjs) ---

test("a valid cron trigger normalizes; omitted provider/model/maxTurns/github pass through absent", () => {
	const [t] = parse([CRON]);
	assert.deepEqual(t.on, { type: "cron", id: "nightly-tidy", pattern: "0 3 * * *" });
	assert.deepEqual(t.run, { kind: "local", folder: "/proj", flow: "tidy", task: "run the tidy pass", provider: undefined, model: undefined, maxTurns: undefined, github: undefined });
});

test("cron entry-level provider/model/maxTurns pass through verbatim", () => {
	const [t] = parse([{ ...CRON, run: { ...CRON.run, provider: "openai", model: "gpt-x", maxTurns: 5 } }]);
	assert.equal(t.run.provider, "openai");
	assert.equal(t.run.model, "gpt-x");
	assert.equal(t.run.maxTurns, 5);
});

test("a 6-field cron (with seconds) is accepted", () => {
	const [t] = parse([{ ...CRON, on: { ...CRON.on, pattern: "0 0 3 * * *" } }]);
	assert.equal(t.on.pattern, "0 0 3 * * *");
});

test("cron with wrong field count is a config error", () => {
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, pattern: "0 3 * *" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, pattern: "0 3 * * * * *" } }]), isConfigError);
});

test("missing / empty / non-string cron id is a config error", () => {
	assert.throws(() => parse([{ ...CRON, on: { type: "cron", pattern: "0 3 * * *" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, id: "" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, id: 7 } }]), isConfigError);
});

test('cron id containing ":" is a config error (would corrupt repeat:<id>:<millis>)', () => {
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, id: "night:tidy" } }]), (e) => isConfigError(e) && e.message.includes(":"));
});

test("cron id with an out-of-charset character is a config error", () => {
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, id: "night tidy" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, id: "night/tidy" } }]), isConfigError);
});

test("duplicate cron id is a config error", () => {
	assert.throws(() => parse([CRON, { ...CRON, run: { ...CRON.run, folder: "/other" } }]), (e) => isConfigError(e) && /duplicate/.test(e.message));
});

test("cron run.github: true survives normalization (the per-trigger token opt-in)", () => {
	const [t] = parse([{ ...CRON, run: { ...CRON.run, github: true } }]);
	assert.equal(t.run.github, true);
	const [f] = parse([{ ...CRON, run: { ...CRON.run, github: false } }]);
	assert.equal(f.run.github, false);
});

test("cron run.github absent stays absent (undefined) -- the zero-GitHub default", () => {
	const [t] = parse([CRON]);
	assert.equal(t.run.github, undefined);
});

test('cron run.github that is not strictly boolean ("true", 1, null) is a config error naming the trigger', () => {
	assert.throws(() => parse([{ ...CRON, run: { ...CRON.run, github: "true" } }]), (e) => isConfigError(e) && e.message.includes("nightly-tidy"));
	assert.throws(() => parse([{ ...CRON, run: { ...CRON.run, github: 1 } }]), (e) => isConfigError(e) && e.message.includes("nightly-tidy"));
	assert.throws(() => parse([{ ...CRON, run: { ...CRON.run, github: null } }]), (e) => isConfigError(e) && e.message.includes("nightly-tidy"));
});

test("cron missing folder / flow / task is a config error", () => {
	assert.throws(() => parse([{ ...CRON, run: { kind: "local", flow: "tidy", task: "t" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, run: { kind: "local", folder: "/proj", task: "t" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, run: { kind: "local", folder: "/proj", flow: "tidy", task: "   " } }]), isConfigError);
});

// --- label ---

test("a valid label trigger normalizes", () => {
	const [t] = parse([LABEL]);
	assert.deepEqual(t, { on: { type: "label", any: ["pi:frontend"], all: undefined, none: undefined }, run: { kind: "github", flow: "frontend-fix" } });
});

test("label trigger with no positive selector (none-only) is a config error", () => {
	assert.throws(() => parse([{ on: { type: "label", none: ["blocked"] }, run: { kind: "github", flow: "x" } }]), (e) => isConfigError(e) && /positive selector/.test(e.message));
});

test("label selector that is not an array of non-empty strings is a config error", () => {
	assert.throws(() => parse([{ on: { type: "label", any: "pi:frontend" }, run: { kind: "github", flow: "x" } }]), isConfigError);
	assert.throws(() => parse([{ on: { type: "label", any: ["", "ok"] }, run: { kind: "github", flow: "x" } }]), isConfigError);
});

test("label trigger missing run.flow is a config error", () => {
	assert.throws(() => parse([{ on: { type: "label", any: ["x"] }, run: { kind: "github" } }]), isConfigError);
});

// --- comment ---

test("a valid comment trigger normalizes", () => {
	const [t] = parse([COMMENT]);
	assert.deepEqual(t, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } });
});

test("comment trigger missing phrase or flow is a config error", () => {
	assert.throws(() => parse([{ on: { type: "comment" }, run: { kind: "github", flow: "fix" } }]), isConfigError);
	assert.throws(() => parse([{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github" } }]), isConfigError);
});

test("a second comment trigger is a config error (at most one)", () => {
	assert.throws(() => parse([COMMENT, { on: { type: "comment", phrase: "@bot" }, run: { kind: "github", flow: "fix" } }]), (e) => isConfigError(e) && /at most one/.test(e.message));
});

// --- pull_request ---

test("a valid labeled PR trigger normalizes with its predicate", () => {
	const [t] = parse([PR_LABELED]);
	assert.deepEqual(t, { on: { type: "pull_request", action: ["labeled"], any: ["pi:review"], all: undefined, none: undefined }, run: { kind: "github", flow: "review" } });
});

test("a labeled PR trigger with no positive selector is a config error", () => {
	assert.throws(() => parse([{ on: { type: "pull_request", action: ["labeled"] }, run: { kind: "github", flow: "review" } }]), (e) => isConfigError(e) && /positive selector/.test(e.message));
});

test("an auto-only PR trigger (opened/synchronize) needs no predicate", () => {
	const [t] = parse([PR_AUTO]);
	assert.deepEqual(t.on.action, ["opened", "synchronize"]);
	assert.equal(t.run.flow, "review");
});

test("PR trigger with an empty or non-array action is a config error", () => {
	assert.throws(() => parse([{ on: { type: "pull_request", action: [] }, run: { kind: "github", flow: "x" } }]), isConfigError);
	assert.throws(() => parse([{ on: { type: "pull_request", action: "opened" }, run: { kind: "github", flow: "x" } }]), isConfigError);
});

test("PR trigger with an unsupported action is a config error", () => {
	assert.throws(() => parse([{ on: { type: "pull_request", action: ["closed"] }, run: { kind: "github", flow: "x" } }]), (e) => isConfigError(e) && /closed/.test(e.message));
});

test("PR trigger missing run.flow is a config error", () => {
	assert.throws(() => parse([{ on: { type: "pull_request", action: ["opened"] }, run: { kind: "github" } }]), isConfigError);
});

// --- mixed file ---

test("a mixed file of all four types validates and preserves order", () => {
	const result = parse([CRON, LABEL, COMMENT, PR_LABELED, PR_AUTO]);
	assert.equal(result.length, 5);
	assert.deepEqual(result.map((t) => t.on.type), ["cron", "label", "comment", "pull_request", "pull_request"]);
});
