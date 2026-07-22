import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareLocalWorkspace } from "../src/prepare-local.mjs";

function git(dir, args) {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
}

/** A local git repo with a .pi/ persona and skill, plus a working-tree file to "edit". */
function localRepo() {
	const dir = mkdtempSync(join(tmpdir(), "pi-local-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "core.autocrlf", "false"]);
	const blob = (c) => execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], { input: c, encoding: "utf8" }).trim();
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob("LOCAL-PERSONA-SENTINEL")},.pi/APPEND_SYSTEM.md`]);
	git(dir, [
		"update-index",
		"--add",
		"--cacheinfo",
		`100644,${blob("---\nname: tidy\ndescription: tidy up\n---\nsteps\n")},.pi/skills/tidy/SKILL.md`,
	]);
	// a hostile symlink object, to prove the local path is as safe as the GitHub path
	git(dir, ["update-index", "--add", "--cacheinfo", `120000,${blob("/etc/passwd")},.pi/EVIL.md`]);
	git(dir, ["commit", "-qm", "x"]);
	return dir;
}

test("prepares a local git folder: materialises .pi/ from HEAD, writes the task, folder is /workspace", async () => {
	const folder = localRepo();
	const jobDir = mkdtempSync(join(tmpdir(), "pi-job-"));
	const result = await prepareLocalWorkspace({ folder, task: "please tidy the imports", jobDir });

	assert.equal(result.workspace, folder, "the folder itself is the workspace (edited in place)");
	assert.equal(readFileSync(join(jobDir, "prompt.md"), "utf8"), "please tidy the imports");
	assert.equal(readFileSync(join(jobDir, "pi/APPEND_SYSTEM.md"), "utf8"), "LOCAL-PERSONA-SENTINEL");
	assert.ok(result.materialised.includes("pi/skills/tidy/SKILL.md"));
	// the symlink is NOT materialised -- the local path inherits the git materialiser's safety
	assert.ok(!result.materialised.some((p) => p.includes("EVIL")), "a hostile symlink must not materialise locally either");
});

test("creates a writable /outbox host dir and returns its path (the container's chain-request channel)", async () => {
	const folder = localRepo();
	const jobDir = mkdtempSync(join(tmpdir(), "pi-job-"));
	const result = await prepareLocalWorkspace({ folder, task: "x", jobDir });
	assert.equal(result.outboxDir, join(jobDir, "outbox"), "outboxDir is <jobDir>/outbox");
	assert.ok(existsSync(result.outboxDir), "the outbox dir must exist on disk for the bind mount");
});

test("no GitHub anything: a local job needs no token, no repo, no network", async () => {
	// This test passing at all -- with no octokit, no token, no clone URL -- IS the assertion.
	const folder = localRepo();
	const jobDir = mkdtempSync(join(tmpdir(), "pi-job-"));
	const result = await prepareLocalWorkspace({ folder, task: "x", jobDir });
	assert.ok(result.sha.match(/^[0-9a-f]{40}$/), "resolved HEAD locally, offline");
});

test("a non-git folder is a clear config error, not a crash", async () => {
	const plain = mkdtempSync(join(tmpdir(), "pi-plain-"));
	await assert.rejects(
		() => prepareLocalWorkspace({ folder: plain, task: "x", jobDir: mkdtempSync(join(tmpdir(), "j-")) }),
		(e) => e.piDispatchConfig === true && /not a git repository/.test(e.message),
	);
});

test("a missing folder is a clear config error", async () => {
	await assert.rejects(
		() => prepareLocalWorkspace({ folder: "/does/not/exist/anywhere", task: "x", jobDir: "/tmp/x" }),
		(e) => e.piDispatchConfig === true,
	);
});
