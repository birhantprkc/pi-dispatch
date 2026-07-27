import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/doctor.mjs";

// A fake `spawn`: plan keys are command-line prefixes ("docker info", "docker image", "docker run",
// "gh auth status", "gh auth token") mapped to a canned exit code, a `{code, output}` pair (output is
// emitted on the fake stdout for doctor's capture helper), or "enoent" for a launch failure. Every spawn
// is recorded into `calls` (cmd, args, opts) so tests can assert argv and the spawn env.
function fakeSpawn(plan, calls = []) {
	return (cmd, args, opts) => {
		const line = [cmd, ...args].join(" ");
		const key = Object.keys(plan).find((k) => line.startsWith(k));
		const outcome = plan[key];
		calls.push({ cmd, args, opts });
		const stream = () => ({
			handlers: {},
			on(ev, cb) {
				this.handlers[ev] = cb;
				return this;
			},
		});
		const handlers = {};
		const child = {
			stdout: stream(),
			stderr: stream(),
			kill() {},
			on(ev, cb) {
				handlers[ev] = cb;
				return this;
			},
		};
		queueMicrotask(() => {
			if (outcome === "enoent") {
				handlers.error?.(new Error(`spawn ${cmd} ENOENT`));
				return;
			}
			const { code, output } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			handlers.close?.(code);
		});
		return child;
	};
}
function capture() {
	const buf = [];
	return { out: (s) => buf.push(s), text: () => buf.join("") };
}
const green = { "docker info": 0, "docker image": 0 };
// A classic-token `gh auth status` (newer gh quotes each scope; the parser also accepts unquoted).
const ghStatusOutput = [
	"github.com",
	"  ✓ Logged in to github.com account octocat (keyring)",
	"  - Active account: true",
	"  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
	"",
].join("\n");

test("doctor: all prerequisites present passes and exits 0", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 0);
	assert.match(text(), /Docker daemon reachable/);
	assert.doesNotMatch(text(), /✗/, "no hard failures are marked");
});

test("doctor: docker down, valkey down, no key exits 1 with fixes", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic" }, // no credential
		{ out, spawn: fakeSpawn({ "docker info": 1 }), probeValkey: async () => false, fileExists: () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 1);
	assert.match(text(), /start Docker/, "a down daemon (exit != 0) is distinguished from a missing binary");
	assert.match(text(), /docker compose .* up -d/, "the Valkey fix is shown");
	assert.match(text(), /set ANTHROPIC_API_KEY in \.env/, "the provider-key fix names the right var");
});

test("doctor: a missing docker binary reads as 'install', not 'start'", async () => {
	const { out, text } = capture();
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, spawn: fakeSpawn({ "docker info": "enoent" }), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0" },
	);
	assert.match(text(), /install Docker/, "an unlaunchable docker is an install problem");
});

test("doctor: the provider key value is never printed", async () => {
	const { out, text } = capture();
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-secret-value" },
		{
			out,
			spawn: fakeSpawn({ ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_secret_mint\n" }, "docker run": 0 }),
			probeValkey: async () => true,
			fileExists: () => true,
			nodeVersion: "22.19.0",
		},
	);
	assert.doesNotMatch(text(), /sk-secret-value/, "the credential must never reach output");
	assert.doesNotMatch(text(), /gho_secret_mint/, "the minted gh token must never reach output");
});

test("doctor: an outdated Node is flagged and fails", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, fileExists: () => true, nodeVersion: "20.10.0" },
	);
	assert.equal(code, 1);
	assert.match(text(), /Node ≥ 22\.19 \(have 20\.10\.0\)/);
});

test("doctor: a missing .env is a warning, not a hard failure", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, fileExists: () => false, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 0, "an absent .env alone does not fail doctor — env can come from a service manager");
	assert.match(text(), /⚠ \.env present/);
});

// The overlay checks read real files (doctor uses real readFileSync for models.json), so use temp dirs and
// doctor's default fileExists; the docker/valkey checks stay faked green so ONLY the overlay drives the outcome.
function overlay({ auth = false, models, extensions = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-overlay-"));
	if (auth) writeFileSync(join(dir, "auth.json"), "{}");
	if (models !== undefined) writeFileSync(join(dir, "models.json"), models);
	if (extensions) mkdirSync(join(dir, "extensions", "x"), { recursive: true });
	return dir;
}
const overlayEnv = (dir, extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: dir, ...extra });
const overlayDeps = (out) => ({ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" });

test("doctor: a set-but-missing overlay dir fails", async () => {
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv("/no/such/overlay"), overlayDeps(out));
	assert.equal(code, 1);
	assert.match(text(), /Global overlay dir exists/);
});

test("doctor: auth.json in the overlay is a hard failure (credential leak)", async () => {
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({ auth: true })), overlayDeps(out));
	assert.equal(code, 1);
	assert.match(text(), /credential-free \(no auth\.json\)/);
	assert.match(text(), /belongs in env/);
});

test("doctor: a literal key in the overlay models.json is a hard failure", async () => {
	const dir = overlay({ models: JSON.stringify({ providers: { c: { apiKey: "sk-literal" } } }) });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir), overlayDeps(out));
	assert.equal(code, 1);
	assert.match(text(), /Overlay models\.json is credential-free/);
});

test("doctor: a clean overlay passes; armed extensions are a warning, not a failure", async () => {
	const clean = overlay({ models: JSON.stringify({ providers: { anthropic: { name: "Anthropic" } } }) });
	const { out: o1, text: t1 } = capture();
	assert.equal(await runDoctor(overlayEnv(clean), overlayDeps(o1)), 0, "a clean overlay does not fail doctor");
	assert.doesNotMatch(t1(), /✗/);

	const armed = overlay({ extensions: true });
	const { out: o2, text: t2 } = capture();
	const code = await runDoctor(overlayEnv(armed, { PI_GLOBAL_ALLOW_EXTENSIONS: "1" }), overlayDeps(o2));
	assert.equal(code, 0, "armed extensions warn (⚠) but do not fail doctor");
	assert.match(t2(), /⚠ Overlay extensions present and ARMED/);
});

// PI_AUTH_FROM_PI: the provider key may live in pi's auth.json, not the env — doctor reads it (real fs).
function agentDirWith(cred) {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: cred }));
	return dir;
}

test("doctor: an api_key in pi auth.json passes the provider-key check BY DEFAULT (no flag set)", async () => {
	const dir = agentDirWith({ type: "api_key", key: "sk-x" });
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", PI_CODING_AGENT_DIR: dir }, // no ANTHROPIC_API_KEY, no PI_AUTH_FROM_PI — default on
		{ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 0, "the key comes from pi by default, so doctor is green");
	assert.match(text(), /from pi auth\.json/);
});

test("doctor: PI_AUTH_FROM_PI=0 forces env-only — the pi login is ignored", async () => {
	const dir = agentDirWith({ type: "api_key", key: "sk-x" });
	const { out } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", PI_CODING_AGENT_DIR: dir, PI_AUTH_FROM_PI: "0" }, // opt out
		{ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 1, "with the fallback disabled, a missing env key fails the check");
});

test("doctor: an OAuth login in pi auth.json is flagged as not usable for a service", async () => {
	const dir = agentDirWith({ type: "oauth", access_token: "x" });
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", PI_CODING_AGENT_DIR: dir },
		{ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 1, "an OAuth/subscription login is not a usable service credential");
	assert.match(text(), /OAuth\/subscription/);
});

// GITHUB_AUTH_SOURCE=gh (the default) forwards the operator's full gh login into every token-carrying job
// container (CONST-TOKEN-SCOPED-PER-JOB) — doctor surfaces the trade-off as a warning, never a failure.
const ghDeps = (out, plan, calls) => ({ out, spawn: fakeSpawn(plan, calls), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0" });
const ghEnv = (extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", ...extra });

test("doctor: default source gh warns with the login's scopes and names the broad ones", async () => {
	const { out, text } = capture();
	const code = await runDoctor(ghEnv(), ghDeps(out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }));
	assert.equal(code, 0, "the scope warning never fails doctor");
	assert.match(text(), /⚠ GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container \(scopes: gist, read:org, repo, workflow\)/);
	assert.match(text(), /this token carries broad scopes \(workflow\)/, "broad scopes are called out by name");
	assert.match(text(), /fine-grained PAT \(GITHUB_AUTH_SOURCE=pat\) or a GitHub App/);
});

test("doctor: a fine-grained token (no scopes line) is reported as such", async () => {
	const { out, text } = capture();
	await runDoctor(ghEnv(), ghDeps(out, { ...green, "gh auth status": { code: 0, output: "github.com\n  ✓ Logged in to github.com account octocat\n" } }));
	assert.match(text(), /scopes not reported \(fine-grained token\)/);
	assert.doesNotMatch(text(), /broad scopes/);
});

test("doctor: GITHUB_AUTH_SOURCE=pat emits no scope warning", async () => {
	const { out, text } = capture();
	await runDoctor(ghEnv({ GITHUB_AUTH_SOURCE: "pat" }), ghDeps(out, green));
	assert.doesNotMatch(text(), /forwards your full gh login/);
});

test("doctor: source gh with gh missing warns 'auth status failed', still exits 0", async () => {
	const { out, text } = capture();
	const code = await runDoctor(ghEnv(), ghDeps(out, { ...green, "gh auth": "enoent" }));
	assert.equal(code, 0, "a local-only deployment with the default source is valid — warn, don't fail");
	assert.match(text(), /⚠ GITHUB_AUTH_SOURCE is gh but `gh auth status` failed/);
	assert.match(text(), /run `gh auth login` \(or switch GITHUB_AUTH_SOURCE\)/);
});

test("doctor: the in-image probe passes the token via the spawn env, never argv", async () => {
	const calls = [];
	const { out, text } = capture();
	const plan = {
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
		"gh auth token": { code: 0, output: "gho_fake_mint_123\n" },
		"docker run": 0,
	};
	const code = await runDoctor(ghEnv(), ghDeps(out, plan, calls));
	assert.equal(code, 0);
	const run = calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
	assert.ok(run, "the in-image probe spawned docker run");
	assert.equal(run.args[run.args.indexOf("--entrypoint") + 1], "gh", "the image entrypoint is overridden to gh");
	// value-less -e flags: only the names appear in argv, the values ride the spawn env
	assert.deepEqual(run.args.filter((_, i) => run.args[i - 1] === "-e"), ["GH_TOKEN", "GITHUB_TOKEN"]);
	assert.ok(!run.args.some((a) => a.includes("gho_fake_mint_123")), "the token never enters argv");
	assert.equal(run.opts.env.GH_TOKEN, "gho_fake_mint_123");
	assert.equal(run.opts.env.GITHUB_TOKEN, "gho_fake_mint_123");
	assert.match(text(), /✓ gh authenticates inside the job image \(pi-job:latest\)/);
	assert.doesNotMatch(text(), /gho_fake_mint_123/, "the token never reaches output");
});

test("doctor: an in-image gh auth failure warns with the egress fix, exits 0", async () => {
	const { out, text } = capture();
	const plan = { ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "docker run": 1 };
	const code = await runDoctor(ghEnv(), ghDeps(out, plan));
	assert.equal(code, 0, "an in-container auth failure warns but never fails doctor");
	assert.match(text(), /⚠ gh cannot authenticate inside the job image \(pi-job:latest\)/);
	assert.match(text(), /check network egress from containers/);
});

test("doctor: no in-image probe when docker is not green (gating)", async () => {
	const calls = [];
	const { out } = capture();
	const plan = { "docker info": 1, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" } };
	await runDoctor(ghEnv(), ghDeps(out, plan, calls));
	assert.ok(!calls.some((c) => c.cmd === "docker" && c.args[0] === "run"), "no docker run on top of a down daemon");
});

test("doctor: GITHUB_AUTH_SOURCE=app skips the in-image probe (mints per-job)", async () => {
	const calls = [];
	const { out, text } = capture();
	const code = await runDoctor(ghEnv({ GITHUB_AUTH_SOURCE: "app" }), ghDeps(out, green, calls));
	assert.equal(code, 0);
	assert.match(text(), /✓ in-image gh auth: skipped \(GITHUB_AUTH_SOURCE=app mints per-job\)/);
	assert.ok(!calls.some((c) => c.cmd === "docker" && c.args[0] === "run"), "app mints per-job — nothing to preflight");
	assert.doesNotMatch(text(), /forwards your full gh login/, "no scope warning for source app");
});
