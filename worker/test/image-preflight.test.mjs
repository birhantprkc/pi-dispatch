import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { FIELD_SEP, makeImagePreflight, resolveJobImage } from "../src/image-preflight.mjs";

// No skip guard, deliberately: unlike run-container.mjs this module imports nothing but node:child_process,
// and it decides whether a budget slot is spent. A money gate must not have skippable tests.

/**
 * A fake `docker` that records each argv and exits with the code the plan gives for that subcommand.
 * `plan` is keyed on the first arg ("image" | "info"); a missing key means "not launchable" (error event),
 * which is how a docker binary that is not on PATH behaves.
 */
function fakeSpawn(calls, plan, stdout = "") {
	return (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		const child = new EventEmitter();
		// The inspect probe captures stdout (it carries the pi-version label); `docker info` deliberately
		// does not, so only wire a stream when the caller asked to pipe one.
		if (opts?.stdio?.[1] === "pipe") {
			const out = new EventEmitter();
			out.setEncoding = () => {};
			child.stdout = out;
			queueMicrotask(() => out.emit("data", stdout));
		}
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
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn(calls, { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7\n`) });
	assert.deepEqual(await preflight({}), { ok: true, image: "pi-job:latest", piVersion: "0.80.7" });
	// The `docker info` disambiguation runs ONLY on the failure path. Every job pays this check, so the
	// happy path must not pay for the diagnosis of a case it is not in. The pi-version label rides this
	// same inspect for the same reason -- a second spawn would have doubled what every job pays.
	assert.equal(calls.length, 1, "the happy path does not probe the daemon a second time");
	assert.deepEqual(calls[0].args, [
		"image",
		"inspect",
		`--format={{.Id}}${FIELD_SEP}{{index .Config.Labels "dev.pi-dispatch.pi-version"}}${FIELD_SEP}{{index .Config.Labels "dev.pi-dispatch.forges"}}`,
		"pi-job:latest",
	]);
});

test("an image that declares no pi version reports null, which downstream means never resume", async () => {
	// Go's text/template renders a missing map key as the literal "<no value>". An operator-built image
	// (OQ-012) that omits the label must run cold rather than resume into a pi whose tool schemas may have
	// moved -- null is the SAFE answer here, never "assume it matches".
	for (const out of [`sha256:abc${FIELD_SEP}<no value>\n`, `sha256:abc${FIELD_SEP}\n`, "sha256:abc\n", "", "   "]) {
		const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, out) });
		assert.deepEqual(await preflight({}), { ok: true, image: "i", piVersion: null }, `stdout ${JSON.stringify(out)} must not become a version`);
	}
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

test("a job whose forge the image excludes is refused PRE-SPEND, with no container and no budget slot", async () => {
	// `run.image` is optional, so a trigger for a forge whose CLI the default image does not ship would
	// otherwise run there, find no such command, and fail INSIDE a paid container -- on every delivery,
	// looking exactly like a bad agent run rather than a missing tool.
	const calls = [];
	const preflight = makeImagePreflight({
		image: "pi-job:latest",
		spawnFn: fakeSpawn(calls, { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github,gitlab,forgejo\n`),
	});
	const r = await preflight({ kind: "azure" });
	assert.equal(r.forgeUnsupported, "pi-job:latest");
	assert.equal(r.kind, "azure");
	assert.deepEqual(r.declared, ["github", "gitlab", "forgejo"]);
	assert.equal(calls.length, 1, "one inspect, and nothing else -- the refusal costs no second spawn");
});

test("a job whose forge the image DOES declare runs, and the label rides the same single inspect", async () => {
	const calls = [];
	const preflight = makeImagePreflight({
		image: "i",
		spawnFn: fakeSpawn(calls, { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github,gitlab,forgejo\n`),
	});
	for (const kind of ["github", "gitlab", "forgejo"]) {
		assert.deepEqual(await preflight({ kind }), { ok: true, image: "i", piVersion: "0.80.7" }, kind);
	}
	assert.equal(calls.length, 3, "one spawn per call, still -- the forge list is a second field, not a second probe");
});

test("an image declaring NO forges admits every job -- absent is allowed, not refused", async () => {
	// The polarity is the opposite of what "declare your capabilities" suggests, and deliberately so: every
	// operator-built image predating this label (OQ-012) declares nothing, and refusing those would break
	// working deployments with no warning first. Only a PRESENT list that excludes the forge refuses.
	for (const out of [`sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}<no value>\n`, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}\n`, `sha256:abc${FIELD_SEP}0.80.7\n`, "sha256:abc\n", ""]) {
		const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, out) });
		const r = await preflight({ kind: "azure" });
		assert.equal(r.ok, true, `stdout ${JSON.stringify(out)} must admit, not refuse`);
	}
});

test("a malformed forges label is treated as absent, not as 'serves no forge'", async () => {
	// Refusing every job on an image whose label was merely mistyped would be a worse failure than the one
	// the label exists to prevent.
	const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP} , ,\n`) });
	assert.equal((await preflight({ kind: "github" })).ok, true);
});

test("a local job is never refused on forge grounds -- it has no forge to check", async () => {
	const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github\n`) });
	assert.equal((await preflight({ kind: "local" })).ok, true);
	assert.equal((await preflight({})).ok, true, "and neither is a job whose kind is not set at all");
});

test("the pi version still parses now that a third field follows it", async () => {
	const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github\n`) });
	assert.equal((await preflight({ kind: "github" })).piVersion, "0.80.7");
});
