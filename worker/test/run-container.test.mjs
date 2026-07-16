import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

// run-container imports env-allowlist -> @earendil-works/pi-ai, so this skips below the node floor
// and runs in CI (PI_DISPATCH_REQUIRE_WORKER_TESTS=1 makes a skip a hard failure).
let mod;
let importError;
try {
	mod = await import("../src/run-container.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`run-container tests are REQUIRED here but pi-ai could not import.\n${importError}`);
}
const skip = mod ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;

const HOST = { ANTHROPIC_API_KEY: "sk-real" };
const JOB = { kind: "local", provider: "anthropic", model: "m", maxTurns: 5 };
const PREPARED = { workspace: "/host/folder", jobDir: "/host/jobs/j1" };

/** A fake `docker` child: records argv, lets the test drive its exit. */
function fakeSpawn(recorder, exitCode = 0) {
	return (cmd, args) => {
		recorder.cmd = cmd;
		recorder.args = args;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		queueMicrotask(() => child.emit("close", exitCode));
		return child;
	};
}

test("an already-aborted signal returns 137 and NEVER spawns docker", { skip }, async () => {
	const rec = {};
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn(rec) });
	const ac = new AbortController();
	ac.abort();
	const code = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: ac.signal });
	assert.equal(code, 137);
	assert.equal(rec.cmd, undefined, "no container may start once the timeout has fired");
});

test("launches docker with the isolation argv and returns the container's exit code", { skip }, async () => {
	const rec = {};
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn(rec, 2) });
	const code = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	assert.equal(code, 2, "exit 2 (policy) is a normal outcome, not an error to reject on");
	assert.equal(rec.cmd, "docker");
	assert.ok(rec.args.includes("--cap-drop=ALL"), "isolation flags present");
	assert.ok(rec.args.includes("/host/jobs/j1:/job:ro"), "whole /job mounted read-only");
	assert.ok(rec.args.includes("/host/folder:/workspace"), "the folder is the workspace");
	assert.ok(rec.args.includes("ANTHROPIC_API_KEY=sk-real"), "the provider key is forwarded");
});

test("exit 1 (infra) is returned, not thrown -- it is retryable, not a spawn error", { skip }, async () => {
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn({}, 1) });
	const code = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	assert.equal(code, 1);
});

test("refuses before spawning if the provider is unconfigured (pre-spend guard)", { skip }, async () => {
	const rec = {};
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: {}, spawnFn: fakeSpawn(rec) });
	await assert.rejects(
		() => runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal }),
		(e) => e.piDispatchConfig === true,
	);
	assert.equal(rec.cmd, undefined, "no container for an unconfigured provider");
});
