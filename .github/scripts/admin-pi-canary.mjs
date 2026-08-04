/**
 * The admin extension's pi canary (issue #96). Runs the admin's pinned-pi assumptions against an
 * ARBITRARY pi install -- in CI, @latest -- so a breaking pi release fails a build here instead of
 * an operator's /dispatch there.
 *
 * Why this exists at all: admin/package.json declares `"@earendil-works/pi-coding-agent": "*"` as
 * its peer range. That is deliberate, and this header is where the reason is recorded (JSON takes
 * no comments): pi's own packages doc prescribes `"*"` peers for host-provided packages -- pi never
 * installs a peer, the host session IS the pi -- and an exact peer pin makes every plain-npm
 * consumer ERESOLVE the moment their pi differs by a patch. The exact TESTED version still lives in
 * two places locked to each other: `SUPPORTED_PI_VERSION` in admin/src/index.ts and the admin
 * devDependency pin (admin/test/load.test.mjs asserts they cannot drift). A wildcard peer without a
 * canary would be a hope; this script is what keeps it honest.
 *
 * Usage: node .github/scripts/admin-pi-canary.mjs <scratch-dir>
 *   where <scratch-dir> holds an `npm install @earendil-works/pi-coding-agent` (any version, in CI
 *   @latest) under <scratch-dir>/node_modules. Never point it at the repo root: the repo's hoisted
 *   copy is the PIN the admin test suite anchors on, and canarying it would assert nothing.
 *
 * Asserts, against THAT install:
 *   (a) every needle from the admin's pinned-api needle list appears in its
 *       dist/core/extensions/types.d.ts
 *   (b) every USED_API member is declared as a method on its `interface ExtensionAPI`
 *   (c) `VERSION` is a runtime string export of the package root
 *   (d) the BUILT admin bundle actually loads with that pi resolvable and registers exactly one
 *       `dispatch` command with no stderr refusal line
 *
 * Resolution mechanics for (d): the bundle (admin/dist/index.mjs, pi kept external by
 * admin/build.mjs) is COPIED into the scratch dir. ESM resolves a bare specifier against the
 * IMPORTING FILE's own location, so the copy's `@earendil-works/pi-coding-agent` import walks up
 * from <scratch-dir> and finds <scratch-dir>/node_modules -- the install under test -- never the
 * repo's hoisted pin. bullmq/ioredis are external in the bundle too but are NOT under test; they
 * are satisfied by symlinking the repo's own pinned copies into the scratch node_modules (offline,
 * deterministic, no second install).
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Source of truth: admin/test/pinned-extension-api.test.mjs. That test asserts these against the
 * PINNED pi and may not import from (or be edited for) a CI script; this is a deliberate second
 * copy, and admin/test/wiring.test.mjs is the anti-drift bolt: it imports these exports and fails
 * the suite when they diverge from the pinned test's literals or from the real USED_API export.
 */
export const NEEDLES = [
  "registerCommand(name",
  "registerTool<TParams",
  "sendMessage<T",
  "getArgumentCompletions",
  "custom<T>(",
  "notify(message",
  "confirm(title",
  "select(title",
  "input(title",
  "session_start",
  "executionMode",
];

/** Mirrors USED_API in admin/src/index.ts -- deepEqual-checked by wiring.test.mjs (same bolt). */
export const USED_API_MEMBERS = ["registerCommand", "registerTool", "sendMessage", "on"];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/**
 * Extract the body text of a named `interface X { ... }` by brace balancing. A copy of the helper
 * in admin/test/pinned-extension-api.test.mjs (see the NEEDLES note on why a copy).
 */
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

let failures = 0;
function fail(msg) {
  failures++;
  console.error(`canary FAIL: ${msg}`);
}
function ok(msg) {
  console.log(`canary ok:   ${msg}`);
}

async function main(scratchArg) {
  const scratch = resolve(scratchArg);
  const piDir = join(scratch, "node_modules", "@earendil-works", "pi-coding-agent");
  if (!existsSync(join(piDir, "package.json"))) {
    console.error(`canary: no pi install at ${piDir} -- npm install @earendil-works/pi-coding-agent into the scratch dir first`);
    process.exit(2);
  }
  const piPkg = JSON.parse(readFileSync(join(piDir, "package.json"), "utf8"));
  console.log(`canary: probing @earendil-works/pi-coding-agent ${piPkg.version} at ${piDir}`);

  // ---- (a) the needle list still appears in the install's extension types ----
  const typesPath = join(piDir, "dist", "core", "extensions", "types.d.ts");
  let typesSrc;
  try {
    typesSrc = readFileSync(typesPath, "utf8");
  } catch (err) {
    fail(`cannot read ${typesPath}: ${err.message} -- pi moved its extension type declarations`);
  }
  if (typesSrc !== undefined) {
    const missing = NEEDLES.filter((needle) => !typesSrc.includes(needle));
    if (missing.length > 0) {
      fail(`extensions/types.d.ts no longer contains: ${missing.map((n) => JSON.stringify(n)).join(", ")}`);
    } else {
      ok(`(a) all ${NEEDLES.length} pinned-api needles present`);
    }

    // ---- (b) every USED_API member is a method on this install's ExtensionAPI ----
    const block = extractInterface(typesSrc, "ExtensionAPI");
    if (!block) {
      fail("could not find `interface ExtensionAPI` in the install's types.d.ts");
    } else {
      let allMembers = true;
      for (const member of USED_API_MEMBERS) {
        if (!new RegExp(`\\b${member}\\s*[<(]`).test(block)) {
          allMembers = false;
          fail(`ExtensionAPI no longer declares "${member}" as a method`);
        }
      }
      if (allMembers) ok(`(b) all ${USED_API_MEMBERS.length} USED_API members declared on ExtensionAPI`);
    }
  }

  // ---- (c) VERSION is a runtime string export of the package root ----
  const dot = piPkg.exports?.["."];
  const entryRel = typeof dot === "string" ? dot : (dot?.import ?? dot?.default ?? piPkg.main ?? "./dist/index.js");
  try {
    const piMod = await import(pathToFileURL(join(piDir, entryRel)).href);
    if (typeof piMod.VERSION === "string") {
      ok(`(c) VERSION is exported and a string ("${piMod.VERSION}")`);
    } else {
      fail(`the package root exports VERSION as ${typeof piMod.VERSION}, want string -- the admin's runtime advisory depends on it`);
    }
  } catch (err) {
    fail(`importing the package root (${entryRel}) threw: ${err.message}`);
  }

  // ---- (d) the built admin bundle loads with THIS pi and registers cleanly ----
  const builtBundle = join(repoRoot, "admin", "dist", "index.mjs");
  if (!existsSync(builtBundle)) {
    console.error("canary: admin/dist/index.mjs is missing -- run `node admin/build.mjs` first");
    process.exit(2);
  }
  // Always copy fresh so the probe can never run against a stale bundle left in the scratch dir.
  const bundleCopy = join(scratch, "admin-bundle.mjs");
  copyFileSync(builtBundle, bundleCopy);
  // The bundle's other externals (heavy runtime deps, not under test) resolve to the repo's own
  // pinned install via symlink -- nothing is ever network-installed here, and the scratch pi stays
  // the only pi in the resolution path.
  for (const dep of ["bullmq", "ioredis"]) {
    const target = join(scratch, "node_modules", dep);
    if (!existsSync(target)) symlinkSync(join(repoRoot, "node_modules", dep), target, "dir");
  }
  // Hermeticity: the factory layers the deployment pointer from pi's agent dir at load; pin that to
  // an empty dir under the scratch so the probe can never read (or be steered by) a real ~/.pi/agent.
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(scratch, "canary-agent-"));
  delete process.env.PI_DISPATCH_DEPLOYMENT_FILE;

  try {
    const mod = await import(pathToFileURL(bundleCopy).href);
    if (typeof mod.default !== "function") throw new Error("the bundle's default export is not a factory function");
    if (JSON.stringify([...mod.USED_API].sort()) !== JSON.stringify([...USED_API_MEMBERS].sort())) {
      fail(`the bundle's USED_API (${mod.USED_API}) differs from the canary's list (${USED_API_MEMBERS}) -- update USED_API_MEMBERS here`);
    }

    // A recording proxy exposing exactly the USED_API members; anything else the factory reaches
    // for throws, mirroring admin/test/wiring.test.mjs's discipline.
    const registered = [];
    const pi = new Proxy(
      {},
      {
        get(_target, key) {
          if (typeof key !== "string") return undefined;
          if (key === "registerCommand") return (name, def) => registered.push([name, def]);
          if (USED_API_MEMBERS.includes(key)) return () => {};
          throw new Error(`admin extension reached a non-USED_API pi member: ${key}`);
        },
      },
    );
    const stderrLines = [];
    const origError = console.error;
    console.error = (...a) => stderrLines.push(a.join(" "));
    try {
      mod.default(pi);
    } finally {
      console.error = origError;
    }
    if (stderrLines.length > 0) {
      fail(`the factory printed to stderr (the refusal path fired?): ${stderrLines[0]}`);
    } else if (registered.length !== 1 || registered[0][0] !== "dispatch") {
      fail(`expected exactly one registerCommand("dispatch"), got: ${JSON.stringify(registered.map(([n]) => n))}`);
    } else if (typeof registered[0][1]?.handler !== "function") {
      fail("the registered dispatch command has no handler function");
    } else {
      ok(`(d) the built bundle loads against pi ${piPkg.version} and registers /dispatch cleanly`);
    }
  } catch (err) {
    fail(`loading the admin bundle against pi ${piPkg.version} threw: ${err.message}`);
  }

  if (failures > 0) {
    console.error(
      `canary: ${failures} failure(s) against pi ${piPkg.version}. pi moved underneath the admin: ` +
        "retest locally, bump SUPPORTED_PI_VERSION and the admin devDependency pin together " +
        "(load.test.mjs locks them to each other), and republish @edgehero/pi-dispatch-admin.",
    );
    process.exit(1);
  }
  console.log(`canary: PASS against pi ${piPkg.version}`);
}

// Main-module guard: wiring.test.mjs imports this file for NEEDLES/USED_API_MEMBERS, and an import
// must never run the probe.
const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const scratchArg = process.argv[2];
  if (!scratchArg) {
    console.error("usage: node .github/scripts/admin-pi-canary.mjs <scratch-dir>");
    process.exit(2);
  }
  await main(scratchArg);
}
