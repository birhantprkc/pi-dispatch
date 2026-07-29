import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { makeImagePreflight, resolveJobImage } from "../src/image-preflight.mjs";

// No skip guard, deliberately: unlike run-container.mjs this module imports nothing but node:child_process,
// and it decides whether a budget slot is spent. A money gate must not have skippable tests.

/**
 * A fake `docker` that records each argv and exits with the code the plan gives for that subcommand.
 * `plan` is keyed on the first arg ("image" | "info"); a missing key means "not launchable" (error event),
 * which is how a docker binary that is not on PATH behaves.
 */
function fakeSpawn(calls, plan) {
	return (cmd, args) => {
		calls.push({ cmd, args });
		const child = new EventEmitter();
		const code = plan[args[0]];
		queueMicrotask(() => (code === undefined ? child.emit("error", new Error("ENOENT")) : child.emit("close", code)));
		return child;
	};
}

test("resolveJobImage prefers the job's own image and falls back to the deployment default", () => {
	assert.equal(resolveJobImage({ image: "my-python:1.2.0" }, "pi-job:latest"), "my-python:1.2.0");
	assert.equal(resolveJobImage({}, "pi-job:latest"), "pi-job:latest", "a job that names none runs the deployment default");
	assert.equal(resolveJobImage(undefined, "pi-job:latest"), "pi-job:latest", "and a jobless call still resolves");
});

test("an image that inspects clean is ok, and costs exactly ONE spawn", async () => {
	const calls = [];
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn(calls, { image: 0, info: 0 }) });
	assert.deepEqual(await preflight({}), { ok: true, image: "pi-job:latest" });
	// The `docker info` disambiguation runs ONLY on the failure path. Every job pays this check, so the
	// happy path must not pay for the diagnosis of a case it is not in.
	assert.equal(calls.length, 1, "the happy path does not probe the daemon a second time");
	assert.deepEqual(calls[0].args, ["image", "inspect", "--format={{.Id}}", "pi-job:latest"]);
});

test("a missing image with a live daemon is {missing}, disambiguated by docker info", async () => {
	const calls = [];
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn(calls, { image: 1, info: 0 }) });
	assert.deepEqual(await preflight({}), { missing: "pi-job:latest" });
	assert.deepEqual(
		calls.map((c) => c.args[0]),
		["image", "info"],
		"a non-zero inspect is ambiguous, so the daemon is confirmed POSITIVELY rather than by matching docker's stderr",
	);
});

test("a down daemon is {unavailable}, never {missing} -- a transient fault must not become a permanent refusal", async () => {
	// Both probes exit non-zero: an absent image and an unreachable daemon are indistinguishable from the
	// inspect alone, and calling this one `missing` would refuse the job with no retry over a daemon blip.
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 1, info: 1 }) });
	assert.deepEqual(await preflight({}), { unavailable: "pi-job:latest" });
});

test("a docker binary that cannot be launched at all is {unavailable}", async () => {
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], {}) });
	assert.deepEqual(await preflight({}), { unavailable: "pi-job:latest" }, "no docker is no answer, not a verdict about the image");

	// The synchronous-throw form of the same fault (spawn itself throwing, not emitting `error`).
	const throwing = makeImagePreflight({
		image: "pi-job:latest",
		spawnFn: () => {
			throw new Error("EPERM");
		},
	});
	assert.deepEqual(await throwing({}), { unavailable: "pi-job:latest" });
});

test("the preflight checks the JOB's image, not the deployment default", async () => {
	const calls = [];
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn(calls, { image: 1, info: 0 }) });
	assert.deepEqual(await preflight({ image: "my-python:1.2.0" }), { missing: "my-python:1.2.0" }, "the refusal names the tag the job asked for");
	assert.ok(calls[0].args.includes("my-python:1.2.0"), "and the tag it inspected is the one it will run");
});
