import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// index.mjs imports bullmq, so this skips below the node floor / without deps and runs in CI,
// where PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a skip into a hard failure.
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`worker wiring tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

test("createWorker registers a win32-guarded SIGBREAK shutdown alongside SIGTERM/SIGINT", () => {
	// The signal registration lives inside createWorker, AFTER `new Worker(...)`. Constructing a real
	// Worker to observe process.once at runtime leaves a dangling ioredis reconnect handle that keeps
	// `node --test` from exiting (verified), so this asserts the contract against the source instead:
	// SIGTERM/SIGINT register unconditionally, SIGBREAK only on win32, and all three route to the same
	// `shutdown` closure (Windows never delivers an external SIGTERM; SIGBREAK covers console-close).
	// No bullmq import here, so this runs even below the node floor where the other tests skip.
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	assert.match(src, /process\.once\("SIGTERM", shutdown\)/, "SIGTERM must route to shutdown");
	assert.match(src, /process\.once\("SIGINT", shutdown\)/, "SIGINT must route to shutdown");
	assert.match(
		src,
		/process\.platform === "win32"\)\s*\{?\s*process\.once\("SIGBREAK", shutdown\)/,
		"SIGBREAK must be win32-guarded and route to the same shutdown closure",
	);
});

test("the processor declares arity 3 -- the silent trap that would disable the timeout", { skip }, () => {
	// BullMQ only allocates an AbortController when processor.length >= 3. If a refactor drops the
	// unused `token` param, the 30-minute timeout and shutdown abort silently stop working. This is
	// the single most important assertion in the worker's wiring, because nothing at runtime reports
	// its failure -- the container just runs unbounded.
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: {},
		cap: 10,
		deps: {},
	});
	assert.equal(processor.length, 3, "processor must declare (job, token, signal) or the abort dies");
});

test("the timeout fires cancelJob after timeoutMs", { skip }, async () => {
	let cancelled = null;
	const processor = mod.makeProcessor({
		cancelJob: (id, reason) => (cancelled = { id, reason }),
		stopContainer: () => {},
		redis: { async incr() { return 1; }, async expire() {} },
		cap: 10,
		timeoutMs: 20,
		deps: {
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({}),
			// a real container exits when docker stop runs; mirror that -- reject on abort.
			runContainer: ({ signal }) =>
				new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
			cleanup: async () => {},
			comment: async () => {},
		},
	});

	const ac = new AbortController();
	const job = { id: "j1", data: { kind: "github", repo: "o/r" } };
	const running = processor(job, "tok", ac.signal).catch(() => {});
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(cancelled?.id, "j1");
	assert.equal(cancelled?.reason, "job-timeout-30m");
	ac.abort(); // let the hung runContainer's abort path settle
	await running;
});

test("an abort stops the container", { skip }, async () => {
	let stopped = null;
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: (name) => (stopped = name),
		redis: { async incr() { return 1; }, async expire() {} },
		cap: 10,
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({}),
			runContainer: ({ signal }) =>
				new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
			cleanup: async () => {},
			comment: async () => {},
		},
	});
	const ac = new AbortController();
	const running = processor({ id: "j2", data: { kind: "github", repo: "o/r" } }, "tok", ac.signal).catch(() => {});
	// Let the job reach the running container before aborting -- in reality the container has been
	// up for minutes when the 30-min timeout fires.
	await new Promise((r) => setTimeout(r, 10));
	ac.abort();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(stopped, "pi-job-j2");
	await running;
});

test("shutdown closes each extraCloser after the worker drains", { skip }, async () => {
	// A cron scheduler (or any auxiliary resource) is handed to createWorker as an extraCloser so it
	// is torn down on SIGTERM/SIGINT alongside the worker. This proves close() runs during shutdown.
	const origExit = process.exit;
	const beforeTerm = new Set(process.listeners("SIGTERM"));
	const beforeInt = new Set(process.listeners("SIGINT"));
	let closed = false;
	let worker;
	try {
		process.exit = () => {}; // shutdown ends in process.exit(0); neutralise it for the test
		worker = mod.createWorker({
			connection: { host: "127.0.0.1", port: 1 },
			concurrency: 1,
			cap: 10,
			redis: {},
			deps: {},
			extraClosers: [{ close: async () => { closed = true; } }],
		});
		worker.on("error", () => {}); // swallow the connection-refused error against the dead port
		const shutdown = process.listeners("SIGTERM").find((l) => !beforeTerm.has(l));
		assert.ok(shutdown, "createWorker must register a SIGTERM shutdown handler");
		await shutdown();
		assert.equal(closed, true, "extraCloser.close() must run during shutdown");
	} finally {
		process.exit = origExit;
		for (const l of process.listeners("SIGTERM")) if (!beforeTerm.has(l)) process.removeListener("SIGTERM", l);
		for (const l of process.listeners("SIGINT")) if (!beforeInt.has(l)) process.removeListener("SIGINT", l);
		await Promise.resolve(worker?.close()).catch(() => {});
	}
});
