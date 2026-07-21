import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
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
 * for `appendEntry`, `sendUserMessage`, etc. fails the test loudly. registerCommand/sendMessage record.
 */
function recordingPi(used) {
  const usedSet = new Set(used);
  const calls = { registerCommand: [], sendMessage: [] };
  const pi = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (key === "registerCommand") return (name, def) => calls.registerCommand.push([name, def]);
        if (key === "sendMessage") return (message, options) => calls.sendMessage.push([message, options]);
        if (usedSet.has(key)) return () => {};
        throw new Error(`admin extension reached a non-USED_API pi member: ${key}`);
      },
    },
  );
  return { pi, calls };
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
  assert.deepEqual([...mod.USED_API].sort(), ["registerCommand", "sendMessage"]);
});

test("empty and unknown subcommands notify usage and never touch the model channel", async () => {
  const { calls, def } = await loadRegistered();

  const empty = fakeCtx();
  await def.handler("", empty.ctx);
  assert.equal(empty.notes.length, 1);
  assert.match(empty.notes[0][0], /usage/);

  const unknown = fakeCtx();
  await def.handler("bogus", unknown.ctx);
  assert.match(unknown.notes[0][0], /unknown subcommand/);

  assert.equal(calls.sendMessage.length, 0, "usage paths must not send into model context");
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
