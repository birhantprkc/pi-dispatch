import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * REQ-UPSTREAM-CONTRACT-TESTS, adapted for a type-erased extension. index.ts consumes the pi
 * `ExtensionAPI` and `ctx.ui` surfaces through a plain `pi`/`ctx` -- the types are erased at load, so a pi
 * upgrade that renames or drops a member we call would fail only at runtime, on the operator's machine.
 * These tests assert against the PINNED type declarations the lockfile resolves, so an upgrade that moves
 * an API the admin depends on fails a test here instead of a `/dispatch` command there.
 *
 * Mirrors image/runner/test/pinned-api.test.mjs's philosophy: assert the artifact, not HEAD.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);

const typesUrl = new URL(
  "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts",
  import.meta.url,
);
const typesSrc = readFileSync(fileURLToPath(typesUrl), "utf8");

const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const indexSrc = readFileSync(indexPath, "utf8");

/** Extract the body text of a named `interface X { ... }` by brace balancing. */
function extractInterface(src, name) {
  const start = src.indexOf(`interface ${name} {`);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

test("(a) the pinned extension types still declare every member the admin depends on", () => {
  // registerCommand/registerTool/sendMessage are pi.* members; getArgumentCompletions, custom, notify are
  // the command/ui surfaces the handler, logs viewer and dashboard reach through ctx. executionMode is the
  // ToolDefinition field the pause/resume tools set to "sequential".
  const needles = [
    "registerCommand(name",
    "registerTool<TParams",
    "sendMessage<T",
    "getArgumentCompletions",
    "custom<T>(",
    "notify(message",
    "executionMode",
  ];
  for (const needle of needles) {
    assert.ok(
      typesSrc.includes(needle),
      `pinned extensions/types.d.ts no longer contains "${needle}" -- a pi upgrade changed an API the admin uses`,
    );
  }
});

test("(b) every USED_API member is a method on the pinned ExtensionAPI", async () => {
  const mod = await jiti.import(indexPath);
  const block = extractInterface(typesSrc, "ExtensionAPI");
  assert.ok(block, "could not find the ExtensionAPI interface in the pinned types");
  for (const member of mod.USED_API) {
    assert.match(
      block,
      new RegExp(`\\b${member}\\s*[<(]`),
      `USED_API lists "${member}" but the pinned ExtensionAPI does not declare it as a method`,
    );
  }
});

test("(c) index.ts's pi type imports all exist in the pinned type surface", () => {
  const block = indexSrc.match(/import\s+type\s*\{([^}]+)\}\s*from\s*["']@earendil-works\/pi-coding-agent["']/);
  assert.ok(block, "could not find index.ts's `import type { ... } from pi` block");
  const names = block[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(names.length > 0, "expected at least one imported type name");
  for (const name of names) {
    assert.match(
      typesSrc,
      new RegExp(`(interface|type|class|enum)\\s+${name}\\b`),
      `index.ts imports type "${name}" but the pinned extensions/types.d.ts does not declare it`,
    );
  }
});
