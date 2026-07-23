import assert from "node:assert/strict";
import { test } from "node:test";
import { pauseUntilMs } from "../src/pause-windows.mjs";

// index.mjs imports bullmq; skip below the node floor / without deps, hard-fail in CI (mirrors settings-pickup).
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`pause-gate tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

// A redis whose incr spies reserveBudget: incrCalls MUST stay 0 on the defer path (no budget slot burned).
function fakeRedis() {
	const redis = { incrCalls: 0 };
	redis.incr = async () => (redis.incrCalls++, 1);
	redis.decr = async () => 0;
	redis.expire = async () => {};
	return redis;
}

// A BullMQ-shaped job whose moveToDelayed records the (timestamp, token) it was deferred with.
function spyJob(data) {
	const moves = [];
	return {
		job: {
			id: "d-guid",
			attemptsMade: 0,
			name: data.kind,
			data,
			moveToDelayed: async (ts, tok) => moves.push({ ts, tok }),
		},
		moves,
	};
}

function harness({ pauseUntil, redis = fakeRedis() }) {
	const seen = { containerCalls: 0 };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		applyConcurrency: () => {},
		pauseUntil,
		recordRun: () => {},
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => (seen.containerCalls++, { code: 0, aborted: false, turns: 3 }),
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
	return { processor, seen, redis };
}

const NOW = Date.UTC(2026, 6, 23, 23, 0); // 2026-07-23 23:00 UTC — inside a 22:00–06:00 window
const windows = pauseUntilMs; // (alias for readability)

test("a job whose scope is in a pause window is moved to delayed, spends no budget, and never starts a container", { skip }, async () => {
	// Real predicate + real windows + a github job whose repo matches — proves the job.data scope wiring too.
	const pw = [{ scope: "acme/web", from: "22:00", to: "06:00", tz: "UTC", fromMin: 1320, toMin: 360 }];
	const { job, moves } = spyJob({ kind: "github", repo: "acme/web", target: { number: 1 }, flow: "fix", trigger: { deliveryId: "d", sender: { id: 1 } } });
	const { processor, seen, redis } = harness({ pauseUntil: (j) => windows(pw, j, NOW) });

	await assert.rejects(() => processor(job, "the-token", new AbortController().signal), (err) => err.name === "DelayedError", "defers via a DelayedError");

	assert.equal(moves.length, 1, "moveToDelayed was called exactly once");
	assert.equal(moves[0].tok, "the-token", "with the worker's token");
	assert.equal(moves[0].ts, Date.UTC(2026, 6, 24, 6, 0), "until the window end (06:00 next day)");
	assert.equal(redis.incrCalls, 0, "NO budget slot reserved on the defer path (before reserveBudget)");
	assert.equal(seen.containerCalls, 0, "no container started");
});

test("a job whose scope is NOT paused proceeds normally to the container", { skip }, async () => {
	const { job, moves } = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t" });
	// A window for a DIFFERENT scope -> this job is not paused.
	const pw = [{ scope: "other/repo", from: "22:00", to: "06:00", tz: "UTC", fromMin: 1320, toMin: 360 }];
	const { processor, seen } = harness({ pauseUntil: (j) => windows(pw, j, NOW) });

	const result = await processor(job, "tok", new AbortController().signal);

	assert.equal(moves.length, 0, "not deferred");
	assert.equal(result.outcome, "completed", "ran to completion");
	assert.equal(seen.containerCalls, 1, "the container started");
});

test("the default pauseUntil is a no-op, so an unwired processor never defers", { skip }, async () => {
	const { job, moves } = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t" });
	const processor = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(),
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		recordRun: () => {}, timeoutMs: 100000,
		deps: { mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }), runContainer: async () => ({ code: 0, aborted: false, turns: 3 }), cleanup: async () => {}, comment: async () => {}, log: () => {} },
	});
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(moves.length, 0);
	assert.equal(result.outcome, "completed");
});
