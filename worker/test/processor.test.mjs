import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraRetry, runJob } from "../src/processor.mjs";

/** A fake redis whose counter we can preset, to force over/under budget. `decrCalls` spies
 *  releaseBudget, so tests assert the slot is (or is not) given back and never double-released. */
function fakeRedis(start = 0) {
	let n = start;
	const redis = { decrCalls: 0, incrCalls: 0 };
	redis.incr = async () => (redis.incrCalls++, ++n);
	redis.decr = async () => (redis.decrCalls++, --n);
	redis.expire = async () => {};
	return redis;
}

/** Deps with call-order tracking, so tests can assert the money-safety ORDER, not just outcomes. */
function deps(overrides = {}) {
	const calls = [];
	const base = {
		redis: fakeRedis(),
		// The day window is the only one active by default (week/month disabled), so the single-counter
		// fakeRedis stays valid; soft-hold is off unless a test sets it. Mirrors a default deployment.
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		mintToken: async (repo) => (calls.push(`mint:${repo}`), "tok"),
		isDefaultBranchProtected: async () => (calls.push("branch-check"), true),
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async () => (calls.push("run-container"), { code: 0, aborted: false }),
		collectChain: async () => (calls.push("collect-chain"), { enqueued: 0, refused: 0 }),
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
	assert.deepEqual(calls, ["mint:org/repo", "branch-check", "prepare", "run-container", "collect-chain", "cleanup"]);
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
	// counter starts at cap, so the reservation lands over-cap (base caps.day is 10).
	const { deps: d, calls } = deps({ redis: fakeRedis(10) });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "over-budget");
	assert.ok(calls.includes("prepare"), "prepared (free work) before the budget gate");
	assert.ok(!calls.includes("run-container"), "over budget => NO container, no money spent");
});

test("soft-hold refuses AFTER prepare but BEFORE the container, with a distinct soft-hold reason", async () => {
	// day cap 5, 80% band -> threshold floor(4)=4; counter at 4 makes the reservation land at 5 (in-band).
	const { deps: d, calls } = deps({ redis: fakeRedis(4), caps: { day: 5, week: null, month: null }, softHoldPct: 80 });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "soft-hold", "an in-band reservation is a soft-hold, distinct from over-budget");
	assert.equal(r.budgetReserved, true, "the reservation still counts (no give-back)");
	assert.ok(calls.includes("prepare"), "prepared (free work) before the budget gate");
	assert.ok(!calls.includes("run-container"), "soft-hold => new start paused, NO container, no money spent");
});

test("a prepare policy outcome (sha-gone) RETURNS before reserveBudget -- no cap slot burned", async () => {
	const redis = fakeRedis();
	const { deps: d, calls } = deps({
		redis,
		prepareWorkspace: async () => ({ outcome: "policy", reason: "sha-gone" }),
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "sha-gone");
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached on a determinate prepare policy outcome");
	assert.ok(!calls.includes("run-container"), "a sha-gone prepare must never spend on a container");
});

test("container exit 0 => success, no retry", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 0, aborted: false }) });
	assert.equal((await runJob(ghJob, d)).outcome, "completed");
});

test("container exit 2 => policy, RETURNS (not retried)", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 2, aborted: false }) });
	assert.equal((await runJob(ghJob, d)).outcome, "policy");
});

test("container exit 1 => THROWS InfraRetry (BullMQ will retry)", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 1, aborted: false }) });
	await assert.rejects(() => runJob(ghJob, d), (e) => e instanceof InfraRetry && e.piDispatchRetry === true);
});

test("a worker-initiated abort (137, aborted) => policy RETURNS worker-abort, never retried", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 137, aborted: true }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "worker-abort", "our own docker stop must not re-run into a second PR");
});

test("a graceful-shutdown SIGTERM (143, aborted) => policy worker-abort, not retried", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 143, aborted: true }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "worker-abort");
});

test("an unbidden 137 (aborted:false, kernel OOM) throws InfraRetry -- infra stays retryable", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 137, aborted: false }) });
	await assert.rejects(() => runJob(ghJob, d), InfraRetry);
});

test("cleanup runs even when the container throws", async () => {
	const { deps: d, calls } = deps({ runContainer: async () => ({ code: 1, aborted: false }) });
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

test("an empty minted token refuses as configError BEFORE reserveBudget -- no cap slot burned", async () => {
	const redis = fakeRedis();
	const { deps: d, calls } = deps({ redis, mintToken: async () => "" });
	await assert.rejects(() => runJob(ghJob, d), (e) => e.piDispatchConfig === true);
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached -- no slot burned on a bad token");
	assert.ok(!calls.includes("run-container"), "an empty credential must never spend");
});

test("a whitespace-only minted token is also refused as configError", async () => {
	const redis = fakeRedis();
	const { deps: d } = deps({ redis, mintToken: async () => "   " });
	await assert.rejects(() => runJob(ghJob, d), (e) => e.piDispatchConfig === true);
	assert.equal(redis.incrCalls, 0, "whitespace is empty -- no slot burned");
});

test("a local job does not hit the empty-credential guard (guard is isGitHub-gated)", async () => {
	const redis = fakeRedis();
	const { deps: d } = deps({ redis, mintToken: async () => "" });
	const localJob = { kind: "local", folder: "/home/rob/proj", provider: "anthropic", model: "m", maxTurns: 5 };
	const r = await runJob(localJob, d);
	assert.equal(r.outcome, "completed", "a local job never mints, so the empty-token guard cannot fire");
});

test("container-never-started (spawn fault) after reserving RELEASES the slot, still throws InfraRetry", async () => {
	const redis = fakeRedis();
	const { deps: d } = deps({
		redis,
		runContainer: async () => {
			throw new InfraRetry("container-never-started", { reason: "container-never-started" });
		},
	});
	await assert.rejects(
		() => runJob(ghJob, d),
		(e) => e instanceof InfraRetry && e.reason === "container-never-started",
	);
	assert.equal(redis.decrCalls, 1, "releaseBudget gives the slot back exactly once -- no double-release");
});

test("exit-1 infra retry KEEPS the slot -- the container ran and spent, so no release", async () => {
	const redis = fakeRedis();
	const { deps: d } = deps({ redis, runContainer: async () => ({ code: 1, aborted: false }) });
	await assert.rejects(() => runJob(ghJob, d), InfraRetry);
	assert.equal(redis.decrCalls, 0, "a container that ran must not get its slot back");
});

test("InfraRetry back-compat: message-only ctor keeps piDispatchRetry and defaults reason to the message", () => {
	const e = new InfraRetry("x");
	assert.equal(e.piDispatchRetry, true);
	assert.equal(e.reason, "x");
	assert.equal(e.message, "x");
	assert.equal(e.exitCode, null, "telemetry fields default null on the message-only ctor");
	assert.equal(e.turns, null);
	assert.equal(e.budgetReserved, null);
});

test("a completed return carries exitCode/turns from the container and budgetReserved true", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 0, aborted: false, turns: 7 }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.equal(r.exitCode, 0);
	assert.equal(r.turns, 7);
	assert.equal(r.budgetReserved, true);
});

test("an over-budget return carries null exit/turns but budgetReserved true (slot kept)", async () => {
	const { deps: d } = deps({ redis: fakeRedis(10) });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "over-budget");
	assert.equal(r.exitCode, null);
	assert.equal(r.turns, null);
	assert.equal(r.budgetReserved, true);
});

test("an unprotected-branch return carries null exit/turns and budgetReserved false (pre-reserve)", async () => {
	const { deps: d } = deps({ isDefaultBranchProtected: async () => false });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "unprotected-branch");
	assert.equal(r.exitCode, null);
	assert.equal(r.turns, null);
	assert.equal(r.budgetReserved, false);
});

test("an exit-1 infra throw stamps exitCode/turns and budgetReserved true (container ran and spent)", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 1, aborted: false, turns: 4 }) });
	await assert.rejects(
		() => runJob(ghJob, d),
		(e) => e instanceof InfraRetry && e.exitCode === 1 && e.turns === 4 && e.budgetReserved === true,
	);
});

test("a container-never-started throw stamps budgetReserved false (its slot is refunded)", async () => {
	const { deps: d } = deps({
		runContainer: async () => {
			throw new InfraRetry("container-never-started", { reason: "container-never-started" });
		},
	});
	await assert.rejects(
		() => runJob(ghJob, d),
		(e) => e instanceof InfraRetry && e.reason === "container-never-started" && e.budgetReserved === false,
	);
});

test("a completed run collects the chain and carries chainEnqueued/chainRefused from collectChain", async () => {
	const { deps: d } = deps({
		runContainer: async () => ({ code: 0, aborted: false, turns: 9 }),
		collectChain: async () => ({ enqueued: 2, refused: 1 }),
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.equal(r.chainEnqueued, 2);
	assert.equal(r.chainRefused, 1);
});

test("collectChain runs BEFORE cleanup deletes the job dir (the outbox is read before deletion)", async () => {
	const order = [];
	const { deps: d } = deps({
		collectChain: async () => (order.push("collect"), { enqueued: 0, refused: 0 }),
		cleanup: async () => (order.push("cleanup"), undefined),
	});
	await runJob(ghJob, d);
	assert.deepEqual(order, ["collect", "cleanup"], "the chain must be collected before jobDir is cleaned up");
});

test("collectChain counts are additive telemetry: they never alter the completed outcome/exit/turns/budget", async () => {
	const { deps: d } = deps({
		runContainer: async () => ({ code: 0, aborted: false, turns: 9 }),
		collectChain: async () => ({ enqueued: 5, refused: 3 }),
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed", "a chain result never flips the completed outcome");
	assert.equal(r.exitCode, 0);
	assert.equal(r.turns, 9);
	assert.equal(r.budgetReserved, true);
	assert.equal(r.chainEnqueued, 5);
	assert.equal(r.chainRefused, 3);
});

test("collectChain runs ONLY on the completed branch, never on policy / abort / infra / over-budget", async () => {
	// EXIT_POLICY (runner-policy, container exit 2)
	{
		const { deps: d, calls } = deps({ runContainer: async () => (calls.push("run-container"), { code: 2, aborted: false }) });
		const r = await runJob(ghJob, d);
		assert.equal(r.outcome, "policy");
		assert.ok(!calls.includes("collect-chain"), "runner-policy must not chain");
	}
	// worker-abort (137, aborted)
	{
		const { deps: d, calls } = deps({ runContainer: async () => (calls.push("run-container"), { code: 137, aborted: true }) });
		await runJob(ghJob, d);
		assert.ok(!calls.includes("collect-chain"), "a worker abort must not chain");
	}
	// EXIT_INFRA (exit 1 => throws InfraRetry; a retried job would double-chain)
	{
		const { deps: d, calls } = deps({ runContainer: async () => (calls.push("run-container"), { code: 1, aborted: false }) });
		await runJob(ghJob, d).catch(() => {});
		assert.ok(!calls.includes("collect-chain"), "an infra retry must not chain -- it re-runs");
	}
	// over-budget (policy, pre-container)
	{
		const { deps: d, calls } = deps({ redis: fakeRedis(10) });
		await runJob(ghJob, d);
		assert.ok(!calls.includes("collect-chain"), "over-budget must not chain");
	}
	// unprotected-branch (policy, pre-container)
	{
		const { deps: d, calls } = deps({ isDefaultBranchProtected: async () => false });
		await runJob(ghJob, d);
		assert.ok(!calls.includes("collect-chain"), "an unprotected branch must not chain");
	}
});
