import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSchedules } from "../src/schedules.mjs";

// loadSchedules is pure over injected fs -- no real filesystem, no bullmq. A stub config supplies the
// defaults that entry-level provider/model/maxTurns fall back to.
const CONFIG = {
	schedulesFile: "/schedules.json",
	provider: "anthropic",
	model: "claude-sonnet-4-5-20250929",
	maxTurns: 30,
};

const VALID = { id: "nightly-tidy", kind: "local", cron: "0 3 * * *", folder: "/proj", flow: "tidy", task: "run the tidy pass" };

// Serialize `schedules` and feed it through injected fakes. existsSync defaults to true for both the
// schedules file and every folder; override it to fail a specific path.
function load(schedules, { existsSync = () => true, config = CONFIG } = {}) {
	return loadSchedules(config, {
		readFileSync: () => JSON.stringify({ schedules }),
		existsSync,
	});
}

const isConfigError = (e) => e.piDispatchConfig === true;

test("null schedulesFile -> [] (cron disabled)", () => {
	assert.deepEqual(loadSchedules({ ...CONFIG, schedulesFile: null }, { readFileSync: () => "", existsSync: () => true }), []);
});

test("absent schedulesFile -> [] (cron disabled)", () => {
	const { schedulesFile, ...rest } = CONFIG;
	assert.deepEqual(loadSchedules(rest, { readFileSync: () => "", existsSync: () => true }), []);
});

test("set-but-missing schedules file is a config error naming the path", () => {
	assert.throws(
		() => loadSchedules(CONFIG, { readFileSync: () => "", existsSync: () => false }),
		(e) => isConfigError(e) && e.message.includes("/schedules.json"),
	);
});

test("malformed JSON is a config error naming the file", () => {
	assert.throws(
		() => loadSchedules(CONFIG, { readFileSync: () => "{ not json", existsSync: () => true }),
		(e) => isConfigError(e) && e.message.includes("/schedules.json"),
	);
});

test('missing "schedules" array is a config error', () => {
	assert.throws(
		() => loadSchedules(CONFIG, { readFileSync: () => JSON.stringify({ nope: [] }), existsSync: () => true }),
		isConfigError,
	);
});

test('kind:"github" is rejected -- a schedule has no webhook/issue payload', () => {
	assert.throws(() => load([{ ...VALID, kind: "github" }]), (e) => isConfigError(e) && /github/.test(e.message));
});

test("any non-local kind is rejected", () => {
	assert.throws(() => load([{ ...VALID, kind: "remote" }]), isConfigError);
});

test("duplicate id is a config error", () => {
	assert.throws(() => load([VALID, { ...VALID, folder: "/other" }]), (e) => isConfigError(e) && /duplicate/.test(e.message));
});

test('id containing ":" is a config error (would corrupt repeat:<id>:<millis>)', () => {
	assert.throws(() => load([{ ...VALID, id: "night:tidy" }]), (e) => isConfigError(e) && e.message.includes(":"));
});

test("id with an out-of-charset character is a config error", () => {
	assert.throws(() => load([{ ...VALID, id: "night tidy" }]), isConfigError); // space is not allowed
	assert.throws(() => load([{ ...VALID, id: "night/tidy" }]), isConfigError);
});

test("empty or non-string id is a config error", () => {
	assert.throws(() => load([{ ...VALID, id: "" }]), isConfigError);
	assert.throws(() => load([{ ...VALID, id: 7 }]), isConfigError);
});

test("cron with the wrong field count is a config error", () => {
	assert.throws(() => load([{ ...VALID, cron: "0 3 * *" }]), isConfigError); // 4 fields
	assert.throws(() => load([{ ...VALID, cron: "0 3 * * * * *" }]), isConfigError); // 7 fields
});

test("empty or non-string cron is a config error", () => {
	assert.throws(() => load([{ ...VALID, cron: "" }]), isConfigError);
	assert.throws(() => load([{ ...VALID, cron: 5 }]), isConfigError);
});

test("missing folder is a config error", () => {
	const { folder, ...noFolder } = VALID;
	assert.throws(() => load([noFolder]), isConfigError);
});

test("nonexistent folder (existsSync -> false) is a config error", () => {
	// The schedules file exists; only the folder is missing.
	assert.throws(() => load([VALID], { existsSync: (p) => p === "/schedules.json" }), (e) => isConfigError(e) && e.message.includes("/proj"));
});

test("missing or empty flow is a config error", () => {
	const { flow, ...noFlow } = VALID;
	assert.throws(() => load([noFlow]), isConfigError);
	assert.throws(() => load([{ ...VALID, flow: "" }]), isConfigError);
});

test("missing or empty task is a config error", () => {
	const { task, ...noTask } = VALID;
	assert.throws(() => load([noTask]), isConfigError);
	assert.throws(() => load([{ ...VALID, task: "   " }]), isConfigError);
});

test("a valid local entry normalizes to the scheduler shape; omitted provider/model/maxTurns pass through absent (resolved at job start)", () => {
	const result = load([VALID]);
	assert.equal(result.length, 1);
	const s = result[0];

	assert.equal(s.schedulerId, "nightly-tidy");
	assert.equal(s.name, "local");
	assert.equal(s.pattern, "0 3 * * *");

	// data deep-equals the queue.mjs:21 shape. VALID omits provider/model/maxTurns, so they carry
	// through as undefined -- the value resolves at job start against the overlay/env, not frozen here.
	assert.deepEqual(s.data, {
		kind: "local",
		folder: "/proj",
		flow: "tidy",
		task: "run the tidy pass",
		provider: undefined,
		model: undefined,
		maxTurns: undefined,
	});

	// opts: retention only -- no jobId, attempts, or backoff.
	assert.equal("jobId" in s.opts, false);
	assert.equal("attempts" in s.opts, false);
	assert.equal("backoff" in s.opts, false);
	assert.equal(s.opts.removeOnComplete.age, 24 * 3600);
	assert.equal(s.opts.removeOnFail.age, 7 * 24 * 3600);
});

test("entry-level provider/model/maxTurns pass through verbatim into data", () => {
	const [s] = load([{ ...VALID, provider: "openai", model: "gpt-x", maxTurns: 5 }]);
	assert.equal(s.data.provider, "openai");
	assert.equal(s.data.model, "gpt-x");
	assert.equal(s.data.maxTurns, 5);
});

test("a 6-field cron (with seconds) is accepted", () => {
	const [s] = load([{ ...VALID, cron: "0 0 3 * * *" }]);
	assert.equal(s.pattern, "0 0 3 * * *");
});

test("multiple valid entries with distinct ids all normalize", () => {
	const result = load([VALID, { ...VALID, id: "weekly-audit", cron: "0 4 * * 0" }]);
	assert.equal(result.length, 2);
	assert.deepEqual(result.map((s) => s.schedulerId), ["nightly-tidy", "weekly-audit"]);
});
