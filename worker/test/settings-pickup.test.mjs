import assert from "node:assert/strict";
import { test } from "node:test";

// index.mjs imports bullmq, so this skips below the node floor / without deps and runs in CI, where
// PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a skip into a hard failure. Mirrors wiring.test.mjs.
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`settings-pickup tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

// A fake redis whose counter starts at `start`. `incrCalls` spies reserveBudget so a test can prove the
// budget slot was (or was NOT) reserved. Mirrors processor.test.mjs's fakeRedis.
function fakeRedis(start = 0) {
	let n = start;
	const redis = { incrCalls: 0, decrCalls: 0 };
	redis.incr = async () => (redis.incrCalls++, ++n);
	redis.decr = async () => (redis.decrCalls++, --n);
	redis.expire = async () => {};
	return redis;
}

// Build a real makeProcessor (which imports the real runJob) over fully-faked deps, capturing what
// runContainer receives -- so the effective job settings that reach the container are observable -- plus
// every applyConcurrency call and every run record. Mirrors wiring.test.mjs's full-fake-deps style.
function harness({ getSettings, redis = fakeRedis(), applyConcurrency, recordRun } = {}) {
	const seen = { container: null, containerCalls: 0, concurrency: [], records: [] };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings,
		applyConcurrency: applyConcurrency ?? ((n) => seen.concurrency.push(n)),
		recordRun: recordRun ?? ((rec) => seen.records.push(rec)),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			// runContainer receives { job, token, prepared, name, signal }; capture the effective job.
			runContainer: async ({ job }) => {
				seen.containerCalls++;
				seen.container = job;
				return { code: 0, aborted: false, turns: 3 };
			},
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
	return { processor, seen, redis };
}

// The receiver-produced GitHub job shape: NO provider/model/maxTurns -- filter.mjs leaves the worker to
// fill defaults, which is the P0 this task fixes.
const receiverGhJob = () => ({
	id: "d-guid",
	attemptsMade: 0,
	name: "github",
	data: { kind: "github", repo: "o/r", issueNumber: 1, flow: "fix", trigger: { deliveryId: "d", sender: { id: 1 } } },
});

const effective = (over = {}) => ({ provider: "anthropic", model: "claude-sonnet-4-5", maxTurns: 30, dailyCap: 10, concurrency: 3, ...over });

test("(a) P0: a receiver GitHub job with no provider/model/maxTurns reaches the container with effective values; slot reserved once", { skip }, async () => {
	const { processor, seen, redis } = harness({ getSettings: () => effective() });

	const result = await processor(receiverGhJob(), "tok", new AbortController().signal);

	assert.equal(result.outcome, "completed", "the job runs to completion -- no throw at the container env allowlist");
	assert.ok(seen.container, "runContainer was reached (pre-fix this threw after reserveBudget)");
	assert.equal(seen.container.provider, "anthropic", "provider filled from the overlay");
	assert.equal(seen.container.model, "claude-sonnet-4-5", "model filled from the overlay");
	assert.equal(seen.container.maxTurns, 30, "maxTurns filled from the overlay");
	assert.equal(redis.incrCalls, 1, "the budget slot is reserved exactly once (the container ran)");
	assert.equal(redis.decrCalls, 0, "a completed run never releases its slot");
});

test("(b) an invalid overlay refuses before any spend: no budget reserved, no container, recordRun carries settings-overlay-invalid", { skip }, async () => {
	const { processor, seen, redis } = harness({ getSettings: () => ({ invalid: "dailyCap must be an integer >= 1" }) });

	const result = await processor(receiverGhJob(), "tok", new AbortController().signal);

	assert.equal(result.outcome, "policy");
	assert.equal(result.reason, "settings-overlay-invalid");
	assert.equal(result.budgetReserved, false, "no slot reserved on the refusal path");
	assert.equal(result.exitCode, null);
	assert.equal(result.turns, null);
	assert.equal(redis.incrCalls, 0, "reserveBudget never runs -- the refusal precedes the budget gate");
	assert.equal(seen.containerCalls, 0, "no container started");
	assert.equal(seen.records.length, 1, "exactly one run record is written on the refusal path");
	assert.equal(seen.records[0].result, result, "recordRun receives the policy result (returned, never thrown)");
});

test("(c) dailyCap lowered below today's reserved count refuses over-budget before the container", { skip }, async () => {
	// The counter already sits at 5 reserved; an overlay dailyCap of 3 makes the next reservation land over-cap.
	const { processor, seen } = harness({ getSettings: () => effective({ dailyCap: 3 }), redis: fakeRedis(5) });

	const result = await processor(receiverGhJob(), "tok", new AbortController().signal);

	assert.equal(result.outcome, "policy");
	assert.equal(result.reason, "over-budget", "the overlay's lower cap is what reserveBudget checks against");
	assert.equal(seen.containerCalls, 0, "over budget => no container, no provider spend");
});

test("(d) explicit job.data values win over the overlay", { skip }, async () => {
	const job = receiverGhJob();
	job.data.provider = "explicit-provider";
	job.data.model = "explicit-model";
	job.data.maxTurns = 7;
	const { processor, seen } = harness({
		getSettings: () => effective({ provider: "overlay-provider", model: "overlay-model", maxTurns: 99 }),
	});

	await processor(job, "tok", new AbortController().signal);

	assert.equal(seen.container.provider, "explicit-provider", "job.data.provider wins over the overlay");
	assert.equal(seen.container.model, "explicit-model", "job.data.model wins over the overlay");
	assert.equal(seen.container.maxTurns, 7, "job.data.maxTurns wins over the overlay");
});

test("(e) applyConcurrency runs with the effective concurrency on the happy path, never when the overlay is invalid", { skip }, async () => {
	const happy = harness({ getSettings: () => effective({ concurrency: 7 }) });
	await happy.processor(receiverGhJob(), "tok", new AbortController().signal);
	assert.deepEqual(happy.seen.concurrency, [7], "the effective concurrency re-binds the worker slot count once");

	const invalid = harness({ getSettings: () => ({ invalid: "concurrency must be an integer 1-10" }) });
	await invalid.processor(receiverGhJob(), "tok", new AbortController().signal);
	assert.deepEqual(invalid.seen.concurrency, [], "an invalid overlay never touches concurrency");
});
