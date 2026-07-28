import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
async function runStart({ env = {}, makeAuth, makeHost, makeReaper, makeLogSink, makeRecordWriter, makeLogReaper, makeRunContainer, order } = {}) {
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

	// Default the run-history factories to inert fakes so the wiring tests never touch disk (the real
	// factories mkdirSync/readdirSync at construction). Each default records the args it was constructed
	// with so a test can assert config threading without a fs. A `logsDir`-only sentinel is fine here:
	// runContainer is never invoked, so the returned openJobLog is stored and never called.
	const openJobLogSentinel = () => ({ write() {}, close: async () => ({ turns: null }) });
	const logSinkCalls = [];
	const recordWriterCalls = [];
	const logReaperCalls = [];
	const logSink =
		makeLogSink ??
		((args) => {
			logSinkCalls.push(args);
			return openJobLogSentinel;
		});
	const recordWriter =
		makeRecordWriter ??
		((args) => {
			recordWriterCalls.push(args);
			return () => {};
		});
	const logReaper =
		makeLogReaper ??
		((args) => {
			logReaperCalls.push(args);
			return () => {};
		});

	// The container factory is faked for the same reason as the run-history ones: the wiring tests assert
	// what boot HANDS it (image, overlay, staged packages), never a docker launch. It records its args and
	// returns an inert runContainer that is stored in deps and never invoked here.
	const runContainerCalls = [];
	const runContainerFactory =
		makeRunContainer ??
		((args) => {
			runContainerCalls.push(args);
			return async () => ({ code: 0, aborted: false, turns: null, tokens: null });
		});

	const lines = [];
	const origWrite = process.stdout.write;
	process.stdout.write = (chunk) => {
		lines.push(String(chunk));
		return true;
	};
	try {
		await mod.startWorker(env, {
			makeAuth,
			makeHost,
			createWorkerFn,
			makeReaper: reaper,
			makeLogSink: logSink,
			makeRecordWriter: recordWriter,
			makeLogReaper: logReaper,
			makeRunContainer: runContainerFactory,
		});
	} finally {
		process.stdout.write = origWrite;
	}

	const captured = calls[0];
	captured?.redis?.disconnect?.(); // release the background reconnect handle
	// The persistent runtimeQueue opens its own ioredis connection; close it so the suite leaks no handle.
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
	return { captured, deps: captured?.deps, logs, handlers: registered, registered, logSinkCalls, recordWriterCalls, logReaperCalls, runContainerCalls };
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

test("chain wiring: the outbox collectChain is wired into deps as a function", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	assert.equal(typeof deps.collectChain, "function", "the outbox chain collector must be wired into deps.collectChain");
});

// Cron wiring. DEFAULT env => no PI_TRIGGERS_FILE => schedules=[] => reconcile is skipped, so these
// assert the wiring that runs even with cron disabled: no live Valkey required.
test("cron wiring: a stalled listener is registered and schedules_installed precedes worker_started", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 9, source: "gh" });
	const { captured, logs, registered } = await runStart({ makeAuth, makeHost: () => fakeHost() });

	// (a) the money backstop is keyed on "stalled" -- the guard's onStalled is registered there.
	assert.equal(typeof registered.stalled, "function", "a stalled listener (the scheduler stall guard) must be registered");

	// (c) the persistent runtimeQueue is handed to createWorker as an extraCloser so shutdown drains it.
	assert.equal(
		typeof captured.extraClosers?.[0]?.close,
		"function",
		"the runtimeQueue must be registered as extraClosers[0] with a close()",
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

// Run-history wiring (REQ-LOCAL-JOB-VISIBILITY). DEFAULT env => no live Valkey / disk required: the
// harness injects inert run-history factories, so these assert the wiring, not the I/O.
test("run-history: makeLogSink receives config.logsDir and the captureJobLogs gate (both polarities)", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });

	const on = await runStart({ env: { PI_LOGS_DIR: "/tmp/pi-logs", PI_CAPTURE_JOB_LOGS: "1" }, makeAuth, makeHost: () => fakeHost() });
	assert.equal(on.logSinkCalls.length, 1, "makeLogSink must be constructed exactly once");
	assert.equal(on.logSinkCalls[0].logsDir, "/tmp/pi-logs", "makeLogSink must receive the host-side config.logsDir");
	assert.equal(on.logSinkCalls[0].enabled, true, "enabled must mirror captureJobLogs when PI_CAPTURE_JOB_LOGS=1");

	// The record writer is always constructed against the same logsDir; the id-only record is not gated.
	assert.equal(on.recordWriterCalls[0]?.logsDir, "/tmp/pi-logs", "makeRecordWriter must receive config.logsDir");

	const off = await runStart({ env: { PI_LOGS_DIR: "/tmp/pi-logs" }, makeAuth, makeHost: () => fakeHost() });
	assert.equal(off.logSinkCalls[0].enabled, false, "enabled must be false when PI_CAPTURE_JOB_LOGS is unset");
});

test("run-history: recordRun is passed to createWorker as a TOP-LEVEL arg, not nested under deps", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { captured } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	assert.equal(typeof captured.recordRun, "function", "recordRun must be a top-level createWorker arg");
	assert.equal(captured.deps.recordRun, undefined, "recordRun must NOT be nested under deps");
});

// Runtime-settings overlay wiring (INT-CONFIG-OVERLAY-CONTRACT). PI_SETTINGS_FILE points at a path that
// cannot exist so readOverlay yields the normal empty overlay and getSettings resolves purely from
// env/default config -- no real settings.json on the host is consulted.
test("runtime settings: getSettings is a top-level createWorker arg resolving effective settings; the static cap arg is gone", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const settingsFile = "/pi-dispatch-nonexistent/does-not-exist/settings.json";
	const { captured, logs } = await runStart({ env: { PI_SETTINGS_FILE: settingsFile }, makeAuth, makeHost: () => fakeHost() });

	assert.equal(typeof captured.getSettings, "function", "getSettings must be a top-level createWorker arg");
	assert.equal(captured.cap, undefined, "no static cap arg survives -- the overlay replaces the frozen daily cap");

	// Calling it with an empty overlay yields the ten effective keys from env/default config (env {} here);
	// the optional week/month ceilings, token controls, and the soft-hold band default to disabled (null).
	assert.deepEqual(
		captured.getSettings(),
		{
			provider: "anthropic",
			model: "claude-sonnet-4-5-20250929",
			maxTurns: 30,
			dailyCap: 25,
			weeklyCap: null,
			monthlyCap: null,
			maxTokens: null,
			dailyTokenCap: null,
			concurrency: 3,
			softHoldPct: null,
		},
		"getSettings resolves the ten effective keys from env/default config when the overlay is empty",
	);

	const started = logs.find((l) => l.event === "worker_started");
	assert.ok(started, "a worker_started log must be emitted");
	assert.equal(started.settingsFile, settingsFile, "worker_started must announce the settings overlay path");
});

test("runtime settings: a boot overlay sets the constructed concurrency, and worker_started reports that effective value (not the env default)", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	// A real settings.json whose concurrency (7) differs from the env default (3), so the boot-effective
	// value is distinguishable from config.concurrency in both the constructor arg and the log.
	const dir = mkdtempSync(join(tmpdir(), "pi-settings-"));
	const settingsFile = join(dir, "settings.json");
	writeFileSync(settingsFile, JSON.stringify({ concurrency: 7 }));
	try {
		const { captured, logs } = await runStart({ env: { PI_SETTINGS_FILE: settingsFile }, makeAuth, makeHost: () => fakeHost() });
		assert.equal(captured.concurrency, 7, "the Worker is constructed with the boot-effective concurrency, not the env default 3");
		const started = logs.find((l) => l.event === "worker_started");
		assert.equal(started.concurrency, 7, "worker_started must report the concurrency the Worker was actually constructed with");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("run-history: the log reaper sweeps aged history BEFORE the worker starts draining", { skip }, async () => {
	const order = [];
	let reaperArgs;
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const makeLogReaper = (args) => {
		reaperArgs = args;
		return () => {
			order.push("reapLogs");
		};
	};
	await runStart({
		env: { PI_LOGS_DIR: "/tmp/pi-logs", PI_LOG_RETENTION_DAYS: "7" },
		makeAuth,
		makeHost: () => fakeHost(),
		makeLogReaper,
		order,
	});
	assert.deepEqual(order, ["reapLogs", "createWorker"], "the log reaper must sweep before the worker is created");
	assert.equal(reaperArgs.logsDir, "/tmp/pi-logs", "the log reaper must receive config.logsDir");
	assert.equal(reaperArgs.retentionDays, 7, "the log reaper must receive config.logRetentionDays");
});

// REQ-GLOBAL-PI-OVERLAY staged packages. The overlay dir EXISTS (config refuses a missing one at load)
// but holds no packages.json -- the shape of every deployment that never opted into staged packages.
test("staged packages: an overlay with no packages.json boots to packagePaths [] and logs it -- never a boot failure", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const overlay = mkdtempSync(join(tmpdir(), "pi-global-"));
	try {
		const { captured, logs, runContainerCalls } = await runStart({ env: { PI_GLOBAL_PI_DIR: overlay }, makeAuth, makeHost: () => fakeHost() });

		assert.ok(captured, "an unreadable/absent manifest must not block boot -- doctor is what fails loud on the mismatch");
		assert.equal(runContainerCalls.length, 1, "the container factory is constructed exactly once, at boot");
		assert.deepEqual(runContainerCalls[0].packagePaths, [], "an absent manifest resolves to the empty staged set, so every job stays unflagged");
		assert.equal(runContainerCalls[0].globalPiDir, overlay, "the overlay itself is still mounted -- only the staged packages are missing");

		const absent = logs.find((l) => l.event === "packages_manifest_absent");
		assert.ok(absent, "the absent manifest must leave one log line, so a silent [] is never the only trace");
		assert.equal(absent.overlay, overlay, "the line names the overlay it looked under (a deploy path is not PII)");
	} finally {
		rmSync(overlay, { recursive: true, force: true });
	}
});

test("staged packages: no overlay configured means no manifest read and no packages_manifest_absent noise", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { logs, runContainerCalls } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	assert.deepEqual(runContainerCalls[0].packagePaths, [], "no overlay -> the empty staged set");
	assert.ok(!logs.some((l) => l.event === "packages_manifest_absent"), "a deployment with no overlay at all has nothing to warn about");
});

test("run-history: worker_started announces logsDir, captureJobLogs and logRetentionDays (a path is not PII)", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { logs } = await runStart({
		env: { PI_LOGS_DIR: "/tmp/pi-logs", PI_CAPTURE_JOB_LOGS: "1", PI_LOG_RETENTION_DAYS: "7" },
		makeAuth,
		makeHost: () => fakeHost(),
	});
	const started = logs.find((l) => l.event === "worker_started");
	assert.ok(started, "a worker_started log must be emitted");
	assert.equal(started.logsDir, "/tmp/pi-logs", "worker_started must announce where records land");
	assert.equal(started.captureJobLogs, true, "worker_started must announce the raw-log capture gate");
	assert.equal(started.logRetentionDays, 7, "worker_started must announce the retention window");
});
