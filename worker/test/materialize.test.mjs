import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyPiPath, isAllowedPiPath, materializePiDir, selectEntries } from "../src/materialize.mjs";

// --- pure selection logic: runs everywhere ---

test("isAllowedPiPath accepts exactly the persona and skill shapes", () => {
	assert.ok(isAllowedPiPath(".pi/APPEND_SYSTEM.md"));
	assert.ok(isAllowedPiPath(".pi/skills/bug-fix/SKILL.md"));
	assert.ok(isAllowedPiPath(".pi/skills/bug_fix2/SKILL.md"));
	assert.ok(!isAllowedPiPath(".pi/skills/bug-fix/notes.md"));
	assert.ok(!isAllowedPiPath(".pi/settings.json"));
	assert.ok(!isAllowedPiPath(".pi/APPEND_SYSTEM.md.evil"));
});

test("a skill name that could express traversal is rejected -- git ls-tree can emit `..` segments", () => {
	// gitshow-research: git does not sanitise tree-entry names, so ls-tree can report a path with
	// literal ../ in it. The name charset (no dots, no slashes) makes traversal impossible here.
	assert.equal(classifyPiPath(".pi/skills/../SKILL.md"), null);
	assert.equal(classifyPiPath(".pi/skills/../../etc/SKILL.md"), null);
	assert.equal(classifyPiPath(".pi/skills/a.b/SKILL.md"), null); // dots barred (no `..`)
	assert.equal(classifyPiPath(".pi/skills/UPPER/SKILL.md"), null); // case-sensitive, JS regex
});

test("the destination is built from a fixed template, never the raw git path", () => {
	assert.deepEqual(classifyPiPath(".pi/skills/bug-fix/SKILL.md"), { outRel: "pi/skills/bug-fix/SKILL.md" });
	assert.deepEqual(classifyPiPath(".pi/APPEND_SYSTEM.md"), { outRel: "pi/APPEND_SYSTEM.md" });
});

test("selectEntries rejects symlinks (120000), submodules (160000), and executables (100755)", () => {
	const z = [
		"100644 blob aaa\t.pi/APPEND_SYSTEM.md",
		"120000 blob bbb\t.pi/EVIL_SYMLINK.md", // symlink -> host file
		"160000 commit ccc\t.pi/skills/sub", // submodule
		"100755 blob ddd\t.pi/skills/x/SKILL.md", // executable bit set
		"100644 blob eee\t.pi/skills/good/SKILL.md",
	].join("\0");
	const picked = selectEntries(z).map((e) => e.path);
	assert.deepEqual(picked, [".pi/APPEND_SYSTEM.md", ".pi/skills/good/SKILL.md"]);
});

// --- integration against a REAL git repo with REAL hostile objects ---

function git(dir, args) {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** A repo whose .pi/ contains a genuine symlink object and a submodule gitlink, plus real files. */
function hostileRepo() {
	const dir = mkdtempSync(join(tmpdir(), "pi-mat-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "t@t"]);
	git(dir, ["config", "user.name", "t"]);
	git(dir, ["config", "core.autocrlf", "false"]);

	const blob = (content) =>
		execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], { input: content, encoding: "utf8" }).trim();

	const persona = blob("REAL-PERSONA-SENTINEL");
	const skill = blob("---\nname: good\ndescription: real\n---\nsteps\n");
	const evilTarget = blob("/etc/passwd"); // the symlink's blob content = its target path

	// Build the tree entirely through the index -- creates a genuine 120000 symlink and 160000
	// gitlink without needing OS symlink privilege (which Windows dev boxes lack).
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${persona},.pi/APPEND_SYSTEM.md`]);
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${skill},.pi/skills/good/SKILL.md`]);
	git(dir, ["update-index", "--add", "--cacheinfo", `120000,${evilTarget},.pi/EVIL_SYMLINK.md`]);
	// A submodule gitlink. git rejects a null sha, so use any valid nonzero oid (the blob's) --
	// update-index does not verify a gitlink points at a real commit, which is all we need here.
	git(dir, ["update-index", "--add", "--cacheinfo", `160000,${persona},.pi/skills/sub`]);
	git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]);
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();
	return { dir, sha };
}

test("materialize writes real files and NEVER the symlink or submodule", async () => {
	const { dir, sha } = hostileRepo();
	const dest = mkdtempSync(join(tmpdir(), "pi-dest-"));

	const written = await materializePiDir({ gitDir: dir, sha, destDir: dest });

	assert.deepEqual(written.sort(), ["pi/APPEND_SYSTEM.md", "pi/skills/good/SKILL.md"].sort());
	assert.equal(readFileSync(join(dest, "pi/APPEND_SYSTEM.md"), "utf8"), "REAL-PERSONA-SENTINEL");

	// The symlink must have produced NOTHING -- not a file containing "/etc/passwd", not anything.
	const flat = JSON.stringify(readdirSync(dest, { recursive: true }));
	assert.ok(!flat.includes("EVIL_SYMLINK"), "the symlink entry was materialised");
	assert.ok(!flat.includes("sub"), "the submodule entry was materialised");

	// And no host-file content leaked in either.
	const allContent = written.map((r) => readFileSync(join(dest, r), "utf8")).join("\n");
	assert.ok(!allContent.includes("root:x:0:0"), "host /etc/passwd content leaked into the prompt");
	assert.ok(!allContent.includes("/etc/passwd"), "symlink target path leaked into the prompt");
});

test("a repo with no .pi/ materialises nothing (guardrails-only job), no error", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-empty-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "t@t"]);
	git(dir, ["config", "user.name", "t"]);
	execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "x"], {
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();
	const dest = mkdtempSync(join(tmpdir(), "pi-dest-"));
	const written = await materializePiDir({ gitDir: dir, sha, destDir: dest });
	assert.deepEqual(written, []);
});
