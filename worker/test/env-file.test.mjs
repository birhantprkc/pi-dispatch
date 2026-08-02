import { test } from "node:test";
import assert from "node:assert/strict";
import { setEnvKeyIfEmpty, updateEnvFile } from "../src/env-file.mjs";

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
