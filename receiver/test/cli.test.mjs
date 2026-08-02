import assert from "node:assert/strict";
import { test } from "node:test";
import { entryExitCode, main } from "../src/cli.mjs";

// Every test injects the `start` seam in place of the dynamic import of ./start.mjs, so this suite
// never resolves identity, opens a socket, or touches Valkey -- the same posture as config.test.mjs
// injecting the filesystem. The seam that must NOT fire (help/unknown paths) is an assert.fail trap,
// so a dispatch regression that boots the receiver fails loudly instead of hanging the runner on a
// live server.

/** Capture everything main writes to stdout, restoring the real writer even on a failing assertion. */
async function withStdout(fn) {
	const written = [];
	const real = process.stdout.write;
	process.stdout.write = (chunk) => {
		written.push(String(chunk));
		return true;
	};
	try {
		return { result: await fn(), out: written.join("") };
	} finally {
		process.stdout.write = real;
	}
}

test("no args means serve: startReceiver gets the bin's env and the bin returns 0", async () => {
	const calls = [];
	const env = { WEBHOOK_SECRET: "shh" };
	const start = async (e) => {
		calls.push(e);
		return { fake: "server" };
	};
	assert.equal(await main([], env, { start }), 0, "the server keeps the process alive; the promise itself resolves 0");
	assert.equal(calls.length, 1);
	assert.equal(calls[0], env, "the receiver boots from the env main was handed, never an ambient process.env");
});

test("`serve` is the same path as no args, spelled out", async () => {
	const calls = [];
	const start = async (e) => calls.push(e);
	assert.equal(await main(["serve"], {}, { start }), 0);
	assert.equal(calls.length, 1);
});

test("--help and -h print usage and exit 0 without booting the receiver", async () => {
	for (const flag of ["--help", "-h"]) {
		const { result, out } = await withStdout(() => main([flag], {}, { start: async () => assert.fail("help must not boot the receiver") }));
		assert.equal(result, 0, `${flag}: asked-for help is success`);
		assert.match(out, /pi-dispatch-receiver/);
		assert.match(out, /WEBHOOK_SECRET/, "usage names where config comes from, so help is actionable");
	}
});

test("an unknown command prints usage and exits 1 (a typo is not success)", async () => {
	const { result, out } = await withStdout(() => main(["frobnicate"], {}, { start: async () => assert.fail("an unknown command must not boot the receiver") }));
	assert.equal(result, 1);
	assert.match(out, /pi-dispatch-receiver serve/);
});

test("a config error thrown by startReceiver escapes main untouched -- the entry guard owns the mapping", async () => {
	// The bin adds no try/catch of its own: start.mjs's HARD-FAIL boot invariants (identity, config)
	// must propagate as rejections, and the entry maps the tagged ones to EXIT_POLICY below.
	const tagged = Object.assign(new Error("WEBHOOK_SECRET is required"), { piDispatchConfig: true });
	await assert.rejects(
		main([], {}, { start: async () => { throw tagged; } }),
		(e) => e === tagged,
	);
	assert.equal(entryExitCode(tagged), 2, "a determinate config refusal exits 2, so a supervisor never restart-loops it");
});

test("entryExitCode maps a tagged config error to EXIT_POLICY (2), everything else to 1", () => {
	// Mirrors worker/test/cli-control.test.mjs: this mapping IS the bin's exit-code protocol.
	assert.equal(entryExitCode({ piDispatchConfig: true }), 2);
	assert.equal(entryExitCode(new Error("x")), 1);
	assert.equal(entryExitCode(undefined), 1);
});
