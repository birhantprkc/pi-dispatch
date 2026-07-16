import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Every runner source must parse.
 *
 * This exists because of a real bug: a JSDoc line reading "the no*​/else branches" closed
 * its own block comment, turning prose into code. loader.mjs stopped parsing, and nothing
 * local caught it -- the pure tests do not import that file, and the tests that do cannot
 * run here because pi needs a newer node than this machine has. It failed in CI instead.
 *
 * `node --check` needs no dependencies and no particular node version, so unlike the loader
 * assertions this runs EVERYWHERE. Cheap, total, and it would have caught it in a second.
 */
const runnerRoot = fileURLToPath(new URL("..", import.meta.url));

function collect(dir, found = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) collect(path, found);
		else if (entry.endsWith(".mjs")) found.push(path);
	}
	return found;
}

const sources = collect(runnerRoot);

test("there are sources to check", () => {
	assert.ok(sources.length >= 4, `expected runner sources, found ${sources.length}`);
});

for (const source of sources) {
	test(`parses: ${source.slice(runnerRoot.length).replace(/\\/g, "/")}`, () => {
		// --check parses without executing or resolving imports, so it works with zero deps.
		execFileSync(process.execPath, ["--check", source], { stdio: "pipe" });
	});
}
