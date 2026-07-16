import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraRetry, runJob } from "../src/processor.mjs";

/** A fake redis whose counter we can preset, to force over/under budget. */
function fakeRedis(start = 0) {
	let n = start;
	return { async incr() { return ++n; }, async decr() { return --n; }, async expire() {} };
}

/** Deps with call-order tracking, so tests can assert the money-safety ORDER, not just outcomes. */
function deps(overrides = {}) {
	const calls = [];
	const base = {
		redis: fakeRedis(),
		cap: 10,
		mintToken: async (repo) => (calls.push(`mint:${repo}`), "tok"),
		isDefaultBranchProtected: async () => (calls.push("branch-check"), true),
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async () => (calls.push("run-container"), 0),
		cleanup: async () => (calls.push("cleanup"), undefined),
		comment: async (_j, t) => calls.push(`comment:${t.slice(0, 12)}`),
		now: new Date("2026-07-16T10:00:00Z"),
	};
	return { deps: { ...base, ...overrides }, calls };
}

const ghJob = { kind: "github", repo: "org/repo", provider: "anthropic", model: "m", maxTurns: 20 };

test("happy path: mint -> branch-check -> prepare -> budget -> container, in that order", async () => {
	const { deps: d, calls } = deps();
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(calls, ["mint:org/repo", "branch-check", "prepare", "run-container", "cleanup"]);
});

test("an unprotected branch refuses BEFORE any container -- and never prepares/spends", async () => {
	const { deps: d, calls } = deps({ isDefaultBranchProtected: async () => false });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "unprotected-branch");
	assert.ok(!calls.includes("run-container"), "must not spend on an unprotected repo");
	assert.ok(!calls.includes("prepare"), "must not even clone an unprotected repo");
});

test("over budget refuses AFTER prepare but BEFORE the container -- no provider spend", async () => {
	// counter starts at cap, so the reservation lands over-cap.
	const { deps: d, calls } = deps({ redis: fakeRedis(10), cap: 10 });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "over-budget");
	assert.ok(calls.includes("prepare"), "prepared (free work) before the budget gate");
	assert.ok(!calls.includes("run-container"), "over budget => NO container, no money spent");
});

test("container exit 0 => success, no retry", async () => {
	const { deps: d } = deps({ runContainer: async () => 0 });
	assert.equal((await runJob(ghJob, d)).outcome, "completed");
});

test("container exit 2 => policy, RETURNS (not retried)", async () => {
	const { deps: d } = deps({ runContainer: async () => 2 });
	assert.equal((await runJob(ghJob, d)).outcome, "policy");
});

test("container exit 1 => THROWS InfraRetry (BullMQ will retry)", async () => {
	const { deps: d } = deps({ runContainer: async () => 1 });
	await assert.rejects(() => runJob(ghJob, d), (e) => e instanceof InfraRetry && e.piDispatchRetry === true);
});

test("an unknown exit code throws (retry-then-visible), never silent success", async () => {
	const { deps: d } = deps({ runContainer: async () => 137 });
	await assert.rejects(() => runJob(ghJob, d), InfraRetry);
});

test("cleanup runs even when the container throws", async () => {
	const { deps: d, calls } = deps({ runContainer: async () => 1 });
	await runJob(ghJob, d).catch(() => {});
	assert.ok(calls.includes("cleanup"), "the job dir must be cleaned up on the infra path too");
});

test("a local-folder job skips minting and branch-check entirely", async () => {
	const { deps: d, calls } = deps();
	const localJob = { kind: "local", folder: "/home/rob/proj", provider: "anthropic", model: "m", maxTurns: 5 };
	const r = await runJob(localJob, d);
	assert.equal(r.outcome, "completed");
	assert.ok(!calls.some((c) => c.startsWith("mint")), "no token for a local job");
	assert.ok(!calls.includes("branch-check"), "no branch check for a non-git folder");
});
