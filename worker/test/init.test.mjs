import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/init.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-init-"));
function capture() {
	const buf = [];
	return { out: (s) => buf.push(s), text: () => buf.join("") };
}

test("init scaffolds the five config files with the empty templates the loaders validate against", () => {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n"); // stand in for the repo's example
	const { out, text } = capture();

	const code = runInit(dir, { out });

	assert.equal(code, 0);
	assert.ok(existsSync(join(dir, ".env")), ".env is copied from the example");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "triggers.json"), "utf8")), { triggers: [] });
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "pause-windows.json"), "utf8")), { windows: [] });
	// Empty by default: staging pins third-party code into every job, so it is opted into package by package.
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "pi-packages.json"), "utf8")), { packages: [] });
	// Versioned from the first byte: a later reader must be able to refuse a newer file loudly (issue #53).
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "subscriptions.json"), "utf8")), { version: 1, subscriptions: [] });
	assert.match(text(), /pi install npm:@edgehero\/pi-dispatch-admin/, "next steps name the operator panel");
});

test("init is idempotent and never overwrites operator edits", () => {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n");
	writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-mine\n"); // already configured
	writeFileSync(join(dir, "triggers.json"), JSON.stringify({ triggers: [{ id: "keep" }] }));
	writeFileSync(join(dir, "pi-packages.json"), JSON.stringify({ packages: [{ name: "@a/b", version: "1.0.0" }] }));
	const { out, text } = capture();

	const code = runInit(dir, { out });

	assert.equal(code, 0);
	assert.equal(readFileSync(join(dir, ".env"), "utf8"), "ANTHROPIC_API_KEY=sk-mine\n", ".env left untouched");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "triggers.json"), "utf8")), { triggers: [{ id: "keep" }] });
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "pi-packages.json"), "utf8")), { packages: [{ name: "@a/b", version: "1.0.0" }] }, "a pinned package list is never overwritten");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "pause-windows.json"), "utf8")), { windows: [] }, "the missing ones are still created");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "subscriptions.json"), "utf8")), { version: 1, subscriptions: [] });
	assert.match(text(), /kept.*\.env/, "an existing file is reported as kept");
});
