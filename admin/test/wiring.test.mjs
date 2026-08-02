import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Wiring discipline for the admin extension: it registers exactly the dispatch command, reaches ONLY the
 * USED_API members of `pi` (a recording Proxy throws on any other), routes structured views through the
 * `pi-dispatch-admin` channel with `triggerTurn` never set, and -- the load-bearing invariant -- routes
 * raw `.log` output ONLY through the overlay viewer, never through `sendMessage`.
 *
 * Loaded through pi's own jiti, the production extension loader. PI_LOGS_DIR points at an empty temp dir
 * so the fs-backed paths (`runs`, `logs`) resolve offline; the network-backed paths (status/budget/
 * triggers) are covered in read-model.test.mjs, not here.
 */
process.env.PI_LOGS_DIR = mkdtempSync(join(tmpdir(), "admin-wiring-"));

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/**
 * A recording `pi` whose get-trap throws on any function member NOT in USED_API, so a handler that reached
 * for `appendEntry`, `sendUserMessage`, etc. fails the test loudly. registerCommand/registerTool/sendMessage
 * record.
 */
function recordingPi(used) {
  const usedSet = new Set(used);
  const calls = { registerCommand: [], registerTool: [], sendMessage: [] };
  const pi = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (key === "registerCommand") return (name, def) => calls.registerCommand.push([name, def]);
        if (key === "registerTool") return (tool) => calls.registerTool.push(tool);
        if (key === "sendMessage") return (message, options) => calls.sendMessage.push([message, options]);
        if (usedSet.has(key)) return () => {};
        throw new Error(`admin extension reached a non-USED_API pi member: ${key}`);
      },
    },
  );
  return { pi, calls };
}

/** The registered tool whose `name` matches, or undefined. */
function toolByName(calls, name) {
  return calls.registerTool.find((t) => t.name === name);
}

function fakeCtx({ withCustom = true } = {}) {
  const notes = [];
  const customCalls = [];
  const ui = { notify: (message, type) => notes.push([message, type]) };
  if (withCustom) {
    ui.custom = async (factory, options) => {
      customCalls.push([factory, options]);
      return undefined;
    };
  }
  return { ctx: { ui }, notes, customCalls };
}

async function loadRegistered() {
  const mod = await jiti.import(indexPath);
  const { pi, calls } = recordingPi(mod.USED_API);
  mod.default(pi);
  return { mod, calls, def: calls.registerCommand[0][1] };
}

test("registers exactly the dispatch command with a handler and completions", async () => {
  const { calls, def } = await loadRegistered();
  assert.equal(calls.registerCommand.length, 1, "exactly one registration");
  assert.equal(calls.registerCommand[0][0], "dispatch");
  assert.equal(typeof def.handler, "function");
  assert.equal(typeof def.getArgumentCompletions, "function");
});

test("USED_API is exactly the members the extension reaches", async () => {
  const { mod } = await loadRegistered();
  // `on` joins the set: the extension advertises its bundled skill via the `resources_discover` event.
  assert.deepEqual([...mod.USED_API].sort(), ["on", "registerCommand", "registerTool", "sendMessage"]);
});

test("the bare command opens the dashboard overlay and never touches the model channel", async () => {
  const { calls, def } = await loadRegistered();
  const view = fakeCtx({ withCustom: true });
  await def.handler("", view.ctx);
  assert.equal(view.customCalls.length, 1, "bare /dispatch opens the dashboard overlay");
  assert.equal(view.customCalls[0][1]?.overlay, true, "as an overlay");
  assert.equal(calls.sendMessage.length, 0, "the dashboard never sends into model context");
});

test("the bare command without overlay support degrades to a usage note, never the model channel", async () => {
  const { calls, def } = await loadRegistered();
  const noCustom = fakeCtx({ withCustom: false });
  await def.handler("", noCustom.ctx);
  assert.equal(noCustom.customCalls.length, 0);
  assert.equal(noCustom.notes.length, 1, "fails to a note, not a silent no-op");
  assert.match(noCustom.notes[0][0], /usage|dashboard/);
  assert.equal(calls.sendMessage.length, 0);
});

test("an unknown subcommand notifies and never touches the model channel", async () => {
  const { calls, def } = await loadRegistered();
  const unknown = fakeCtx();
  await def.handler("bogus", unknown.ctx);
  assert.match(unknown.notes[0][0], /unknown subcommand/);
  assert.equal(calls.sendMessage.length, 0, "usage paths must not send into model context");
});

/**
 * The model-facing control surface (DES-ADMIN-VIA-PI-EXTENSION, amended): reads
 * (`dispatch_status`/`_runs`/`_costs`/`_triggers`), the on/off controls (`_pause`/`_resume`), the gated PAID enqueue
 * (`_run`), and the confirm-gated writes (`_set`, `_trigger_add`/`_edit`/`_delete`). Two invariants are locked
 * here: there is still NO raw-log tool (no name contains "log"), and every WRITE tool is `sequential` so two
 * writes cannot interleave. This test is the deliberate record that model-callable writes were added on
 * purpose -- gated by an operator confirm (behaviour proven in crud.test.mjs), not tool absence.
 */
const WRITE_TOOLS = ["dispatch_set", "dispatch_trigger_add", "dispatch_trigger_edit", "dispatch_trigger_delete", "dispatch_pause_add", "dispatch_pause_edit", "dispatch_pause_delete"];
test("registers exactly the read/control/enqueue/write tools, and never a raw-log tool", async () => {
  const { calls } = await loadRegistered();
  const names = calls.registerTool.map((t) => t.name).sort();
  assert.equal(calls.registerTool.length, 15, "exactly fifteen tools");
  assert.deepEqual(names, [
    "dispatch_costs",
    "dispatch_pause",
    "dispatch_pause_add",
    "dispatch_pause_delete",
    "dispatch_pause_edit",
    "dispatch_pauses",
    "dispatch_resume",
    "dispatch_run",
    "dispatch_runs",
    "dispatch_set",
    "dispatch_status",
    "dispatch_trigger_add",
    "dispatch_trigger_delete",
    "dispatch_trigger_edit",
    "dispatch_triggers",
  ]);
  for (const name of names) {
    assert.ok(!/log/.test(name), `no raw-log tool: ${name}`);
  }
  for (const name of WRITE_TOOLS) {
    assert.equal(toolByName(calls, name).executionMode, "sequential", `${name} is sequential`);
  }
  for (const tool of calls.registerTool) {
    assert.equal(typeof tool.execute, "function", `${tool.name}.execute is a function`);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.parameters && tool.parameters.type === "object", `${tool.name} has an object param schema`);
  }
});

/**
 * `dispatch_run` is the one PAID, model-callable enqueue. Its description must flag the paid, gated,
 * no-undo nature (an operator or a model reading it should see the risk), and it is sequential so two
 * enqueues cannot interleave. Its params are the three job inputs ONLY -- no spend knob.
 */
test("dispatch_run advertises PAID/ai-trigger/no-force, is sequential, and takes no spend knob", async () => {
  const { calls } = await loadRegistered();
  const run = toolByName(calls, "dispatch_run");
  assert.match(run.description, /PAID/, "flags that the run is paid");
  assert.match(run.description, /ai-trigger/, "names the committed opt-in gate");
  assert.match(run.description, /no force/, "states there is no force option for a dirty tree");
  assert.equal(run.executionMode, "sequential");
  const props = run.parameters.properties ?? {};
  assert.deepEqual(Object.keys(props).sort(), ["flow", "folder", "task"], "exactly the three job inputs");
  for (const knob of ["model", "maxTurns", "dailyCap", "weeklyCap", "monthlyCap", "concurrency", "softHoldPct"]) {
    assert.ok(!(knob in props), `no spend-knob param: ${knob}`);
  }
});

test("pause/resume are sequential; the reads leave executionMode default", async () => {
  const { calls } = await loadRegistered();
  assert.equal(toolByName(calls, "dispatch_pause").executionMode, "sequential");
  assert.equal(toolByName(calls, "dispatch_resume").executionMode, "sequential");
  assert.equal(toolByName(calls, "dispatch_status").executionMode, undefined);
  assert.equal(toolByName(calls, "dispatch_runs").executionMode, undefined);
});

test("dispatch_runs advertises that raw logs are off-limits, and its params are optional", async () => {
  const { calls } = await loadRegistered();
  const runs = toolByName(calls, "dispatch_runs");
  assert.match(runs.description, /not available to tools/);
  const props = runs.parameters.properties ?? {};
  assert.ok(props.limit && props.jobId, "limit and jobId are declared");
  const required = runs.parameters.required ?? [];
  assert.ok(!required.includes("limit") && !required.includes("jobId"), "both are optional");
});

/**
 * dispatch_runs.execute reads the durable history off disk (self-closing one-shot, offline-testable via a
 * temp logsDir). The load-bearing assertion: even with a `.log` sitting beside the `.json`, the returned
 * text carries only the PII-free record and never a byte of the raw log.
 */
test("dispatch_runs.execute returns run records as JSON and never any .log content", async () => {
  const prevLogsDir = process.env.PI_LOGS_DIR;
  const dir = mkdtempSync(join(tmpdir(), "admin-runtool-"));
  const record = {
    jobId: "j-log",
    target: "o/r#1",
    flow: "fix",
    outcome: "completed",
    reason: null,
    turns: 3,
    endedAt: "2026-07-21T00:00:00.000Z",
  };
  writeFileSync(join(dir, "j-log.json"), JSON.stringify(record));
  writeFileSync(join(dir, "j-log.log"), "SECRET_LOG_MARKER raw container bytes");
  process.env.PI_LOGS_DIR = dir;

  try {
    const { calls } = await loadRegistered();
    const runs = toolByName(calls, "dispatch_runs");

    const list = await runs.execute("call-1", {});
    const listText = list.content[0].text;
    const parsed = JSON.parse(listText);
    assert.ok(Array.isArray(parsed) && parsed.some((r) => r.jobId === "j-log"), "returns the record");
    assert.ok(!listText.includes("SECRET_LOG_MARKER"), "list path never carries raw .log bytes");

    const one = await runs.execute("call-2", { jobId: "j-log" });
    const oneText = one.content[0].text;
    assert.equal(JSON.parse(oneText).jobId, "j-log", "jobId path returns the single record");
    assert.ok(!oneText.includes("SECRET_LOG_MARKER"), "jobId path never carries raw .log bytes");
  } finally {
    process.env.PI_LOGS_DIR = prevLogsDir;
  }
});

/**
 * pause/resume.execute route into setQueuePaused, whose pause/resume/unreachable outcomes are covered live
 * in read-model.test.mjs against a fake queue. They are not injectable at the tool boundary (execute reads
 * process.env and constructs its own connection), so here we assert only the registration shape and defer
 * the live behaviour to the read-model tests -- exercising them here would depend on a running Valkey.
 */
test("pause/resume tools expose an execute function (behaviour lives in read-model tests)", async () => {
  const { calls } = await loadRegistered();
  assert.equal(typeof toolByName(calls, "dispatch_pause").execute, "function");
  assert.equal(typeof toolByName(calls, "dispatch_resume").execute, "function");
});

test("runs renders into the pi-dispatch-admin channel with triggerTurn unset", async () => {
  const { calls, def } = await loadRegistered();
  await def.handler("runs", fakeCtx().ctx);
  assert.equal(calls.sendMessage.length, 1);
  const [message, options] = calls.sendMessage[0];
  assert.equal(message.customType, "pi-dispatch-admin");
  assert.equal(message.display, true);
  assert.equal(typeof message.content, "string");
  assert.ok(!options || !options.triggerTurn, "must never trigger a paid turn to observe state");
});

test("costs renders into the pi-dispatch-admin channel with triggerTurn unset", async () => {
  const { calls, def } = await loadRegistered();
  await def.handler("costs", fakeCtx().ctx);
  assert.equal(calls.sendMessage.length, 1);
  const [message, options] = calls.sendMessage[0];
  assert.equal(message.customType, "pi-dispatch-admin");
  assert.equal(message.display, true);
  assert.match(message.content, /Costs \(/, "the costs view text is the message");
  assert.ok(!options || !options.triggerTurn, "must never trigger a paid turn to observe state");
});

/**
 * dispatch_costs.execute folds the on-disk history against the declared subscriptions with the REAL
 * pricing façade and returns TYPED dollars: every money value carries its `class`, so a model reading the
 * JSON cannot launder an estimate into a fact by dropping the label. Driven fully offline: a temp logs dir
 * holding one canned ledgered record, and a canned subscriptions file via PI_SUBSCRIPTIONS_FILE.
 */
test("dispatch_costs.execute returns the typed fold as JSON, class on every dollar, flow-filterable", async () => {
  const prevLogsDir = process.env.PI_LOGS_DIR;
  const prevSubs = process.env.PI_SUBSCRIPTIONS_FILE;
  const dir = mkdtempSync(join(tmpdir(), "admin-coststool-"));
  // One metered, ledgered run an hour ago -- inside any window, and no UTC-month-boundary hazard because
  // the test asks for the 7d window.
  const endedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeFileSync(
    join(dir, "cost-1.json"),
    JSON.stringify({
      jobId: "cost-1",
      target: "local:repo",
      flow: "fix",
      outcome: "completed",
      endedAt,
      provider: "anthropic",
      model: "claude-sonnet-4",
      tokens: { input: 1000, output: 500, total: 1500, cost: 0.5, metered: true, calls: 2, unpriced: 0, unresolved: 0 },
      usage: {
        v: 1,
        piAi: "1.2.3",
        truncated: 0,
        models: [{ provider: "anthropic", model: "claude-sonnet-4", calls: 2, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, total: 1500, cost: 0.5 }],
      },
    }),
  );
  const subsFile = join(dir, "subscriptions.json");
  writeFileSync(
    subsFile,
    JSON.stringify({
      version: 1,
      subscriptions: [{ id: "kimi", vendor: "Moonshot AI", provider: "kimi-coding", models: ["*"], price: { amount: 90, currency: "USD", per: "month" } }],
    }),
  );
  process.env.PI_LOGS_DIR = dir;
  process.env.PI_SUBSCRIPTIONS_FILE = subsFile;

  try {
    const { calls } = await loadRegistered();
    const costs = toolByName(calls, "dispatch_costs");
    assert.equal(costs.executionMode, undefined, "a read tool, never sequential");

    const res = await costs.execute("call-1", { window: "7d" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.window, "7d");
    assert.equal(parsed.fold.provenance.runsTotal, 1);
    assert.equal(parsed.fold.provenance.total.class, "metered", "the window total carries its class");
    assert.equal(parsed.fold.provenance.total.usd, 0.5);
    assert.equal(parsed.fold.byFlow[0].cost.class, "metered", "per-flow money is typed too");
    assert.equal(parsed.fold.byModel[0].cost.class, "metered", "per-model money is typed too");
    assert.equal(parsed.fold.plans[0].id, "kimi", "the declared subscription was read and scored");

    const filtered = await costs.execute("call-2", { window: "7d", flow: "other" });
    assert.equal(JSON.parse(filtered.content[0].text).fold.provenance.runsTotal, 0, "flow filters the fold's input records");
  } finally {
    process.env.PI_LOGS_DIR = prevLogsDir;
    if (prevSubs === undefined) delete process.env.PI_SUBSCRIPTIONS_FILE;
    else process.env.PI_SUBSCRIPTIONS_FILE = prevSubs;
  }
});

test("logs renders in the overlay viewer and NEVER via sendMessage", async () => {
  const { calls, def } = await loadRegistered();
  const view = fakeCtx({ withCustom: true });
  await def.handler("logs some-job", view.ctx);
  assert.equal(view.customCalls.length, 1, "opened the overlay viewer");
  assert.equal(view.customCalls[0][1]?.overlay, true, "as an overlay");
  assert.equal(calls.sendMessage.length, 0, "raw logs must never enter model context");
});

test("logs with no overlay support fails loud and still never calls sendMessage", async () => {
  const { calls, def } = await loadRegistered();
  const noCustom = fakeCtx({ withCustom: false });
  await def.handler("logs some-job", noCustom.ctx);
  assert.equal(noCustom.customCalls.length, 0);
  assert.equal(calls.sendMessage.length, 0, "must not fall back to the model channel");
  assert.equal(noCustom.notes.length, 1, "must fail loud, not silently no-op");
  assert.equal(noCustom.notes[0][1], "error");
  assert.match(noCustom.notes[0][0], /never sent to the model|unavailable/);
});

test("logs without a jobId notifies usage without opening a viewer", async () => {
  const { calls, def } = await loadRegistered();
  const view = fakeCtx({ withCustom: true });
  await def.handler("logs", view.ctx);
  assert.equal(view.customCalls.length, 0);
  assert.equal(calls.sendMessage.length, 0);
  assert.match(view.notes[0][0], /usage/);
});

test("argument completion offers subcommands then run ids", async () => {
  const { def } = await loadRegistered();
  const subs = await def.getArgumentCompletions("s");
  assert.ok(Array.isArray(subs) && subs.some((i) => i.value === "status" || i.value === "settings"));
  // Empty logs dir -> no ids to complete -> null (not []).
  assert.equal(await def.getArgumentCompletions("logs "), null);
  // No subcommand matches -> null.
  assert.equal(await def.getArgumentCompletions("zzz"), null);
});

test("argument completion offers the costs windows and whatif", async () => {
  const { def } = await loadRegistered();
  const all = await def.getArgumentCompletions("costs ");
  assert.deepEqual(all.map((i) => i.value), ["costs 7d", "costs 30d", "costs mtd", "costs whatif"]);
  const m = await def.getArgumentCompletions("costs m");
  assert.deepEqual(m, [{ value: "costs mtd", label: "mtd" }]);
  assert.equal(await def.getArgumentCompletions("costs zzz"), null);
});

test("argument completion offers the known settings keys for `set`/`unset`", async () => {
  const { def } = await loadRegistered();
  // "da" prefixes both dailyCap and dailyTokenCap, in KNOWN_KEYS order.
  const set = await def.getArgumentCompletions("set da");
  assert.deepEqual(set, [
    { value: "set dailyCap", label: "dailyCap" },
    { value: "set dailyTokenCap", label: "dailyTokenCap" },
  ]);
  const unset = await def.getArgumentCompletions("unset con");
  assert.deepEqual(unset, [{ value: "unset concurrency", label: "concurrency" }]);
  // No key matches -> null.
  assert.equal(await def.getArgumentCompletions("set zzz"), null);
});

/**
 * `set`/`unset` write the overlay through the read-model against a real temp file (writeOverlay is battle-
 * tested; a real fs keeps these honest). pause/resume at the handler level are NOT retested here: they route
 * straight into `setQueuePaused`, whose pause/resume/unreachable outcomes are covered in read-model.test.mjs,
 * and exercising them here would depend on a live Valkey.
 */
function withSettingsFile() {
  const file = join(mkdtempSync(join(tmpdir(), "admin-settings-")), "settings.json");
  process.env.PI_SETTINGS_FILE = file;
  return file;
}

test("set with an unknown key (wrong case) errors and never writes the file", async () => {
  const { calls, def } = await loadRegistered();
  const file = withSettingsFile();
  const ctx = fakeCtx();
  await def.handler("set dailycap 5", ctx.ctx);
  assert.equal(ctx.notes[0][1], "error");
  assert.match(ctx.notes[0][0], /unknown key/);
  assert.equal(existsSync(file), false, "an unknown-key set touches no file");
  assert.equal(calls.sendMessage.length, 0, "write acks go to notify, never the model channel");
});

test("set concurrency 11 is rejected by the validator and writes nothing", async () => {
  const { def } = await loadRegistered();
  const file = withSettingsFile();
  const ctx = fakeCtx();
  await def.handler("set concurrency 11", ctx.ctx);
  assert.equal(ctx.notes[0][1], "error");
  assert.match(ctx.notes[0][0], /concurrency/);
  assert.equal(existsSync(file), false);
});

test("set dailyCap abc is rejected (NaN coercion) and writes nothing", async () => {
  const { def } = await loadRegistered();
  const file = withSettingsFile();
  const ctx = fakeCtx();
  await def.handler("set dailyCap abc", ctx.ctx);
  assert.equal(ctx.notes[0][1], "error");
  assert.match(ctx.notes[0][0], /dailyCap/);
  assert.equal(existsSync(file), false);
});

test("set dailyCap 5 coerces the numeric string, persists it, and acks via notify", async () => {
  const { calls, def } = await loadRegistered();
  const file = withSettingsFile();
  const ctx = fakeCtx();
  await def.handler("set dailyCap 5", ctx.ctx);
  assert.equal(ctx.notes[0][1], "info");
  assert.match(ctx.notes[0][0], /set dailyCap = 5/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { dailyCap: 5 }, "coerced to a JSON number");
  assert.equal(calls.sendMessage.length, 0);
});

test("unset removes a key, leaving a valid empty overlay", async () => {
  const { def } = await loadRegistered();
  const file = withSettingsFile();
  await def.handler("set model claude-x", fakeCtx().ctx);
  const ctx = fakeCtx();
  await def.handler("unset model", ctx.ctx);
  assert.equal(ctx.notes[0][1], "info");
  assert.match(ctx.notes[0][0], /unset model/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {}, "empty overlay is a valid written state");
});
