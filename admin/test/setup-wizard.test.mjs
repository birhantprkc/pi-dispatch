import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as realFs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The `/dispatch setup` wizard (setup-wizard.ts): the detection tree, the pinned npm shapes, the
 * suspend/spawn bracket, the step engine's consent seams, the first-trigger flow, and the one-time
 * startup nudge. Everything runs offline: detection and the wizard take injected env/fs/probe/spawn
 * seams, and the real-fs cases use per-test temp dirs.
 */

// Hermeticity, BEFORE the module graph loads: pointerPath() and the nudge marker derive from
// PI_CODING_AGENT_DIR, and no test may ever read (or write!) the real ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "admin-setup-agent-"));

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../src/setup-wizard.ts", import.meta.url)));

/** A probe that fails the test if detection consults the network when it must not. */
const mustNotProbe = async () => {
  throw new Error("detection consulted the queue probe on a branch that must short-circuit before it");
};

/** An empty temp dir (no scaffold files), for cwd arguments. */
const emptyDir = () => mkdtempSync(join(tmpdir(), "admin-setup-empty-"));

/** A canned-answer, recording ctx.ui in the crud.test.mjs shape, plus (title/message) capture. */
function wizardUi({ select = [], input = [], confirm = [] } = {}) {
  const notes = [];
  const seen = { select: [], input: [], confirm: [] };
  const sel = [...select];
  const inp = [...input];
  const con = [...confirm];
  const ui = {
    async select(title, options) {
      seen.select.push({ title, options });
      return sel.shift();
    },
    async input(title, placeholder) {
      seen.input.push({ title, placeholder });
      return inp.shift();
    },
    async confirm(title, message) {
      seen.confirm.push({ title, message });
      return con.shift();
    },
    notify: (m, t) => notes.push({ m, t }),
  };
  return { ui, notes, seen };
}

/** Common recording deps for the step engine; every host-touching seam is a fake that records. */
function wizardDeps(overrides = {}) {
  const attached = [];
  const pointerWrites = [];
  const order = [];
  const dashboards = [];
  const deps = {
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(mkdtempSync(join(tmpdir(), "admin-setup-ptr-")), "pointer.json") },
    platform: "linux",
    execPath: "/usr/bin/node-under-test",
    homedirFn: () => mkdtempSync(join(tmpdir(), "admin-setup-home-")),
    detectFn: async () => ({ state: "none", detail: "canned detection" }),
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      return { code: 0 };
    },
    writePointerFn: (args) => {
      pointerWrites.push(args);
      order.push("write");
      return { ok: true };
    },
    reapplyFn: () => {
      order.push("reapply");
      return { applied: [] };
    },
    openDashboardFn: async (paths, _ctx, _notify) => {
      dashboards.push(paths);
    },
    resolvePathsFn: () => ({ canned: "resolved" }),
    ...overrides,
  };
  return { deps, attached, pointerWrites, order, dashboards };
}

const tuiCtx = (ui, cwd) => ({ mode: "tui", hasUI: true, ui, cwd });

/** Plant an installed runtime of `version` inside a deployment dir (what the npm step would produce). */
function plantRuntime(dir, version) {
  const runtimeDir = join(dir, "node_modules", "@edgehero", "pi-dispatch");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "package.json"), JSON.stringify({ name: "@edgehero/pi-dispatch", version }));
  return runtimeDir;
}

const cliPathOf = (dir) => join(dir, "node_modules", "@edgehero", "pi-dispatch", "src", "cli.mjs");

// ── the detection tree: one test per branch, in trust order ──────────────────────────────────────

test("detect: a valid pointer file wins, and the probe is never consulted", async () => {
  const pfile = join(mkdtempSync(join(tmpdir(), "admin-det-")), "pointer.json");
  writeFileSync(pfile, JSON.stringify({ version: 1, deploymentDir: "/srv/deploy", env: {} }));
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: pfile },
    cwd: emptyDir(),
    probeQueue: mustNotProbe,
  });
  assert.equal(det.state, "pointer");
  assert.match(det.detail, /\/srv\/deploy/, "the detail names the deployment dir");
});

test("detect: a stale/invalid pointer file falls through to the later branches", async () => {
  const pfile = join(mkdtempSync(join(tmpdir(), "admin-det-")), "pointer.json");
  // A future-version pointer is readPointer's { ignored } -- detection must degrade exactly like
  // /dispatch itself does, not stop at a file it cannot honor.
  writeFileSync(pfile, JSON.stringify({ version: 99, deploymentDir: "/srv/deploy", env: {} }));
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: pfile, PI_TRIGGERS_FILE: "/x/triggers.json" },
    cwd: emptyDir(),
    probeQueue: mustNotProbe,
  });
  assert.equal(det.state, "env", "the broken pointer is skipped, the env branch answers");
});

test("detect: an exported path variable means 'env', named in the detail", async () => {
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(emptyDir(), "absent.json"), PI_TRIGGERS_FILE: "/x/triggers.json" },
    cwd: emptyDir(),
    probeQueue: mustNotProbe,
  });
  assert.equal(det.state, "env");
  assert.match(det.detail, /PI_TRIGGERS_FILE/);
});

test("detect: VALKEY_URL alone is probed, never trusted as 'env'", async () => {
  // An exported queue URL is a claim about the network, so detection verifies it (branch 4) instead of
  // short-circuiting -- a dead URL must yield the setup offer, and the wiring tests pin the probe to a
  // dead port through exactly this behaviour.
  let probedUrl;
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(emptyDir(), "absent.json"), VALKEY_URL: "redis://127.0.0.1:1" },
    cwd: emptyDir(),
    probeQueue: async (url) => {
      probedUrl = url;
      return false;
    },
  });
  assert.equal(det.state, "none");
  assert.equal(probedUrl, "redis://127.0.0.1:1", "the exported URL fed the probe");
});

test("detect: the cwd scaffold quadruple means 'cwd' (pi-packages.json deliberately not required)", async () => {
  const cwd = emptyDir();
  // Exactly init's original signature -- and NO pi-packages.json, which older deployments predate.
  for (const f of [".env", "triggers.json", "pause-windows.json", "subscriptions.json"]) writeFileSync(join(cwd, f), "");
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(emptyDir(), "absent.json") },
    cwd,
    probeQueue: mustNotProbe,
  });
  assert.equal(det.state, "cwd");
  assert.match(det.detail, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("detect: a partial scaffold is not 'cwd' — it falls through to the probe", async () => {
  const cwd = emptyDir();
  for (const f of [".env", "triggers.json", "pause-windows.json"]) writeFileSync(join(cwd, f), "");
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(emptyDir(), "absent.json") },
    cwd,
    probeQueue: async () => false,
  });
  assert.equal(det.state, "none");
});

test("detect: a reachable queue with nothing else configured is 'reachable'", async () => {
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(emptyDir(), "absent.json") },
    cwd: emptyDir(),
    probeQueue: async () => true,
  });
  assert.equal(det.state, "reachable");
  assert.match(det.detail, /redis:\/\/127\.0\.0\.1:6379/, "the default URL was the one probed");
});

test("detect: never stats logsDir/settingsFile — every fs touch is the pointer or the scaffold", async () => {
  // logsDir and settingsFile default lazily into OS temp locations, so their absence proves nothing;
  // a recording fake fs pins that detection never grows a stat of either. Whitelist assertion: every
  // recorded path must be the pointer file or one of the four scaffold files -- nothing else, ever.
  const reads = [];
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const fakeFs = {
    readFileSync: (p) => {
      reads.push(String(p));
      throw enoent();
    },
    existsSync: (p) => {
      reads.push(String(p));
      return false;
    },
    statSync: (p) => {
      reads.push(String(p));
      throw enoent();
    },
    readdirSync: (p) => {
      reads.push(String(p));
      return [];
    },
  };
  const cwd = "/detect-cwd";
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: "/agent/pointer.json", PI_LOGS_DIR: "", PI_SETTINGS_FILE: "" },
    cwd,
    fs: fakeFs,
    probeQueue: async () => false,
  });
  assert.equal(det.state, "none");
  const allowed = new Set([
    "/agent/pointer.json",
    join(cwd, ".env"),
    join(cwd, "triggers.json"),
    join(cwd, "pause-windows.json"),
    join(cwd, "subscriptions.json"),
  ]);
  assert.ok(reads.length > 0, "the fake fs was actually consulted");
  for (const p of reads) assert.ok(allowed.has(p), `unexpected filesystem read: ${p}`);
  assert.ok(!reads.some((p) => /logs|settings/i.test(p)), "no logsDir/settingsFile path was ever touched");
});

// ── the npm shapes: pure, exact, path-free ───────────────────────────────────────────────────────

test("npmInstallArgs: the exact pinned, script-less argv with no filesystem path token", () => {
  const args = mod.npmInstallArgs();
  assert.deepEqual(args, [
    "install",
    `@edgehero/pi-dispatch@${mod.RUNTIME_VERSION}`,
    "--omit=dev",
    "--omit=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ]);
  // The win32 shell:true safety argument (import-pi.mjs:400-419) rests on argv holding NO filesystem
  // path: no absolute/relative path token, no backslash, no --prefix pair -- the install target is cwd.
  for (const a of args) {
    assert.ok(!a.startsWith("/") && !a.startsWith(".") && !a.startsWith("\\"), `no path token in argv: ${a}`);
    assert.ok(!a.includes("\\"), `no backslash in argv: ${a}`);
  }
  assert.ok(!args.some((a) => a.includes("--prefix")), "the install target is the spawn cwd, never a --prefix path");
});

test("npmSpawnOptions: npm.cmd + shell on win32, plain npm elsewhere, cwd is the deployment dir", () => {
  assert.deepEqual(mod.npmSpawnOptions("win32", "C:\\deploy"), { bin: "npm.cmd", options: { cwd: "C:\\deploy", shell: true } });
  assert.deepEqual(mod.npmSpawnOptions("linux", "/deploy"), { bin: "npm", options: { cwd: "/deploy" } });
  assert.deepEqual(mod.npmSpawnOptions("darwin", "/deploy"), { bin: "npm", options: { cwd: "/deploy" } });
});

// ── RUNTIME_VERSION anti-drift ───────────────────────────────────────────────────────────────────

test("RUNTIME_VERSION matches the in-repo worker/package.json version (release bumps stay atomic)", () => {
  const workerPkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../worker/package.json", import.meta.url)), "utf8"));
  assert.equal(mod.RUNTIME_VERSION, workerPkg.version);
});

// ── runAttached: the suspend/spawn/restore bracket ───────────────────────────────────────────────

/** A ctx whose ui.custom invokes the factory with a recording fake tui and resolves on done(). */
function attachedCtx(order) {
  const tui = {
    stop: () => order.push("stop"),
    start: () => order.push("start"),
    requestRender: (full) => order.push(`render:${full}`),
  };
  const ui = {
    custom(factory, opts) {
      assert.equal(opts?.overlay, true, "runAttached runs as an overlay");
      return new Promise((resolve) => {
        const component = factory(tui, {}, {}, resolve);
        assert.equal(typeof component.render, "function", "the factory returns a component");
        component.handleInput("x"); // must be inert: the child owns stdin
      });
    },
  };
  return { mode: "tui", ui };
}

test("runAttached: stop → spawn → start + requestRender(true), and the exit code is captured", async () => {
  const order = [];
  const { EventEmitter } = await import("node:events");
  const spawnFn = (argv0, args, options) => {
    order.push(`spawn:${argv0}`);
    assert.equal(options.stdio, "inherit", "the child owns the terminal");
    assert.equal(options.cwd, "/deploy");
    const child = new EventEmitter();
    setImmediate(() => child.emit("close", 7));
    return child;
  };
  const res = await mod.runAttached(attachedCtx(order), { title: "t", argv0: "x", args: [], cwd: "/deploy", spawnFn });
  assert.equal(res.code, 7, "the exit code is captured, never discarded (unlike the sandbox opener)");
  assert.deepEqual(order, ["stop", "spawn:x", "start", "render:true"]);
});

test("runAttached: a spawn 'error' event resolves { code: null, error } and still restores the tui", async () => {
  const order = [];
  const { EventEmitter } = await import("node:events");
  const spawnFn = () => {
    order.push("spawn");
    const child = new EventEmitter();
    setImmediate(() => child.emit("error", new Error("ENOENT-ish")));
    return child;
  };
  const res = await mod.runAttached(attachedCtx(order), { title: "t", argv0: "x", args: [], spawnFn });
  assert.equal(res.code, null);
  assert.match(res.error.message, /ENOENT-ish/);
  assert.deepEqual(order, ["stop", "spawn", "start", "render:true"]);
});

test("runAttached: a synchronously-throwing spawn still runs the finally bracket", async () => {
  const order = [];
  const spawnFn = () => {
    order.push("spawn");
    throw new Error("boom at spawn time");
  };
  const res = await mod.runAttached(attachedCtx(order), { title: "t", argv0: "x", args: [], spawnFn });
  assert.equal(res.code, null);
  assert.match(res.error.message, /boom at spawn time/);
  assert.deepEqual(order, ["stop", "spawn", "start", "render:true"], "start + full redraw even on a throw");
});

test("runAttached: refuses without a TUI (mode/custom), spawning nothing", async () => {
  const spawnFn = () => {
    throw new Error("must not spawn");
  };
  for (const ctx of [{ mode: "print", ui: { custom: () => {} } }, { mode: "tui", ui: {} }, undefined]) {
    const res = await mod.runAttached(ctx, { title: "t", argv0: "x", args: [], spawnFn });
    assert.equal(res.code, null);
    assert.match(res.error.message, /terminal UI/);
  }
});

// ── the step engine ──────────────────────────────────────────────────────────────────────────────

test("wizard: without the dialog primitives it degrades to one notice and touches nothing", async () => {
  const notes = [];
  const { deps, attached } = wizardDeps({
    detectFn: async () => {
      throw new Error("must not even detect");
    },
  });
  await mod.runSetupWizard({}, { mode: "tui", ui: {} }, (m, t) => notes.push({ m, t }), deps);
  assert.equal(notes.length, 1);
  assert.match(notes[0].m, /dialogs|newer pi/);
  assert.equal(attached.length, 0);
});

test("wizard: 'Open the panel anyway' short-circuits to the dashboard with the original paths", async () => {
  const { ui, seen } = wizardUi({ select: ["Open the panel anyway"] });
  const paths = { triggersPath: "/decoy/triggers.json" };
  const opened = [];
  const { deps } = wizardDeps({ openDashboardFn: async (p) => opened.push(p) });
  await mod.runSetupWizard(paths, tuiCtx(ui), ui.notify, deps);
  assert.equal(opened.length, 1);
  assert.equal(opened[0], paths, "the pre-wizard paths object, by identity");
  assert.equal(seen.input.length, 0, "no later step ran");
});

test("wizard: declined confirms spawn NOTHING, and every step is still offered", async () => {
  const dir = emptyDir();
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup", "Skip"],
    input: [dir],
    confirm: [false, false, false, false], // install, up, pointer, github -- all declined
  });
  const { deps, attached, pointerWrites, dashboards } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0, "a declined confirm never reaches a spawn");
  assert.equal(pointerWrites.length, 0, "a declined pointer confirm writes nothing");
  assert.equal(seen.confirm.length, 4, "all four consent gates were offered despite the declines");
  assert.equal(seen.select.length, 2, "intent + worker choice");
  assert.ok(notes.some((n) => /provider key/.test(n.m)), "the never-tier provider-key notice still fires");
  assert.ok(notes.some((n) => /setup finished/.test(n.m)));
  assert.equal(dashboards.length, 1, "the wizard still ends at the panel");
  assert.deepEqual(dashboards[0], { canned: "resolved" }, "opened against freshly resolved paths");
});

test("wizard: an accepted install spawns the exact npm shape and never clobbers an existing package.json", async () => {
  const dir = emptyDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "custom-root" }));
  const { ui, seen } = wizardUi({
    select: ["Guided setup", "Skip"],
    input: [dir],
    confirm: [true, false, false, false],
  });
  const { deps, attached, dashboards } = wizardDeps({
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      plantRuntime(dir, mod.RUNTIME_VERSION); // what a good npm run produces
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 1);
  assert.equal(attached[0].argv0, "npm", "posix npm, per npmSpawnOptions");
  assert.deepEqual(attached[0].args, mod.npmInstallArgs());
  assert.equal(attached[0].cwd, dir, "the install target is the spawn cwd");
  assert.equal(attached[0].shell, undefined, "no shell off win32");
  assert.match(seen.confirm[0].message, /npm install/, "the confirm shows the exact command");
  assert.match(seen.confirm[0].message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "and names the dir");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), { name: "custom-root" }, "an existing root package.json is never clobbered");
  assert.equal(dashboards.length, 1, "a clean install continues to the end");
});

test("wizard: a post-install version mismatch stops the wizard loudly — no later step runs", async () => {
  const dir = emptyDir();
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup"],
    input: [dir],
    confirm: [true], // accept the install; nothing later should be asked
  });
  const { deps, attached, dashboards } = wizardDeps({
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      plantRuntime(dir, "9.9.9"); // npm "succeeded" with the wrong artifact (import-pi:334-341)
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.ok(notes.some((n) => n.t === "error" && /9\.9\.9/.test(n.m) && /not the pinned/.test(n.m)), "the error names both versions");
  assert.equal(attached.length, 1, "only the npm spawn ran — never up/service/github");
  assert.equal(seen.confirm.length, 1, "no later consent gate was reached");
  assert.equal(dashboards.length, 0, "the wizard did not continue to the panel");
  // The if-absent private root package.json was written before the install (import-pi:294 idiom).
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), { name: "pi-dispatch-deployment", private: true });
});

test("wizard: an already-pinned runtime skips the install silently-but-said", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup", "Skip"],
    input: [dir],
    confirm: [false, false, false], // up, pointer, github — no install confirm expected
  });
  const { deps, attached } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.ok(!seen.confirm.some((c) => /Install the pi-dispatch runtime/.test(c.title)), "no install dialog");
  assert.ok(notes.some((n) => /already installed/.test(n.m) && /skipping npm install/.test(n.m)), "the skip is said out loud");
  assert.equal(attached.length, 0);
});

test("wizard: up runs without --yes; a nonzero exit gates on Continue/Stop, and Stop ends the wizard", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, seen } = wizardUi({
    select: ["Guided setup", "Stop"],
    input: [dir],
    confirm: [true], // accept up; it fails; Stop
  });
  const { deps, attached, dashboards } = wizardDeps({
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      return { code: 1 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0].args, [cliPathOf(dir), "up"], "the child's own y/N gates are the consents — never --yes");
  assert.ok(!attached[0].args.includes("--yes"));
  assert.equal(attached[0].cwd, dir);
  assert.match(seen.select[1].title, /up exited 1/);
  assert.equal(seen.confirm.length, 1, "Stop: the pointer step was never reached");
  assert.equal(dashboards.length, 0);
});

test("wizard: a failed up with 'Continue anyway' proceeds to the pointer step", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, seen } = wizardUi({
    select: ["Guided setup", "Continue anyway", "Skip"],
    input: [dir],
    confirm: [true, false, false], // up (fails), pointer declined, github declined
  });
  const { deps, dashboards } = wizardDeps({
    runAttachedFn: async () => ({ code: 3 }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.ok(seen.confirm.some((c) => /pointer/.test(c.title)), "the wizard continued past the failure");
  assert.equal(dashboards.length, 1);
});

test("wizard: the pointer is written only after a confirm showing the JSON verbatim, then re-applied", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, seen } = wizardUi({
    select: ["Guided setup", "Skip"],
    input: [dir],
    confirm: [false, true, false], // up declined, POINTER ACCEPTED, github declined
  });
  const { deps, pointerWrites, order } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(pointerWrites.length, 1);
  const { path, pointer } = pointerWrites[0];
  assert.equal(path, deps.env.PI_DISPATCH_DEPLOYMENT_FILE, "written where pointerPath(env) says");
  assert.equal(pointer.version, 1);
  assert.equal(pointer.deploymentDir, dir);
  assert.deepEqual(pointer.env, {
    PI_TRIGGERS_FILE: join(dir, "triggers.json"),
    PI_PAUSE_WINDOWS_FILE: join(dir, "pause-windows.json"),
    PI_SUBSCRIPTIONS_FILE: join(dir, "subscriptions.json"),
  });
  const pointerConfirm = seen.confirm.find((c) => /pointer/.test(c.title));
  assert.ok(pointerConfirm.message.includes(JSON.stringify(pointer, null, 2)), "the confirm shows the exact JSON-to-be");
  assert.ok(pointerConfirm.message.includes(dir), "including the deploymentDir");
  assert.deepEqual(order, ["write", "reapply"], "re-applied AFTER the write, so this session picks it up");
});

// ── the first-trigger step ───────────────────────────────────────────────────────────────────────

/** Wrap the real fs, recording every write/mkdir path, so "never writes into the repo" is assertable. */
function recordingFs() {
  const writes = [];
  return {
    writes,
    fs: {
      mkdirSync: (p, o) => {
        writes.push(String(p));
        return realFs.mkdirSync(p, o);
      },
      writeFileSync: (p, d) => {
        writes.push(String(p));
        return realFs.writeFileSync(p, d);
      },
      renameSync: (a, b) => {
        writes.push(String(b));
        return realFs.renameSync(a, b);
      },
      existsSync: (p) => realFs.existsSync(p),
      readFileSync: (p, e) => realFs.readFileSync(p, e),
      readdirSync: (p) => realFs.readdirSync(p),
    },
  };
}

test("wizard: the first trigger targets ctx.cwd, lists real repo skills, and writes only the deploy dir", async () => {
  const repo = mkdtempSync(join(tmpdir(), "admin-setup-repo-"));
  // One offerable skill, one gate-refused name (uppercase+space fails SKILL_NAME_RE), one without SKILL.md.
  mkdirSync(join(repo, ".pi", "skills", "nightly-tidy"), { recursive: true });
  writeFileSync(join(repo, ".pi", "skills", "nightly-tidy", "SKILL.md"), "# tidy\n");
  mkdirSync(join(repo, ".pi", "skills", "Bad Name"), { recursive: true });
  writeFileSync(join(repo, ".pi", "skills", "Bad Name", "SKILL.md"), "# nope\n");
  mkdirSync(join(repo, ".pi", "skills", "no-skill-md"), { recursive: true });

  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup", "Skip", "A cron trigger for this repo", "nightly-tidy"],
    input: [dir, "", "", ""], // dir, id blank→nightly, pattern blank→0 3 * * *, task blank→run the flow
    confirm: [false, false, false],
  });
  const rec = recordingFs();
  const triggerWrites = [];
  const { deps } = wizardDeps({
    fs: rec.fs,
    writeTriggersFn: ({ triggersPath, mutate }) => {
      triggerWrites.push({ triggersPath, list: mutate([]) });
      return { ok: true };
    },
  });
  const paths = { triggersPath: "/decoy/triggers.json" };
  await mod.runSetupWizard(paths, tuiCtx(ui, repo), ui.notify, deps);

  const flowSelect = seen.select.find((s) => /flow/.test(s.title));
  assert.deepEqual(flowSelect.options, ["nightly-tidy", "type another…"], "SKILL_NAME_RE + SKILL.md filter the offer");

  assert.equal(triggerWrites.length, 1);
  assert.equal(triggerWrites[0].triggersPath, join(dir, "triggers.json"), "the DEPLOY dir's file — where the pointer aims the panel");
  assert.notEqual(triggerWrites[0].triggersPath, paths.triggersPath, "never the pre-wizard resolved path");
  const entry = triggerWrites[0].list[0];
  assert.deepEqual(entry, {
    on: { type: "cron", id: "nightly", pattern: "0 3 * * *" },
    run: { kind: "local", folder: repo, flow: "nightly-tidy", task: "run the flow" },
  });

  assert.ok(notes.some((n) => n.t === "warning" && /IN PLACE with no undo/.test(n.m)), "the in-place-edit warning fired");
  assert.ok(notes.some((n) => /ai-trigger: allow/.test(n.m)), "the frontmatter line is notified, not written");
  for (const p of rec.writes) {
    assert.ok(!p.startsWith(repo), `the wizard must never write into the repo: ${p}`);
  }
});

test("wizard: an invalid cron id refuses at the dialog and skips the trigger", async () => {
  const repo = mkdtempSync(join(tmpdir(), "admin-setup-repo-"));
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes } = wizardUi({
    select: ["Guided setup", "Skip", "A cron trigger for this repo"],
    // No .pi/skills in this repo, so flow is a free input: dir, flow, then the bad id.
    input: [dir, "tidy", "night:ly"],
    confirm: [false, false, false],
  });
  const triggerWrites = [];
  const { deps } = wizardDeps({
    writeTriggersFn: (args) => {
      triggerWrites.push(args);
      return { ok: true };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui, repo), ui.notify, deps);
  assert.ok(notes.some((n) => n.t === "error" && /invalid cron id/.test(n.m)), "the ':' id is refused with the charset named");
  assert.equal(triggerWrites.length, 0, "nothing was written");
});

test("wizard: no first-trigger offer when ctx.cwd is unset or missing on disk", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  for (const cwd of [undefined, join(emptyDir(), "absent-subdir")]) {
    const { ui, seen } = wizardUi({
      select: ["Guided setup", "Skip"],
      input: [dir],
      confirm: [false, false, false],
    });
    const triggerWrites = [];
    const { deps } = wizardDeps({
      writeTriggersFn: (args) => {
        triggerWrites.push(args);
        return { ok: true };
      },
    });
    await mod.runSetupWizard({}, tuiCtx(ui, cwd), ui.notify, deps);
    assert.ok(!seen.select.some((s) => /First trigger/.test(s.title)), "the step is not offered without a real folder");
    assert.equal(triggerWrites.length, 0);
  }
});

test("listRepoSkills: filters by SKILL_NAME_RE and SKILL.md presence; [] on any error", () => {
  const repo = mkdtempSync(join(tmpdir(), "admin-setup-skills-"));
  mkdirSync(join(repo, ".pi", "skills", "fix"), { recursive: true });
  writeFileSync(join(repo, ".pi", "skills", "fix", "SKILL.md"), "");
  mkdirSync(join(repo, ".pi", "skills", "review"), { recursive: true });
  writeFileSync(join(repo, ".pi", "skills", "review", "SKILL.md"), "");
  mkdirSync(join(repo, ".pi", "skills", "UPPER"), { recursive: true });
  writeFileSync(join(repo, ".pi", "skills", "UPPER", "SKILL.md"), "");
  mkdirSync(join(repo, ".pi", "skills", "empty-one"), { recursive: true });
  assert.deepEqual(mod.listRepoSkills(repo).sort(), ["fix", "review"]);
  assert.deepEqual(mod.listRepoSkills(join(repo, "nope")), [], "a missing .pi/skills is an empty offer, not a throw");
});

// ── the one-time startup nudge ───────────────────────────────────────────────────────────────────

/** Register the nudge against a crud-style pi Proxy and capture the session_start handler. */
function nudgeSetup({ env = {}, scaffoldCwd = false } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "admin-nudge-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "admin-nudge-cwd-"));
  if (scaffoldCwd) {
    for (const f of [".env", "triggers.json", "pause-windows.json", "subscriptions.json"]) writeFileSync(join(cwd, f), "");
  }
  let handler;
  const pi = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === "on"
          ? (evt, h) => {
              if (evt === "session_start") handler = h;
            }
          : () => {},
    },
  );
  mod.registerNudge(pi, { env: { PI_CODING_AGENT_DIR: agentDir, ...env } });
  const notes = [];
  const dialogs = [];
  const ctx = {
    hasUI: true,
    cwd,
    ui: {
      notify: (m, t) => notes.push([m, t]),
      select: () => dialogs.push("select"),
      input: () => dialogs.push("input"),
      confirm: () => dialogs.push("confirm"),
    },
  };
  return { handler, notes, dialogs, ctx, agentDir, cwd };
}

test("nudge: registers a session_start handler; reload and no-UI starts are inert", () => {
  const n = nudgeSetup();
  assert.equal(typeof n.handler, "function");
  n.handler({ type: "session_start", reason: "reload" }, n.ctx);
  assert.equal(n.notes.length, 0, "reload never nudges");
  n.handler({ type: "session_start", reason: "startup" }, { ...n.ctx, hasUI: false });
  assert.equal(n.notes.length, 0, "no UI, no nudge");
  assert.equal(existsSync(join(n.agentDir, "pi-dispatch-setup.nudged")), false, "an inert start writes no marker");
});

test("nudge: fires once with notify only, then the marker suppresses it for good", () => {
  const n = nudgeSetup();
  n.handler({ type: "session_start", reason: "startup" }, n.ctx);
  assert.equal(n.notes.length, 1);
  assert.match(n.notes[0][0], /\/dispatch setup/);
  assert.equal(n.notes[0][1], "info");
  assert.equal(n.dialogs.length, 0, "notify-only: no dialog is ever raised at session start");
  assert.equal(existsSync(join(n.agentDir, "pi-dispatch-setup.nudged")), true, "the once-ever marker exists");
  n.handler({ type: "session_start", reason: "startup" }, n.ctx);
  assert.equal(n.notes.length, 1, "the marker suppresses every later startup");
});

test("nudge: any configured signal — env sextet, pointer file, cwd scaffold — keeps it quiet", () => {
  // VALKEY_URL is part of the NUDGE's sextet (unlike detection's env branch): no probe is allowed
  // here, so an exported queue URL is the closest sync evidence of intent.
  const withEnv = nudgeSetup({ env: { VALKEY_URL: "redis://127.0.0.1:1" } });
  withEnv.handler({ type: "session_start", reason: "startup" }, withEnv.ctx);
  assert.equal(withEnv.notes.length, 0, "an exported VALKEY_URL suppresses the nudge");

  const withPointer = nudgeSetup();
  writeFileSync(
    join(withPointer.agentDir, "pi-dispatch-deployment.json"),
    JSON.stringify({ version: 1, deploymentDir: "/srv/deploy", env: {} }),
  );
  withPointer.handler({ type: "session_start", reason: "startup" }, withPointer.ctx);
  assert.equal(withPointer.notes.length, 0, "a present pointer suppresses the nudge");

  const withScaffold = nudgeSetup({ scaffoldCwd: true });
  withScaffold.handler({ type: "session_start", reason: "startup" }, withScaffold.ctx);
  assert.equal(withScaffold.notes.length, 0, "a cwd scaffold suppresses the nudge");
});
