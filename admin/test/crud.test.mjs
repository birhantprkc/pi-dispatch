import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The command-side CRUD driver (index.ts `handleDashboardAction`) runs pi's ctx.ui dialogs and calls the
// validated/atomic writeTriggers/writeSettings. Loaded through pi's jiti (the extension is erasable TS).
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const { handleDashboardAction } = indexMod;

/** Load the extension against a recording `pi` and return the registered tools by name. */
function registeredTools() {
  const tools = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) });
  indexMod.default(pi);
  return tools;
}
const toolByName = (name) => registeredTools().find((t) => t.name === name);
/** A ctx whose `confirm` records the (title, message) it is shown and returns a canned answer. */
function toolCtx({ hasUI = true, answer = true } = {}) {
  const shown = [];
  const ui = { confirm: async (title, message) => { shown.push({ title, message }); return answer; } };
  return { ctx: { hasUI, ui: hasUI ? ui : {} }, shown };
}
const textOf = (res) => JSON.parse(res.content[0].text);

/** A mock ctx.ui: `select`/`input`/`confirm` return canned answers in order; `notify` records. */
function mockUi({ select = [], input = [], confirm = [] } = {}) {
  const notes = [];
  const sel = [...select];
  const inp = [...input];
  const con = [...confirm];
  return {
    notes,
    async select() {
      return sel.shift();
    },
    async input() {
      return inp.shift();
    },
    async confirm() {
      return con.shift();
    },
    notify: (m, t) => notes.push({ m, t }),
  };
}

function tmpTriggers(initial) {
  const dir = mkdtempSync(join(tmpdir(), "pi-crud-"));
  const path = join(dir, "triggers.json");
  writeFileSync(path, JSON.stringify(initial));
  return path;
}
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

test("addTrigger: kind-first dialogs write a validated label trigger (live-reloadable)", async () => {
  const path = tmpTriggers({ triggers: [] });
  const ui = mockUi({ select: ["label"], input: ["pi:fix urgent", "frontend-fix"] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui });
  const w = read(path);
  assert.equal(w.triggers.length, 1);
  assert.equal(w.triggers[0].on.type, "label");
  assert.deepEqual(w.triggers[0].on.any, ["pi:fix", "urgent"]);
  assert.equal(w.triggers[0].run.flow, "frontend-fix");
  assert.ok(ui.notes.some((n) => /added \(live\)/.test(n.m)), "a live-added notice is shown");
});

test("addTrigger: a cron entry pairs with local by construction (the diagonal is not offered)", async () => {
  const path = tmpTriggers({ triggers: [] });
  // The cron form prompts id/pattern/folder/flow/task, then the optional model/provider/maxTurns (blank here).
  const ui = mockUi({ select: ["cron"], input: ["nightly", "0 3 * * *", "/srv/site", "tidy", "run tidy", "", "", ""] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui });
  const t = read(path).triggers[0];
  assert.equal(t.on.type, "cron");
  assert.equal(t.run.kind, "local"); // never github — the form only builds the diagonal partner
  assert.equal(t.run.folder, "/srv/site");
  assert.ok(!("model" in t.run), "a blank model override is omitted, resolving the deployment default");
});

test("addTrigger: a cron entry can pin its own model/provider/maxTurns", async () => {
  const path = tmpTriggers({ triggers: [] });
  const ui = mockUi({ select: ["cron"], input: ["nightly", "0 3 * * *", "/srv/site", "tidy", "run tidy", "claude-sonnet-5", "anthropic", "20"] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui });
  const t = read(path).triggers[0];
  assert.equal(t.run.model, "claude-sonnet-5");
  assert.equal(t.run.provider, "anthropic");
  assert.equal(t.run.maxTurns, 20, "maxTurns is coerced to a number");
});

test("editTrigger: updates the flow in place", async () => {
  const path = tmpTriggers({ triggers: [{ on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "old" } }] });
  await handleDashboardAction({ action: "editTrigger", index: 0 }, { triggersPath: path }, { ui: mockUi({ input: ["newflow"] }) });
  assert.equal(read(path).triggers[0].run.flow, "newflow");
});

test("deleteTrigger: removes on confirm, no-ops on decline", async () => {
  const two = { triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "f1" } }, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "f2" } }] };
  const path = tmpTriggers(two);
  await handleDashboardAction({ action: "deleteTrigger", index: 0 }, { triggersPath: path }, { ui: mockUi({ confirm: [false] }) });
  assert.equal(read(path).triggers.length, 2, "a declined confirm leaves the file untouched");
  await handleDashboardAction({ action: "deleteTrigger", index: 0 }, { triggersPath: path }, { ui: mockUi({ confirm: [true] }) });
  assert.deepEqual(read(path).triggers.map((t) => t.on.type), ["comment"]);
});

test("editSettings: pick a key + value writes the overlay; blank unsets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-crud-"));
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ dailyCap: 25 }));
  await handleDashboardAction({ action: "editSettings" }, { settingsFile }, { ui: mockUi({ select: ["dailyCap"], input: ["50"] }) });
  assert.equal(read(settingsFile).dailyCap, 50);
  await handleDashboardAction({ action: "editSettings" }, { settingsFile }, { ui: mockUi({ select: ["dailyCap"], input: [""] }) });
  assert.equal("dailyCap" in read(settingsFile), false, "a blank value unsets the key");
});

test("a cancelled dialog (undefined) is a no-op", async () => {
  const path = tmpTriggers({ triggers: [] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui: mockUi({ select: [undefined] }) });
  assert.equal(read(path).triggers.length, 0);
});

test("a build without the dialog primitives degrades to a notice, no write", async () => {
  const path = tmpTriggers({ triggers: [] });
  const notes = [];
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui: { notify: (m, t) => notes.push({ m, t }) } });
  assert.equal(read(path).triggers.length, 0);
  assert.ok(notes.some((n) => /newer pi/.test(n.m)), "the missing-dialog notice is shown");
});

/**
 * The model-callable WRITE tools are the confirm gate in code: the model emits the call, a human answers the
 * confirm. These prove the three arms of `confirmedWrite` at the tool boundary -- no UI refuses (throws), a
 * decline applies nothing, an approval writes -- plus that the confirm shows the concrete change, plus the
 * out-of-range guard. Each tool reads its paths from process.env, so the temp files are wired through it.
 */
function withSettings(initial) {
  const settingsFile = join(mkdtempSync(join(tmpdir(), "pi-set-")), "settings.json");
  writeFileSync(settingsFile, JSON.stringify(initial));
  process.env.PI_SETTINGS_FILE = settingsFile;
  return settingsFile;
}

test("dispatch_set: refuses (throws) with no interactive operator and writes nothing", async () => {
  const settingsFile = withSettings({ dailyCap: 25 });
  const { ctx } = toolCtx({ hasUI: false });
  await assert.rejects(
    () => toolByName("dispatch_set").execute("id", { key: "dailyCap", value: "99" }, undefined, undefined, ctx),
    /refused|interactive operator/,
  );
  assert.equal(read(settingsFile).dailyCap, 25, "no write without a confirm-capable UI");
});

test("dispatch_set: a declined confirm applies nothing, and the confirm shows before->after", async () => {
  const settingsFile = withSettings({ dailyCap: 25 });
  const { ctx, shown } = toolCtx({ answer: false });
  const out = textOf(await toolByName("dispatch_set").execute("id", { key: "dailyCap", value: "99" }, undefined, undefined, ctx));
  assert.equal(out.applied, false);
  assert.equal(read(settingsFile).dailyCap, 25, "a decline leaves the value untouched");
  assert.match(shown[0].message, /dailyCap: 25 -> 99/, "the operator saw the concrete change");
});

test("dispatch_set: an approved confirm writes the coerced value", async () => {
  const settingsFile = withSettings({ dailyCap: 25 });
  const { ctx } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_set").execute("id", { key: "dailyCap", value: "30" }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  assert.equal(read(settingsFile).dailyCap, 30, "written as a coerced JSON number");
});

test("dispatch_set: an unknown key throws before any confirm", async () => {
  withSettings({ dailyCap: 25 });
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(
    () => toolByName("dispatch_set").execute("id", { key: "dailycap", value: "5" }, undefined, undefined, ctx),
    /unknown key/,
  );
});

test("dispatch_trigger_add: an approved confirm appends a validated entry", async () => {
  const path = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "frontend-fix", labels: ["pi:fix"] }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const w = read(path);
  assert.equal(w.triggers[0].on.type, "label");
  assert.deepEqual(w.triggers[0].on.any, ["pi:fix"]);
  assert.equal(w.triggers[0].run.flow, "frontend-fix");
  assert.match(shown[0].message, /triggers\.json/, "the confirm shows the entry being added");
});

test("dispatch_trigger_add: a cron entry carries an approved model/maxTurns override", async () => {
  const path = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_trigger_add").execute(
    "id",
    { kind: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv", flow: "tidy", task: "run", model: "claude-opus-4-8", maxTurns: 40 },
    undefined, undefined, ctx,
  ));
  assert.equal(out.applied, true);
  const t = read(path).triggers[0];
  assert.equal(t.run.model, "claude-opus-4-8");
  assert.equal(t.run.maxTurns, 40);
  assert.equal(t.on.type, "cron");
});

test("dispatch_trigger_edit: an approved confirm changes the flow and shows old->new", async () => {
  const path = tmpTriggers({ triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "old" } }] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx, shown } = toolCtx({ answer: true });
  await toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "new" }, undefined, undefined, ctx);
  assert.equal(read(path).triggers[0].run.flow, "new");
  assert.match(shown[0].message, /old -> new/);
});

test("dispatch_trigger_delete: out-of-range index throws and writes nothing", async () => {
  const path = tmpTriggers({ triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "f" } }] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(
    () => toolByName("dispatch_trigger_delete").execute("id", { index: 9 }, undefined, undefined, ctx),
    /no trigger at index/,
  );
  assert.equal(read(path).triggers.length, 1);
});

test("the extension advertises the operate-pi-dispatch skill via resources_discover", () => {
  let handler;
  const pi = new Proxy({}, {
    get: (_t, k) => (k === "on" ? (evt, h) => { if (evt === "resources_discover") handler = h; } : () => {}),
  });
  indexMod.default(pi);
  assert.equal(typeof handler, "function", "registered a resources_discover handler");
  const res = handler({ type: "resources_discover", cwd: "/", reason: "startup" }, {});
  assert.ok(Array.isArray(res.skillPaths) && res.skillPaths.length === 1, "advertises one skill dir");
  assert.ok(existsSync(join(res.skillPaths[0], "operate-pi-dispatch", "SKILL.md")), "the dir holds the skill");
});

// ── scoped pause windows (REQ-SCOPED-PAUSE-WINDOWS): same confirm-gated CRUD as triggers ─────────────────
function tmpPauses(initial) {
  const path = join(mkdtempSync(join(tmpdir(), "pi-pw-")), "pause-windows.json");
  writeFileSync(path, JSON.stringify(initial));
  process.env.PI_PAUSE_WINDOWS_FILE = path;
  return path;
}

test("dispatch_pause_add: an approved confirm writes a validated window (tz/days carried)", async () => {
  const path = tmpPauses({ windows: [] });
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_pause_add").execute("id", { scope: "acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam", days: ["fri"] }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const w = read(path).windows[0];
  assert.equal(w.scope, "acme/web");
  assert.equal(w.from, "22:00");
  assert.equal(w.tz, "Europe/Amsterdam");
  assert.deepEqual(w.days, ["fri"]);
  assert.match(shown[0].message, /pause-windows\.json/);
});

test("dispatch_pause_add: an invalid window (from==to) is rejected, nothing written", async () => {
  const path = tmpPauses({ windows: [] });
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(() => toolByName("dispatch_pause_add").execute("id", { scope: "x", from: "09:00", to: "09:00" }, undefined, undefined, ctx), /rejected|differ/);
  assert.equal(read(path).windows.length, 0);
});

test("dispatch_pause_add: refuses with no interactive operator and writes nothing", async () => {
  const path = tmpPauses({ windows: [] });
  const { ctx } = toolCtx({ hasUI: false });
  await assert.rejects(() => toolByName("dispatch_pause_add").execute("id", { scope: "x", from: "22:00", to: "06:00" }, undefined, undefined, ctx), /refused|interactive operator/);
  assert.equal(read(path).windows.length, 0);
});

test("dispatch_pause_delete: out-of-range index throws and writes nothing", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }] });
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(() => toolByName("dispatch_pause_delete").execute("id", { index: 9 }, undefined, undefined, ctx), /no pause window at index/);
  assert.equal(read(path).windows.length, 1);
});

test("managePauses: Add writes a validated pause window (live)", async () => {
  const path = tmpPauses({ windows: [] });
  const ui = mockUi({ select: ["Add a pause window"], input: ["acme/web", "22:00", "06:00", "", "", "", ""] });
  await handleDashboardAction({ action: "managePauses" }, { pauseWindowsPath: path }, { ui });
  const w = read(path).windows;
  assert.equal(w.length, 1);
  assert.equal(w[0].scope, "acme/web");
  assert.equal(w[0].to, "06:00");
  assert.ok(ui.notes.some((n) => /added \(live\)/.test(n.m)), "a live-added notice is shown");
});

test("managePauses: Delete removes the picked window on confirm", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }, { scope: "*", from: "00:00", to: "01:00" }] });
  const ui = mockUi({ select: ["Delete a pause window", "#1  acme/web  22:00-06:00 UTC"], confirm: [true] });
  await handleDashboardAction({ action: "managePauses" }, { pauseWindowsPath: path }, { ui });
  assert.deepEqual(read(path).windows.map((w) => w.scope), ["*"], "only the picked window is removed");
});

test("dispatch_pause_edit: an approved partial edit changes one field and keeps the rest", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam", days: ["mon", "tue"] }] });
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_pause_edit").execute("id", { index: 0, to: "07:00" }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const w = read(path).windows[0];
  assert.equal(w.to, "07:00", "the changed field");
  assert.equal(w.from, "22:00", "unchanged field kept");
  assert.equal(w.tz, "Europe/Amsterdam", "unchanged field kept");
  assert.deepEqual(w.days, ["mon", "tue"], "unchanged field kept");
  assert.match(shown[0].message, /06:00/);
  assert.match(shown[0].message, /07:00/);
});

test("dispatch_pause_edit: out-of-range index throws and writes nothing", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }] });
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(() => toolByName("dispatch_pause_edit").execute("id", { index: 9, to: "07:00" }, undefined, undefined, ctx), /no pause window at index/);
  assert.equal(read(path).windows[0].to, "06:00");
});

test("dispatch_pause_edit: refuses with no interactive operator and writes nothing", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }] });
  const { ctx } = toolCtx({ hasUI: false });
  await assert.rejects(() => toolByName("dispatch_pause_edit").execute("id", { index: 0, to: "07:00" }, undefined, undefined, ctx), /refused|interactive operator/);
  assert.equal(read(path).windows[0].to, "06:00");
});

test("managePauses: Edit re-prompts fields (blank keeps) and updates the picked window", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam" }] });
  // pick the window, then blank-keep scope/from, change `to`, blank-keep tz/days/dateFrom/dateTo.
  const ui = mockUi({ select: ["Edit a pause window", "#1  acme/web  22:00-06:00 Europe/Amsterdam"], input: ["", "", "07:00", "", "", "", ""] });
  await handleDashboardAction({ action: "managePauses" }, { pauseWindowsPath: path }, { ui });
  const w = read(path).windows[0];
  assert.equal(w.to, "07:00", "the changed field");
  assert.equal(w.from, "22:00", "kept");
  assert.equal(w.tz, "Europe/Amsterdam", "kept");
  assert.ok(ui.notes.some((n) => /updated \(live\)/.test(n.m)), "a live-updated notice is shown");
});
