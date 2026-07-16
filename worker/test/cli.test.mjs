import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.mjs";

// cli.mjs dynamic-imports bullmq (in the `run` enqueue and `worker` paths), so the VALIDATION
// paths -- which return before any enqueue -- run everywhere. That is exactly the safety surface
// worth testing: nothing should reach the queue if the inputs are bad.

const env = { VALKEY_URL: "redis://127.0.0.1:6399" };

test("no args prints usage and exits 0", async () => {
	assert.equal(await main([], env), 0);
});

test("an unknown command exits 1", async () => {
	assert.equal(await main(["frobnicate"], env), 1);
});

test("run with no folder fails", async () => {
	assert.equal(await main(["run"], env), 1);
});

test("run with a missing folder fails before touching the queue", async () => {
	assert.equal(await main(["run", "/no/such/folder", "--task", "x"], env), 1);
});

test("run with no --task fails", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cli-"));
	assert.equal(await main(["run", dir, "--flow", "tidy"], env), 1);
});

function gitRepo({ dirty }) {
	const dir = mkdtempSync(join(tmpdir(), "cli-git-"));
	const g = (args) =>
		execFileSync("git", ["-C", dir, ...args], {
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
	g(["init", "-q"]);
	g(["config", "core.autocrlf", "false"]);
	writeFileSync(join(dir, "f.txt"), "one\n");
	g(["add", "-A"]);
	g(["commit", "-qm", "init"]);
	if (dirty) writeFileSync(join(dir, "f.txt"), "one\ntwo\n"); // uncommitted change
	return dir;
}

test("run refuses a dirty git working tree (edits are in place, no undo)", async () => {
	const dir = gitRepo({ dirty: true });
	assert.equal(await main(["run", dir, "--task", "x"], env), 1);
});

test("--force overrides the dirty-tree refusal (reaches the enqueue, which needs Valkey)", async () => {
	// Without Valkey the enqueue will throw; we only assert the guard did NOT stop it (it got past
	// validation). If a Valkey is present it returns 0. Either way it must not return 1-from-guard.
	const dir = gitRepo({ dirty: true });
	let reachedEnqueue = false;
	try {
		const code = await main(["run", dir, "--task", "x", "--force"], env);
		reachedEnqueue = code === 0; // Valkey present
	} catch {
		reachedEnqueue = true; // tried to connect => passed the guard
	}
	assert.ok(reachedEnqueue, "--force must let a dirty tree through to the enqueue");
});
