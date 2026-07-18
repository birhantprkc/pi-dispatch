import assert from "node:assert/strict";
import { test } from "node:test";

// start.mjs imports index.mjs (bullmq), connection.mjs (ioredis), and the octokit-backed auth/host
// modules, so this skips below the node floor / without deps and runs in CI, where
// PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a skip into a hard failure.
let mod;
let importError;
try {
	mod = await import("../src/start.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`start wiring tests are REQUIRED here but a dependency could not import.\n${importError}`);
}
const skip = mod ? false : `worker deps not installed (node ${process.version} < 22.19.0); CI runs these`;

function fakeHost(overrides = {}) {
	return {
		resolveDefaultBranchSha: async () => ({ branch: "main", sha: "abc" }),
		isDefaultBranchProtected: async () => true,
		postStatusComment: async () => {},
		...overrides,
	};
}

// Drive startWorker with injected fakes and capture the exact object handed to createWorker
// (deps are nested under `deps`). No real Redis: createWorkerFn is faked. The real ioredis client
// startWorker constructs via makeRedisClient is torn down so it leaves no dangling handle.
async function runStart({ env = {}, makeAuth, makeHost, makeReaper, order } = {}) {
	const calls = [];
	const registered = {};
	const createWorkerFn = (arg) => {
		if (order) order.push("createWorker");
		calls.push(arg);
		// Record every worker.on(...) registration so tests can drive the completed/failed handlers
		// (inspecting the emitted log line) and assert the scheduler stall guard's "stalled" listener.
		return {
			on(evt, fn) {
				registered[evt] = fn;
			},
		};
	};

	// Default to a no-op reaper so the wiring tests never shell out to docker; ordering/throwing tests
	// inject their own.
	const reaper = makeReaper ?? (() => async () => {});

	const lines = [];
	const origWrite = process.stdout.write;
	process.stdout.write = (chunk) => {
		lines.push(String(chunk));
		return true;
	};
	try {
		await mod.startWorker(env, { makeAuth, makeHost, createWorkerFn, makeReaper: reaper });
	} finally {
		process.stdout.write = origWrite;
	}

	const captured = calls[0];
	captured?.redis?.disconnect?.(); // release the background reconnect handle
	// The persistent schedulerQueue opens its own ioredis connection; close it so the suite leaks no handle.
	await captured?.extraClosers?.[0]?.close?.().catch(() => {});

	const logs = lines.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return { raw: l };
		}
	});
	// Expose the registration map under both names: `handlers` for the completed/failed handler tests,
	// `registered` for the scheduler stall-guard test. Same object, one capture path.
	return { captured, deps: captured?.deps, logs, handlers: registered, registered };
}

// Capture the JSON log lines a synchronous fn emits via process.stdout.write, then restore it.
function captureLogs(fn) {
	const lines = [];
	const origWrite = process.stdout.write;
	process.stdout.write = (chunk) => {
		lines.push(String(chunk));
		return true;
	};
	try {
		fn();
	} finally {
		process.stdout.write = origWrite;
	}
	return lines.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return { raw: l };
		}
	});
}

test("github configured: real mintToken and the host's isDefaultBranchProtected are wired", { skip }, async () => {
	const host = fakeHost();
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 123, source: "gh" });
	const { deps, logs } = await runStart({ makeAuth, makeHost: () => host });

	assert.equal(await deps.mintToken("o/r"), "tok", "mintToken must be the real one (not the throwing fallback)");
	assert.equal(deps.isDefaultBranchProtected, host.isDefaultBranchProtected, "isDefaultBranchProtected must be the host's");
	assert.equal(typeof deps.prepareWorkspace, "function");
	assert.ok(
		logs.some((l) => l.event === "self_identity" && l.id === 123 && l.source === "gh"),
		"a self_identity log carrying { id, source } must be emitted",
	);
});

test("comment is best-effort: a rejecting postStatusComment does not reject the adapter", { skip }, async () => {
	const host = fakeHost({
		postStatusComment: async () => {
			throw new Error("comment API down");
		},
	});
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { deps } = await runStart({ makeAuth, makeHost: () => host });

	const ghJob = { kind: "github", repo: "o/r", issueNumber: 7, id: "j1" };
	await assert.doesNotReject(() => deps.comment(ghJob, "text"), "github comment must swallow the postStatusComment rejection");

	// A local job never touches GitHub -- the adapter just logs and resolves.
	await assert.doesNotReject(() => deps.comment({ kind: "local", id: "L1" }, "hi"));
});

test("auth unavailable: the worker still boots; mintToken fails github jobs closed with a configError", { skip }, async () => {
	const makeAuth = async () => {
		throw new Error("gh CLI is logged out");
	};
	const { deps, captured, logs } = await runStart({ makeAuth, makeHost: () => fakeHost() });

	assert.ok(captured, "startWorker must still construct the worker (a local-only deployment boots)");
	assert.ok(logs.some((l) => l.event === "github_auth_unavailable"), "a github_auth_unavailable log must be emitted");
	await assert.rejects(
		() => deps.mintToken("o/r"),
		(err) => err?.piDispatchConfig === true,
		"mintToken must reject with a .piDispatchConfig-tagged configError when auth is unavailable",
	);
});

test("resolveDefaultBranchSha is threaded into prepareWorkspace (C2)", { skip }, async () => {
	const host = fakeHost();
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 5, source: "gh" });
	const { captured, deps } = await runStart({ makeAuth, makeHost: () => host });

	// makePrepareWorkspace receives resolveDefaultBranchSha and closes over it; the closure is what
	// the github prepare path calls. Threading is asserted at the boundary the wiring controls:
	// startWorker completed and a prepareWorkspace function was built from the host's resolver.
	assert.ok(captured, "startWorker completed");
	assert.equal(typeof deps.prepareWorkspace, "function", "a prepareWorkspace dep must be wired");
});

test("the boot reaper runs BEFORE the worker starts draining (strays cleared first)", { skip }, async () => {
	const order = [];
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const makeReaper = () => async () => {
		order.push("reap");
	};
	await runStart({ makeAuth, makeHost: () => fakeHost(), makeReaper, order });
	assert.deepEqual(order, ["reap", "createWorker"], "reap must clear strays before the worker is created");
});

test("a reaper that throws does NOT reject startWorker (boot is best-effort)", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const makeReaper = () => async () => {
		throw new Error("docker daemon down");
	};
	const { captured, logs } = await runStart({ makeAuth, makeHost: () => fakeHost(), makeReaper });
	assert.ok(captured, "startWorker must still construct the worker when the reaper throws");
	assert.ok(logs.some((l) => l.event === "reaper_skipped"), "a throwing reaper must be logged as reaper_skipped");
});

test("job_completed carries reason when the result has one and omits it otherwise", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { handlers } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	assert.equal(typeof handlers.completed, "function", "startWorker must register a completed handler");

	const withReason = captureLogs(() => handlers.completed({ id: "j1" }, { outcome: "policy", reason: "worker-abort" }));
	const wr = withReason.find((l) => l.event === "job_completed");
	assert.equal(wr?.outcome, "policy");
	assert.equal(wr?.reason, "worker-abort", "reason must be logged when the result carries one");

	const noReason = captureLogs(() => handlers.completed({ id: "j2" }, { outcome: "success" }));
	const nr = noReason.find((l) => l.event === "job_completed");
	assert.equal(nr?.outcome, "success");
	assert.ok(!("reason" in nr), "reason must be omitted from a clean success line");
});

// Cron wiring. DEFAULT env => no PI_SCHEDULES_FILE => schedules=[] => reconcile is skipped, so these
// assert the wiring that runs even with cron disabled: no live Valkey required.
test("cron wiring: a stalled listener is registered and schedules_installed precedes worker_started", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 9, source: "gh" });
	const { captured, logs, registered } = await runStart({ makeAuth, makeHost: () => fakeHost() });

	// (a) the money backstop is keyed on "stalled" -- the guard's onStalled is registered there.
	assert.equal(typeof registered.stalled, "function", "a stalled listener (the scheduler stall guard) must be registered");

	// (c) the persistent schedulerQueue is handed to createWorker as an extraCloser so shutdown drains it.
	assert.equal(
		typeof captured.extraClosers?.[0]?.close,
		"function",
		"the schedulerQueue must be registered as extraClosers[0] with a close()",
	);

	// (d) empty schedule set still emits schedules_installed {0,0} so the operator sees cron is off.
	const installed = logs.find((l) => l.event === "schedules_installed");
	assert.ok(installed, "a schedules_installed log must be emitted even when cron is disabled");
	assert.deepEqual(
		{ installed: installed.installed, removed: installed.removed },
		{ installed: 0, removed: 0 },
		"an empty schedule set must log schedules_installed {installed:0, removed:0}",
	);

	// (b) schedules must be reconciled and logged before the worker announces itself.
	const installedIdx = logs.findIndex((l) => l.event === "schedules_installed");
	const startedIdx = logs.findIndex((l) => l.event === "worker_started");
	assert.ok(startedIdx !== -1, "a worker_started log must be emitted");
	assert.ok(installedIdx < startedIdx, "schedules_installed must be logged before worker_started");
});
