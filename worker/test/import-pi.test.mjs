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
const run = (from, to, extra = [], out, deps = {}) => runImportPi(["--from", from, "--to", to, ...extra], { out, ...deps });

test("import-pi copies models/skills/persona and NEVER auth.json", async () => {
	const from = hostAgent();
	const to = overlayDir();
	const { out } = capture();

	const code = await run(from, to, [], out);

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "models.json")), "models.json copied");
	assert.ok(existsSync(join(to, "skills", "tidy", "SKILL.md")), "skill copied");
	assert.ok(existsSync(join(to, "APPEND_SYSTEM.md")), "persona copied");
	assert.equal(existsSync(join(to, "auth.json")), false, "auth.json must NEVER be copied — the credential stays in env");
});

test("import-pi refuses a models.json with a literal key and writes nothing", async () => {
	const from = hostAgent({ models: JSON.stringify({ providers: { custom: { name: "Custom", apiKey: "sk-live-literal" } } }) });
	const to = join(mkdtempSync(join(tmpdir(), "pi-overlay-")), "out"); // does not exist yet
	const { out, text } = capture();

	const code = await run(from, to, [], out);

	assert.equal(code, 1);
	assert.match(text(), /literal secret at providers\.custom\.apiKey/);
	assert.equal(existsSync(join(to, "models.json")), false, "a refused import writes no overlay at all");
});

test("import-pi skips extensions by default, and blocks the admin extension under --with-extensions", async () => {
	const from = hostAgent({ withExtensions: true });

	const noExt = overlayDir();
	await run(from, noExt, [], () => {});
	assert.equal(existsSync(join(noExt, "extensions")), false, "extensions are not copied without --with-extensions");

	const withExt = overlayDir();
	const { out, text } = capture();
	await run(from, withExt, ["--with-extensions"], out);
	assert.ok(existsSync(join(withExt, "extensions", "my-tool")), "a normal extension is copied");
	assert.equal(existsSync(join(withExt, "extensions", "pi-dispatch-admin")), false, "the admin extension is hard-blocked");
	assert.match(text(), /blocked extension "pi-dispatch-admin"/);
});

test("import-pi errors clearly when the source agent dir is absent", async () => {
	const { out, text } = capture();
	const code = await run(join(tmpdir(), "nope-does-not-exist-xyz"), overlayDir(), [], out);
	assert.equal(code, 1);
	assert.match(text(), /no pi setup found/);
});

// --- packages staging (issue #58) -------------------------------------------------------------------
//
// npm is INJECTED: the stub records the argv it was handed and materializes the fixture npm would have
// produced, so the assertions are about the contract (self-contained dir, exact version, containment)
// rather than about the network.

const PKG = "@quintinshaw/pi-dynamic-workflows";
const PKG_DIR = "quintinshaw__pi-dynamic-workflows";

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** Write a `pi-packages.json` somewhere and return its path. */
function packagesFile(packages) {
	const path = join(mkdtempSync(join(tmpdir(), "pi-pkgs-")), "pi-packages.json");
	writeJson(path, { packages });
	return path;
}

/** The default fixture: a real-shaped pi package -- a `pi` manifest plus its one dependency, nested inside. */
function goodPackage(pkgDir, name, version, overrides = {}) {
	const dep = join(pkgDir, "node_modules", "left-pad");
	mkdirSync(dep, { recursive: true });
	writeJson(join(dep, "package.json"), { name: "left-pad", version: "1.0.0" });
	writeJson(join(pkgDir, "package.json"), { name, version, dependencies: { "left-pad": "^1.0.0" }, pi: { extensions: ["./dist/index.js"] }, ...overrides });
}

/**
 * An injected npm. Records every call; `materialize` builds `<cwd>/node_modules/<name>` in its place --
 * `options.cwd` IS the install target, exactly as real npm treats it now that `--prefix` is gone from argv.
 */
function npmStub(materialize = goodPackage) {
	const calls = [];
	const exec = async (file, args, options) => {
		calls.push({ file, args, options });
		const prefix = options.cwd;
		const spec = args[1];
		const at = spec.lastIndexOf("@");
		const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];
		const pkgDir = join(prefix, "node_modules", name);
		mkdirSync(pkgDir, { recursive: true });
		materialize(pkgDir, name, version);
		return { stdout: "", stderr: "" };
	};
	return { exec, calls };
}

const readManifest = (to) => JSON.parse(readFileSync(join(to, "packages", "packages.json"), "utf8"));

test("--with-packages stages a pinned package into packages/<dir> and writes the stage manifest", async () => {
	const from = hostAgent();
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }, { name: "pi-widgets", version: "1.4.2", dir: "widgets" }]);
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "package.json")), "a scoped name stages as scope__name");
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "node_modules", "left-pad")), "the staged dir is SELF-CONTAINED");
	assert.ok(existsSync(join(to, "packages", "widgets", "package.json")), "an explicit dir wins over the derived one");
	assert.equal(existsSync(join(to, "packages", ".staging-0")), false, "the staging dir is cleaned up");

	const manifest = readManifest(to);
	assert.deepEqual(manifest.packages, [
		{ name: PKG, version: "0.1.0", dir: PKG_DIR },
		{ name: "pi-widgets", version: "1.4.2", dir: "widgets" },
	]);
	assert.match(manifest.stagedAt, /^\d{4}-\d{2}-\d{2}T/);
	assert.match(text(), /packages\/.*2 packages -- third-party code, VET THESE/);
	assert.match(text(), /run\.packages: true/, "next steps say the staged packages are dormant until a trigger asks for them");
	assert.equal(calls.length, 2, "one npm install per package");
});

/** The load-bearing flags, asserted from every argv the stager builds regardless of platform. */
const NPM_FLAGS = ["--ignore-scripts", "--omit=dev", "--omit=peer", "--omit=optional", "--install-strategy=nested", "--no-audit", "--no-fund"];

/**
 * The property `shell: true` on win32 rests on: argv is literal flags plus ONE validated `name@version`
 * token, and carries no filesystem path at all (the install target travels as `options.cwd`, never as
 * `--prefix <staging>`). Re-introducing a path here would break the safety argument in import-pi.mjs.
 */
function assertArgvHasNoPath(args, staging) {
	assert.equal(args.includes("--prefix"), false, "--prefix is gone -- the install target is options.cwd");
	assert.equal(args.some((a) => a.includes(staging)), false, "the staging path must never appear in argv");
	assert.equal(
		args.some((a) => a.startsWith("/") || a.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(a)),
		false,
		"no absolute path may reach argv -- that is what makes shell:true safe on win32",
	);
	for (const flag of NPM_FLAGS) assert.ok(args.includes(flag), `argv must include ${flag}`);
}

test("the npm invocation is an ARRAY argv with the load-bearing flags, and never a shell string", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec, calls } = npmStub();

	await run(hostAgent(), to, ["--with-packages", "--packages-file", file], () => {}, { exec, platform: "linux" });

	const [{ file: bin, args, options }] = calls;
	assert.equal(bin, "npm");
	assert.ok(Array.isArray(args), "argv is an ARRAY");
	assert.equal(args[0], "install");
	assert.equal(args[1], `${PKG}@0.1.0`, "name and version travel as ONE argv element, never concatenated into a command");
	assertArgvHasNoPath(args, options.cwd);
	// NEGATIVE: nothing here may be a shell string -- a package name from a config file must never be able
	// to become shell syntax on the operator's host.
	assert.equal(args.some((a) => /[;&|`$><]/.test(a)), false, "no shell metacharacter reaches the runner");
	assert.equal(args.some((a) => a.includes("npm ") || a.trim().includes(" install ")), false, "the command is never one packed string");
	assert.equal(options.shell ?? false, false, "off win32 there is no shell at all");
});

test("on win32 npm.cmd is spawned WITH shell:true -- without it Node throws EINVAL and --with-packages is dead", async () => {
	// Since Node 18.20.2/20.12.2 (CVE-2024-27980) a .cmd cannot be spawned without a shell, and this package
	// floors at Node >=22.19 -- so the win32 branch only works if BOTH halves are present together.
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec, calls } = npmStub();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], () => {}, { exec, platform: "win32" });

	assert.equal(code, 0, "the win32 path must stage successfully, not fail on spawn");
	const [{ file: bin, args, options }] = calls;
	assert.equal(bin, "npm.cmd", "npm ships as npm.cmd on Windows");
	assert.equal(options.shell, true, "npm.cmd needs shell:true or Node throws EINVAL before npm ever runs");
	// And the reason that is safe: no path in argv, both remaining tokens regex-validated.
	assert.equal(args[1], `${PKG}@0.1.0`);
	assertArgvHasNoPath(args, options.cwd);
	assert.equal(args.some((a) => /[\s;&|`$><^%"()]/.test(a)), false, "no cmd metacharacter or space can survive into the command line");
});

test("off win32 npm is spawned as a plain binary with NO shell", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec, calls } = npmStub();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], () => {}, { exec, platform: "linux" });

	assert.equal(code, 0);
	const [{ file: bin, args, options }] = calls;
	assert.equal(bin, "npm");
	assert.equal(options.shell ?? false, false, "a POSIX host must never get a shell -- there is no EINVAL to work around");
	assertArgvHasNoPath(args, options.cwd);
});

test("the staged tree still lands under options.cwd, so the assertions and the rename still hold", async () => {
	// The one behavioural risk of dropping --prefix: npm installs into the cwd's node_modules, which is where
	// the dependency-completeness check and the renameSync of <staging>/node_modules/<name> both look.
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec, calls } = npmStub();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], () => {}, { exec, platform: "win32" });

	assert.equal(code, 0);
	assert.match(calls[0].options.cwd, /\.staging-0$/, "the cwd IS the private staging dir npm must install into");
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "package.json")), "the package was renamed out of <cwd>/node_modules/<name>");
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "node_modules", "left-pad")), "and its nested dependency came with it");
});

test("--with-packages refuses the admin package outright and stages NOTHING", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: "@edgehero/pi-dispatch-admin", version: "1.0.0" }]);
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /admin/);
	assert.equal(existsSync(join(to, "packages")), false, "no packages dir is created at all");
	assert.equal(calls.length, 0, "npm is never invoked for a refused file");
});

test("--with-packages refuses a RANGE version and stages nothing", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "^0.1.0" }]);
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /EXACT version/);
	assert.equal(existsSync(join(to, "packages")), false);
	assert.equal(calls.length, 0);
});

test("--with-packages refuses a package npm staged at the wrong version", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec } = npmStub((pkgDir, name) => goodPackage(pkgDir, name, "0.2.0"));
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /"0\.2\.0".*"0\.1\.0"/);
	assert.equal(existsSync(join(to, "packages", PKG_DIR)), false);
});

test("--with-packages refuses a package whose dependency was hoisted out of the package dir", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	// npm hoisted left-pad to the staging root: the staged dir could not import it with no network.
	const { exec } = npmStub((pkgDir, name, version) => {
		writeJson(join(pkgDir, "package.json"), { name, version, dependencies: { "left-pad": "^1.0.0" }, pi: { extensions: ["./index.js"] } });
	});
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /left-pad/);
	assert.equal(existsSync(join(to, "packages", PKG_DIR)), false, "a half-staged set is never left behind");
});

test("--with-packages refuses a package that contributes no pi resources (it would be a silent no-op)", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: "pi-widgets", version: "1.0.0" }]);
	const { exec } = npmStub((pkgDir, name, version) => writeJson(join(pkgDir, "package.json"), { name, version }));
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /is not a pi package/);
	assert.equal(existsSync(join(to, "packages")), false);
});

test("a package with no pi manifest but a convention dir (skills/) is staged", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: "pi-widgets", version: "1.0.0" }]);
	const { exec } = npmStub((pkgDir, name, version) => {
		mkdirSync(join(pkgDir, "skills", "tidy"), { recursive: true });
		writeFileSync(join(pkgDir, "skills", "tidy", "SKILL.md"), "---\nname: tidy\n---\n");
		writeJson(join(pkgDir, "package.json"), { name, version });
	});

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], () => {}, { exec });

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "packages", "pi-widgets", "skills", "tidy", "SKILL.md")));
});

test('--with-packages refuses a pi manifest entry containing ".."', async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec } = npmStub((pkgDir, name, version) => goodPackage(pkgDir, name, version, { pi: { extensions: ["../../../etc/passwd"] } }));
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /leaves the package dir/);
	assert.equal(existsSync(join(to, "packages", PKG_DIR)), false);
});

test("a package declaring a postinstall script is staged WITH a warn row (--ignore-scripts left it incomplete)", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec } = npmStub((pkgDir, name, version) => goodPackage(pkgDir, name, version, { scripts: { postinstall: "node build.js" }, optionalDependencies: { fsevents: "^2" } }));
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 0, "a warning is not a refusal");
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "package.json")), "it is still staged");
	assert.match(text(), /WARN:.*scripts\.postinstall, optionalDependencies.*INCOMPLETE/);
	assert.deepEqual(readManifest(to).packages.length, 1);
});

test("--with-packages fails loud when the packages file is missing", async () => {
	const to = overlayDir();
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", join(tmpdir(), "nope-pi-packages.json")], out, { exec: npmStub().exec });

	assert.equal(code, 1);
	assert.match(text(), /needs a packages file/);
	assert.equal(existsSync(join(to, "packages")), false);
});

test("without --with-packages nothing is staged and the rest of the import is unchanged", async () => {
	const from = hostAgent();
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--packages-file", file], out, { exec });

	assert.equal(code, 0);
	assert.equal(existsSync(join(to, "packages")), false, "no packages dir without the flag");
	assert.equal(calls.length, 0, "npm is never invoked without the flag");
	assert.ok(existsSync(join(to, "models.json")) && existsSync(join(to, "skills", "tidy", "SKILL.md")), "the existing import still happens");
	assert.equal(/packages\//.test(text()), false, "and the table gains no packages row");
});

test("re-running without the flag keeps an existing packages/ and reports it dormant", async () => {
	const from = hostAgent();
	const to = overlayDir();
	const { exec } = npmStub();
	await run(from, to, ["--with-packages", "--packages-file", packagesFile([{ name: PKG, version: "0.1.0" }])], () => {}, { exec });

	const { out, text } = capture();
	const code = await run(from, to, [], out);

	assert.equal(code, 0);
	assert.match(text(), /packages\/\s+kept -- re-run with --with-packages to refresh/);
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "package.json")), "the staged packages survive a plain re-run");
	assert.deepEqual(readManifest(to).packages.length, 1, "and so does the stage manifest");
});

test("findLiteralSecret: catches literal apiKey and auth headers, passes env/command indirections", () => {
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "sk-literal" } } }), "providers.p.apiKey");
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "$MY_KEY" } } }), null, "$ENV reference is not a literal");
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "!op read x" } } }), null, "!command is not a literal");
	assert.equal(findLiteralSecret({ providers: { p: { headers: { Authorization: "Bearer sk-x" } } } }), "providers.p.headers.Authorization");
	assert.equal(findLiteralSecret({ providers: { p: { headers: { "Content-Type": "application/json" } } } }), null, "a non-secret header is fine");
	assert.equal(findLiteralSecret({ providers: {} }), null);
});
