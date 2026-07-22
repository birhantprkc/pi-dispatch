import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitDirty } from "../src/git-dirty.mjs";

// --- against a REAL git repo: the dirty/clean/not-a-repo contract ---

function gitRepo({ dirty }) {
	const dir = mkdtempSync(join(tmpdir(), "gd-git-"));
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

test("a clean working tree -> false", () => {
	assert.equal(gitDirty(gitRepo({ dirty: false })), false);
});

test("a dirty working tree -> true", () => {
	assert.equal(gitDirty(gitRepo({ dirty: true })), true);
});

test("a non-git folder -> null", () => {
	assert.equal(gitDirty(mkdtempSync(join(tmpdir(), "gd-plain-"))), null);
});

// --- injected exec unit cases: no real git needed ---

test("injected exec: nonempty porcelain output -> true", () => {
	assert.equal(gitDirty("/any", { exec: () => " M f.txt\n" }), true);
});

test("injected exec: empty or whitespace-only output -> false", () => {
	assert.equal(gitDirty("/any", { exec: () => "" }), false);
	assert.equal(gitDirty("/any", { exec: () => "   \n" }), false);
});

test("injected exec: a throwing exec (not a repo) -> null", () => {
	assert.equal(
		gitDirty("/any", {
			exec: () => {
				throw new Error("fatal: not a git repository");
			},
		}),
		null,
	);
});

test("injected exec receives the porcelain status args for the folder", () => {
	let received;
	gitDirty("/some/folder", {
		exec: (bin, args) => {
			received = { bin, args };
			return "";
		},
	});
	assert.equal(received.bin, "git");
	assert.deepEqual(received.args, ["-C", "/some/folder", "status", "--porcelain"]);
});
