import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Load through pi's own jiti 2.7.0 — the production extension loader — resolved
// relative to the pi package so the test exercises the real loader, not a
// second copy. import.meta.resolve returns the ESM ("import" condition) URL;
// the pi package exposes no "require" condition, so createRequire is anchored
// on that URL.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);

const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const shimPath = fileURLToPath(new URL("../../.pi/extensions/dispatch.ts", import.meta.url));
const probePath = fileURLToPath(new URL("./fixtures/worker-import-probe.ts", import.meta.url));
const pkgUrl = new URL("../package.json", import.meta.url);

test("(a) jiti loads index.ts as a well-formed extension module", async () => {
  const mod = await jiti.import(indexPath);
  assert.equal(typeof mod.default, "function", "default export is the factory");
  assert.ok(Array.isArray(mod.USED_API) && mod.USED_API.length > 0, "USED_API is non-empty");

  const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));
  const pin = pkg.devDependencies["@earendil-works/pi-coding-agent"];
  assert.equal(
    mod.SUPPORTED_PI_VERSION,
    pin,
    "SUPPORTED_PI_VERSION tracks the devDep pin — they cannot drift",
  );
});

test("(b) the .pi/extensions shim re-exports the same factory", async () => {
  const mod = await jiti.import(indexPath);
  const shim = await jiti.import(shimPath);
  assert.equal(shim.default, mod.default, "shim default is the index factory");
  assert.equal(shim.SUPPORTED_PI_VERSION, mod.SUPPORTED_PI_VERSION);
  assert.deepEqual(shim.USED_API, mod.USED_API);
});

test("(c) jiti resolves the @edgehero/pi-dispatch workspace export", async () => {
  const probe = await jiti.import(probePath);
  assert.equal(probe.ok, true, "settingsFilePath imported through the workspace exports map");
});

test("(d) capability probe is all-or-nothing", async () => {
  const mod = await jiti.import(indexPath);
  const factory = mod.default;

  // Missing registerCommand: no throw, one loud stderr line naming the version.
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    factory({});
  } finally {
    console.error = origError;
  }
  assert.equal(errors.length, 1, "exactly one refusal line");
  assert.match(errors[0], new RegExp(mod.SUPPORTED_PI_VERSION.replace(/\./g, "\\.")));
  assert.match(errors[0], /registerCommand/);

  // Present every USED_API member: exactly one command registration named "dispatch".
  const calls = [];
  const pi = {
    sendMessage: () => {},
    registerCommand: (name, def) => calls.push([name, def]),
    registerTool: () => {},
    on: () => {},
  };
  factory(pi);
  assert.equal(calls.length, 1, "exactly one command registration");
  const [name, def] = calls[0];
  assert.equal(name, "dispatch");
  assert.equal(typeof def.handler, "function");

  // A write subcommand notifies through ctx.ui.notify and resolves without touching the model channel.
  // `set` with no key is a usage error surfaced to notify (never sendMessage).
  const notes = [];
  await def.handler("set", { ui: { notify: (...a) => notes.push(a) } });
  assert.equal(notes.length, 1);
  assert.match(notes[0][0], /set/);
  assert.equal(notes[0][1], "error");
});
