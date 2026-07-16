import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * REQ-UPSTREAM-CONTRACT-TESTS -- assert against the PINNED ARTIFACT, not against HEAD.
 *
 * This exists because of a real and expensive mistake. Every claim about pi in this
 * project was verified by reading source at `earendil-works/pi @ 5e336cf` -- which is
 * HEAD, not the 0.80.7 release we pin. `ModelRuntime` is a value export in that source
 * and DOES NOT EXIST in 0.80.7 at all: pi's changelog files it under [Unreleased] and
 * the changelog was exactly right. The runner imported it, the image built cleanly, and
 * every job would have died on a missing export.
 *
 * Reading a moving branch to verify a fixed version is not verification. These tests
 * import the package the lockfile actually resolves and assert the symbols exist there,
 * so the next time HEAD and the pin disagree, a test says so instead of a container.
 */
const pkg = "@earendil-works/pi-coding-agent";

let mod;
let importError;
try {
	mod = await import(pkg);
} catch (error) {
	importError = error;
}

const required = process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1";
if (!mod && required) {
	throw new Error(`${pkg} must be importable here; a skip would hide a pin/HEAD mismatch.\n${importError}`);
}
const skip = mod ? false : `pi not installed (node ${process.version} < 22.19.0); CI runs these`;

/** Every value the runner imports at runtime. If pi drops one, the job dies on module load. */
const REQUIRED_VALUE_EXPORTS = [
	"createAgentSession",
	"getAgentDir",
	"AuthStorage",
	"ModelRegistry",
	"SessionManager",
	"SettingsManager",
	"DefaultResourceLoader",
];

test("the pinned package exports everything the runner imports", { skip }, () => {
	const missing = REQUIRED_VALUE_EXPORTS.filter((name) => typeof mod[name] === "undefined");
	assert.deepEqual(missing, [], `pinned ${pkg} is missing value exports the runner needs: ${missing}`);
});

test("model/auth wiring is the 0.80.7 shape, not HEAD's", { skip }, () => {
	// The [Unreleased] migration replaces these two with an async ModelRuntime. When the pin
	// moves past it, THIS fails -- which is the signal to rewrite run-job.mjs's wiring,
	// rather than discovering it when every queued job becomes a no-op.
	assert.equal(typeof mod.AuthStorage?.create, "function", "AuthStorage.create missing");
	assert.equal(typeof mod.ModelRegistry?.create, "function", "ModelRegistry.create missing");
	assert.equal(
		typeof mod.ModelRuntime,
		"undefined",
		"ModelRuntime now EXISTS at the pin -- the [Unreleased] migration shipped. " +
			"Rewrite run-job.mjs to modelRuntime and re-verify sdk.d.ts before bumping.",
	);
});

test("the resource-loader options the instruction model depends on still exist", { skip }, () => {
	// These are asserted behaviourally in loader.test.mjs, but a rename would fail there with
	// a confusing symptom (an empty prompt) rather than a clear one. This names them.
	const loader = Object.getOwnPropertyNames(mod.DefaultResourceLoader?.prototype ?? {});
	for (const method of ["reload", "getAppendSystemPrompt", "getAgentsFiles", "getSkills"]) {
		assert.ok(loader.includes(method), `DefaultResourceLoader.${method} missing at the pin`);
	}
});

test("the runner imports nothing the pinned package does not export", { skip }, () => {
	// Catches a new import added to run-job.mjs that only exists at HEAD -- the exact
	// mistake this file was written for, generalised so it cannot recur silently.
	const source = readFileSync(fileURLToPath(new URL("../run-job.mjs", import.meta.url)), "utf8");
	const block = source.match(/import\s*\{([^}]+)\}\s*from\s*["']@earendil-works\/pi-coding-agent["']/);
	assert.ok(block, "could not find the runner's pi import block");

	const imported = block[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const missing = imported.filter((name) => typeof mod[name] === "undefined");
	assert.deepEqual(missing, [], `run-job.mjs imports symbols absent from the pinned package: ${missing}`);
});
