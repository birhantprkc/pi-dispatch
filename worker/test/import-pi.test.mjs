import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImportPi, findLiteralSecret } from "../src/import-pi.mjs";

function capture() {
	const buf = [];
	return { out: (s) => buf.push(s), text: () => buf.join("") };
}

/** A host ~/.pi/agent fixture with the full surface: safe + secret-bearing + extensions. */
function hostAgent({ models, withAuth = true, withExtensions = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-"));
	if (models !== null) writeFileSync(join(dir, "models.json"), models ?? JSON.stringify({ providers: { anthropic: { name: "Anthropic" } } }));
	mkdirSync(join(dir, "skills", "tidy"), { recursive: true });
	writeFileSync(join(dir, "skills", "tidy", "SKILL.md"), "---\nname: tidy\n---\nTidy up.\n");
	writeFileSync(join(dir, "APPEND_SYSTEM.md"), "Be terse.\n");
	if (withAuth) writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-secret" } }));
	if (withExtensions) {
		mkdirSync(join(dir, "extensions", "my-tool"), { recursive: true });
		writeFileSync(join(dir, "extensions", "my-tool", "index.mjs"), "export default () => {};\n");
		mkdirSync(join(dir, "extensions", "pi-dispatch-admin"), { recursive: true });
		writeFileSync(join(dir, "extensions", "pi-dispatch-admin", "index.mjs"), "export default () => {};\n");
	}
	return dir;
}
const overlayDir = () => mkdtempSync(join(tmpdir(), "pi-overlay-"));
const run = (from, to, extra = [], out) => runImportPi(["--from", from, "--to", to, ...extra], { out });

test("import-pi copies models/skills/persona and NEVER auth.json", () => {
	const from = hostAgent();
	const to = overlayDir();
	const { out } = capture();

	const code = run(from, to, [], out);

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "models.json")), "models.json copied");
	assert.ok(existsSync(join(to, "skills", "tidy", "SKILL.md")), "skill copied");
	assert.ok(existsSync(join(to, "APPEND_SYSTEM.md")), "persona copied");
	assert.equal(existsSync(join(to, "auth.json")), false, "auth.json must NEVER be copied — the credential stays in env");
});

test("import-pi refuses a models.json with a literal key and writes nothing", () => {
	const from = hostAgent({ models: JSON.stringify({ providers: { custom: { name: "Custom", apiKey: "sk-live-literal" } } }) });
	const to = join(mkdtempSync(join(tmpdir(), "pi-overlay-")), "out"); // does not exist yet
	const { out, text } = capture();

	const code = run(from, to, [], out);

	assert.equal(code, 1);
	assert.match(text(), /literal secret at providers\.custom\.apiKey/);
	assert.equal(existsSync(join(to, "models.json")), false, "a refused import writes no overlay at all");
});

test("import-pi skips extensions by default, and blocks the admin extension under --with-extensions", () => {
	const from = hostAgent({ withExtensions: true });

	const noExt = overlayDir();
	run(from, noExt, [], () => {});
	assert.equal(existsSync(join(noExt, "extensions")), false, "extensions are not copied without --with-extensions");

	const withExt = overlayDir();
	const { out, text } = capture();
	run(from, withExt, ["--with-extensions"], out);
	assert.ok(existsSync(join(withExt, "extensions", "my-tool")), "a normal extension is copied");
	assert.equal(existsSync(join(withExt, "extensions", "pi-dispatch-admin")), false, "the admin extension is hard-blocked");
	assert.match(text(), /blocked extension "pi-dispatch-admin"/);
});

test("import-pi errors clearly when the source agent dir is absent", () => {
	const { out, text } = capture();
	const code = run(join(tmpdir(), "nope-does-not-exist-xyz"), overlayDir(), [], out);
	assert.equal(code, 1);
	assert.match(text(), /no pi setup found/);
});

test("findLiteralSecret: catches literal apiKey and auth headers, passes env/command indirections", () => {
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "sk-literal" } } }), "providers.p.apiKey");
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "$MY_KEY" } } }), null, "$ENV reference is not a literal");
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "!op read x" } } }), null, "!command is not a literal");
	assert.equal(findLiteralSecret({ providers: { p: { headers: { Authorization: "Bearer sk-x" } } } }), "providers.p.headers.Authorization");
	assert.equal(findLiteralSecret({ providers: { p: { headers: { "Content-Type": "application/json" } } } }), null, "a non-secret header is fine");
	assert.equal(findLiteralSecret({ providers: {} }), null);
});
