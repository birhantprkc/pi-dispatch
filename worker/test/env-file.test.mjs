import { test } from "node:test";
import assert from "node:assert/strict";
import { setEnvKey, setEnvKeyIfEmpty, updateEnvFile } from "../src/env-file.mjs";

// -- setEnvKeyIfEmpty: pure transform, table-driven over the text shapes it must handle ---------------
//
// `expected: null` means "byte-identical input back" — asserted by identity (===), because the wrapper
// relies on identity to skip the write entirely, and a re-serialized equal COPY would defeat that.

const cases = [
	{
		name: "empty value is filled in place",
		text: "A=1\nWEBHOOK_SECRET=\nB=2\n",
		expected: "A=1\nWEBHOOK_SECRET=s3cr3t\nB=2\n",
	},
	{
		name: "whitespace around = and a whitespace-only value still count as empty",
		text: "A=1\nWEBHOOK_SECRET =   \nB=2\n",
		expected: "A=1\nWEBHOOK_SECRET=s3cr3t\nB=2\n",
	},
	{
		name: "a commented line is uncommented in place when no set line exists",
		text: "A=1\n# WEBHOOK_SECRET=\nB=2\n",
		expected: "A=1\nWEBHOOK_SECRET=s3cr3t\nB=2\n",
	},
	{
		name: "a commented line without the space after # also counts",
		text: "#WEBHOOK_SECRET=old-note\nB=2\n",
		expected: "WEBHOOK_SECRET=s3cr3t\nB=2\n",
	},
	{
		name: "no trace of the key appends at the end",
		text: "A=1\nB=2\n",
		expected: "A=1\nB=2\nWEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "appending to text without a trailing newline first completes the last line",
		text: "A=1",
		expected: "A=1\nWEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "appending to empty text yields just the one line",
		text: "",
		expected: "WEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "an already-set value is NEVER clobbered",
		text: "A=1\nWEBHOOK_SECRET=operator-chose-this\nB=2\n",
		expected: null,
	},
	{
		name: "an empty set line wins over a commented duplicate (the comment stays a comment)",
		text: "# WEBHOOK_SECRET=doc note\nWEBHOOK_SECRET=\n",
		expected: "# WEBHOOK_SECRET=doc note\nWEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "a non-empty set line wins over a later empty one (the key IS set)",
		text: "WEBHOOK_SECRET=real\nWEBHOOK_SECRET=\n",
		expected: null,
	},
	{
		name: "ambiguity resolves to untouched: a value that is only a trailing comment counts as set",
		text: "WEBHOOK_SECRET= # tbd\n",
		expected: null,
	},
	{
		name: "a key that merely prefixes another name does not match it",
		text: "WEBHOOK_SECRET_OLD=x\n",
		expected: "WEBHOOK_SECRET_OLD=x\nWEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "CRLF endings survive on the replaced line and everywhere else",
		text: "A=1\r\nWEBHOOK_SECRET=\r\nB=2\r\n",
		expected: "A=1\r\nWEBHOOK_SECRET=s3cr3t\r\nB=2\r\n",
	},
	{
		name: "surrounding comments and blank lines are preserved byte-for-byte",
		text: "# header comment\n\nA=1   \n# trailing note\nWEBHOOK_SECRET=\n\n# footer\n",
		expected: "# header comment\n\nA=1   \n# trailing note\nWEBHOOK_SECRET=s3cr3t\n\n# footer\n",
	},
];

for (const { name, text, expected } of cases) {
	test(`setEnvKeyIfEmpty: ${name}`, () => {
		const result = setEnvKeyIfEmpty(text, "WEBHOOK_SECRET", "s3cr3t");
		if (expected === null) {
			assert.equal(result, text, "unchanged means the INPUT text back, identically");
		} else {
			assert.equal(result, expected);
		}
	});
}

test("setEnvKeyIfEmpty: the unchanged case returns the same string object (identity, not just equality)", () => {
	const text = "WEBHOOK_SECRET=set\n";
	assert.ok(setEnvKeyIfEmpty(text, "WEBHOOK_SECRET", "x") === text);
});

// -- setEnvKey: the consented-overwrite sibling — same line mechanics, opposite value discipline ------
//
// Same table convention: `expected: null` means "byte-identical input back", asserted by identity,
// because the wrapper skips the write on identity exactly as it does for the sibling.

const overwriteCases = [
	{
		name: "an existing set value IS replaced (the whole point of the sibling)",
		text: "A=1\nGITHUB_AUTH_SOURCE=gh\nB=2\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\nGITHUB_AUTH_SOURCE=app\nB=2\n",
	},
	{
		name: "an empty set line is filled in place",
		text: "A=1\nGITHUB_AUTH_SOURCE=\nB=2\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\nGITHUB_AUTH_SOURCE=app\nB=2\n",
	},
	{
		name: "whitespace around = is normalised to the canonical line",
		text: "GITHUB_AUTH_SOURCE = gh\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "GITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "a commented line is uncommented in place when no set line exists",
		text: "A=1\n# GITHUB_AUTH_SOURCE=gh\nB=2\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\nGITHUB_AUTH_SOURCE=app\nB=2\n",
	},
	{
		name: "no trace of the key appends at the end",
		text: "A=1\nB=2\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\nB=2\nGITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "appending to text without a trailing newline first completes the last line",
		text: "A=1",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\nGITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "appending to empty text yields just the one line",
		text: "",
		key: "GITHUB_AUTH_SOURCE",
		expected: "GITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "the FIRST set line wins; a later duplicate is left as it was",
		text: "GITHUB_AUTH_SOURCE=gh\nGITHUB_AUTH_SOURCE=pat\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "GITHUB_AUTH_SOURCE=app\nGITHUB_AUTH_SOURCE=pat\n",
	},
	{
		name: "a set line wins over a commented duplicate wherever the comment sits (the comment stays a comment)",
		text: "# GITHUB_AUTH_SOURCE=doc note\nGITHUB_AUTH_SOURCE=gh\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "# GITHUB_AUTH_SOURCE=doc note\nGITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "already exactly KEY=value is a no-op (identity)",
		text: "A=1\nGITHUB_AUTH_SOURCE=app\nB=2\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: null,
	},
	{
		name: "a key that merely prefixes another name does not match it",
		text: "GITHUB_AUTH_SOURCE_OLD=x\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "GITHUB_AUTH_SOURCE_OLD=x\nGITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "CRLF endings survive on the replaced line and everywhere else",
		text: "A=1\r\nGITHUB_AUTH_SOURCE=gh\r\nB=2\r\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\r\nGITHUB_AUTH_SOURCE=app\r\nB=2\r\n",
	},
	{
		name: "an already-exact line in a CRLF file is still a no-op (the \\r tail is not a difference)",
		text: "GITHUB_AUTH_SOURCE=app\r\nB=2\r\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: null,
	},
	{
		name: "surrounding comments and blank lines are preserved byte-for-byte",
		text: "# header\n\nA=1   \n# note\nGITHUB_AUTH_SOURCE=gh\n\n# footer\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "# header\n\nA=1   \n# note\nGITHUB_AUTH_SOURCE=app\n\n# footer\n",
	},
];

for (const { name, text, key, expected } of overwriteCases) {
	test(`setEnvKey: ${name}`, () => {
		const result = setEnvKey(text, key, "app");
		if (expected === null) {
			assert.equal(result, text, "unchanged means the INPUT text back, identically");
		} else {
			assert.equal(result, expected);
		}
	});
}

test("setEnvKey: the already-exact case returns the same string object (identity, not just equality)", () => {
	const text = "GITHUB_AUTH_SOURCE=app\n";
	assert.ok(setEnvKey(text, "GITHUB_AUTH_SOURCE", "app") === text);
});

// -- updateEnvFile: the thin fs wrapper — atomicity (tmp + rename) and mode preservation ---------------

// A recording fake fs over one in-memory file. `ops` captures every call in order so tests can assert
// the write is tmp-then-rename and never a direct write to the destination.
function fakeFs(path, text, mode = 0o644) {
	const files = new Map([[path, text]]);
	const ops = [];
	return {
		files,
		ops,
		fs: {
			readFileSync: (p) => {
				ops.push(["read", p]);
				return files.get(p);
			},
			writeFileSync: (p, data) => {
				ops.push(["write", p, data]);
				files.set(p, data);
			},
			renameSync: (from, to) => {
				ops.push(["rename", from, to]);
				files.set(to, files.get(from));
				files.delete(from);
			},
			statSync: (p) => {
				ops.push(["stat", p]);
				return { mode: 0o100000 | mode };
			},
			chmodSync: (p, m) => {
				ops.push(["chmod", p, m]);
			},
		},
	};
}

test("updateEnvFile: writes the tmp file first, then renames it over the destination", () => {
	const { fs, files, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=\n");
	const result = updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs });
	assert.deepEqual(result, { changed: true });
	assert.equal(files.get("/deploy/.env"), "WEBHOOK_SECRET=abc123\n");
	const writes = ops.filter(([op]) => op === "write");
	assert.deepEqual(writes, [["write", "/deploy/.env.tmp", "WEBHOOK_SECRET=abc123\n"]], "content lands on the tmp path only");
	assert.ok(
		ops.findIndex(([op]) => op === "write") < ops.findIndex(([op]) => op === "rename"),
		"rename happens after the write",
	);
	assert.deepEqual(ops.at(-1), ["rename", "/deploy/.env.tmp", "/deploy/.env"]);
});

test("updateEnvFile: an already-set key writes NOTHING — no tmp, no rename, no mtime churn", () => {
	const { fs, files, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=keep-me\n");
	const result = updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs });
	assert.deepEqual(result, { changed: false });
	assert.equal(files.get("/deploy/.env"), "WEBHOOK_SECRET=keep-me\n");
	assert.deepEqual(ops, [["read", "/deploy/.env"]], "the file is read once and never touched");
});

test("updateEnvFile: a 0600 .env stays 0600 — chmod on the tmp BEFORE the rename", () => {
	const { fs, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=\n", 0o600);
	updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs });
	const chmodIdx = ops.findIndex(([op]) => op === "chmod");
	assert.notEqual(chmodIdx, -1, "the tmp is chmodded");
	assert.deepEqual(ops[chmodIdx], ["chmod", "/deploy/.env.tmp", 0o600]);
	assert.ok(chmodIdx < ops.findIndex(([op]) => op === "rename"), "no window where the renamed file is wider than 0600");
});

test("updateEnvFile: any other mode is left alone (no chmod call at all)", () => {
	const { fs, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=\n", 0o644);
	updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs });
	assert.equal(ops.filter(([op]) => op === "chmod").length, 0);
});

// -- updateEnvFile { overwrite }: which transform runs is the ONLY difference — atomicity is shared ----

test("updateEnvFile: overwrite:true replaces a set value, still via tmp + rename", () => {
	const { fs, files, ops } = fakeFs("/deploy/.env", "GITHUB_AUTH_SOURCE=gh\n");
	const result = updateEnvFile("/deploy/.env", "GITHUB_AUTH_SOURCE", "app", { fs, overwrite: true });
	assert.deepEqual(result, { changed: true });
	assert.equal(files.get("/deploy/.env"), "GITHUB_AUTH_SOURCE=app\n");
	assert.deepEqual(ops.filter(([op]) => op === "write"), [["write", "/deploy/.env.tmp", "GITHUB_AUTH_SOURCE=app\n"]], "content lands on the tmp path only");
	assert.deepEqual(ops.at(-1), ["rename", "/deploy/.env.tmp", "/deploy/.env"]);
});

test("updateEnvFile: the default (overwrite absent) keeps the never-clobber discipline", () => {
	const { fs, files } = fakeFs("/deploy/.env", "GITHUB_AUTH_SOURCE=gh\n");
	const result = updateEnvFile("/deploy/.env", "GITHUB_AUTH_SOURCE", "app", { fs });
	assert.deepEqual(result, { changed: false }, "without the explicit overwrite opt-in, a set value stays sacrosanct");
	assert.equal(files.get("/deploy/.env"), "GITHUB_AUTH_SOURCE=gh\n");
});

test("updateEnvFile: overwrite:true onto an already-exact line writes NOTHING (identity short-circuit)", () => {
	const { fs, files, ops } = fakeFs("/deploy/.env", "GITHUB_AUTH_SOURCE=app\n");
	const result = updateEnvFile("/deploy/.env", "GITHUB_AUTH_SOURCE", "app", { fs, overwrite: true });
	assert.deepEqual(result, { changed: false });
	assert.equal(files.get("/deploy/.env"), "GITHUB_AUTH_SOURCE=app\n");
	assert.deepEqual(ops, [["read", "/deploy/.env"]], "the file is read once and never touched");
});
