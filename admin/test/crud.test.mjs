import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The command-side CRUD driver (index.ts `handleDashboardAction`) runs pi's ctx.ui dialogs and calls the
// validated/atomic writeTriggers/writeSettings. Loaded through pi's jiti (the extension is erasable TS).
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { handleDashboardAction } = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

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
  const ui = mockUi({ select: ["cron"], input: ["nightly", "0 3 * * *", "/srv/site", "tidy", "run tidy"] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui });
  const t = read(path).triggers[0];
  assert.equal(t.on.type, "cron");
  assert.equal(t.run.kind, "local"); // never github — the form only builds the diagonal partner
  assert.equal(t.run.folder, "/srv/site");
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
