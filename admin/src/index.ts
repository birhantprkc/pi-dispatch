/**
 * pi-dispatch admin extension.
 *
 * A pi extension that adds a `/dispatch` command for operating a pi-dispatch
 * deployment (status, pause, resume, runs, logs, budget, triggers, settings).
 *
 * Loading: the operator's own pi supplies `ExtensionAPI` at runtime. Three ways
 * to load it, all on the operator's host:
 *   - `pi -e admin/src/index.ts` (explicit, one session)
 *   - an entry in the `extensions` array of `~/.pi/agent/settings.json`
 *   - the in-repo `.pi/extensions/dispatch.ts` shim, which pi loads only after
 *     the operator trusts this checkout (trust gating)
 *
 * A job container can never load this: the job loader sets `noExtensions: true`
 * and mounts only the serviced repo's /job/pi.
 *
 * The extension is a thin channel over the read-model and the renderers: it
 * parses the subcommand, calls `read-model.mjs` for data and `render.mjs` for
 * text, and picks the output channel. PII-free records go to `sendMessage`
 * (they may enter later model context, which is accepted per REQ); raw `.log`
 * bytes go ONLY to the overlay viewer, never to a message.
 *
 * Supported pi version: 0.80.7. The factory registers nothing unless every API
 * member it consumes is present; on a miss it names the member and the
 * supported version on stderr and returns.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import {
  resolvePaths,
  readQueueState,
  readSchedulers,
  readBudget,
  listRuns,
  readLogTail,
  readSettingsView,
  readFlows,
  listRunIds,
} from "./read-model.mjs";
import { renderStatus, renderRuns, renderBudget, renderTriggers, renderSettingsView } from "./render.mjs";

// The single source of truth for the ExtensionAPI surface this extension
// consumes. It grows only when a task actually uses a new member.
export const USED_API = ["registerCommand", "sendMessage"] as const;

export const SUPPORTED_PI_VERSION = "0.80.7";

const CHANNEL = "pi-dispatch-admin";

const USAGE =
  "usage: /dispatch <status|pause|resume|runs|logs|budget|triggers|settings|set|unset>";

const KNOWN_SUBCOMMANDS = [
  "status",
  "pause",
  "resume",
  "runs",
  "logs",
  "budget",
  "triggers",
  "settings",
  "set",
  "unset",
] as const;

// Commands parked for a later slice (4.1): mutation of queue state and settings.
const NOT_YET_IMPLEMENTED = new Set(["pause", "resume", "set", "unset"]);

export default function admin(pi: ExtensionAPI): void {
  for (const member of USED_API) {
    if (typeof (pi as Record<string, unknown>)[member] !== "function") {
      console.error(
        `[pi-dispatch/admin] refusing to load: pi is missing '${member}'. ` +
          `This extension supports pi ${SUPPORTED_PI_VERSION}.`,
      );
      return;
    }
  }

  pi.registerCommand("dispatch", {
    description:
      "pi-dispatch admin: status|pause|resume|runs|logs|budget|triggers|settings|set|unset",
    getArgumentCompletions: (prefix) => completeArguments(prefix),
    handler: async (args, ctx) => dispatch(pi, args, ctx),
  });
}

async function dispatch(pi: ExtensionAPI, args: string, ctx: any): Promise<void> {
  const notify = ctx?.ui?.notify?.bind(ctx.ui);
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sub = tokens[0] ?? "";
  const paths = resolvePaths(process.env);

  if (sub === "") {
    notify?.(USAGE, "info");
    return;
  }

  switch (sub) {
    case "status": {
      const [queue, budget] = await Promise.all([
        readQueueState({ url: paths.valkeyUrl }),
        readBudget({ url: paths.valkeyUrl }),
      ]);
      const settings = readSettingsView({ settingsFile: paths.settingsFile });
      send(pi, `${renderStatus(queue)}\n${renderBudget({ budget, settings })}`);
      return;
    }
    case "runs": {
      const limit = tokens[1] ? Number(tokens[1]) : undefined;
      send(pi, renderRuns(listRuns({ logsDir: paths.logsDir, limit })));
      return;
    }
    case "budget": {
      const budget = await readBudget({ url: paths.valkeyUrl });
      const settings = readSettingsView({ settingsFile: paths.settingsFile });
      send(pi, renderBudget({ budget, settings }));
      return;
    }
    case "triggers": {
      const schedulers = await readSchedulers({ url: paths.valkeyUrl });
      const flows = readFlows({ flowsPath: paths.flowsPath });
      send(pi, renderTriggers({ schedulers, flows }));
      return;
    }
    case "settings": {
      send(pi, renderSettingsView(readSettingsView({ settingsFile: paths.settingsFile })));
      return;
    }
    case "logs":
      await showLogs(paths.logsDir, tokens, ctx);
      return;
    default:
      if (NOT_YET_IMPLEMENTED.has(sub)) {
        notify?.(`dispatch ${sub}: not yet implemented`, "info");
        return;
      }
      notify?.(`dispatch: unknown subcommand '${sub}'. ${USAGE}`, "warning");
      return;
  }
}

/**
 * The model-visible channel for the PII-free structured views. `display: true` shows the text; the empty
 * options object is deliberate -- NEVER `triggerTurn`, which would spend a paid turn just to observe state.
 */
function send(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: CHANNEL, content, display: true }, {});
}

/**
 * Show a job's raw `.log` in the overlay viewer, and ONLY there. Raw container output is untrusted and
 * PII-bearing, so it must never enter model context: if the pi build has no `ctx.ui.custom`, this fails
 * LOUD (an error notification, or console.error) and returns -- it never falls back to `sendMessage`,
 * which would leak the bytes into context, and never silently no-ops, which would fake "no logs".
 */
async function showLogs(logsDir: string, tokens: string[], ctx: any): Promise<void> {
  const notify = ctx?.ui?.notify?.bind(ctx.ui);
  const jobId = tokens[1];
  if (!jobId) {
    notify?.("usage: /dispatch logs <jobId> [lines]", "warning");
    return;
  }
  const lines = tokens[2] ? Number(tokens[2]) : undefined;
  const tail = readLogTail({ logsDir, jobId, lines });

  const custom = ctx?.ui?.custom;
  if (typeof custom !== "function") {
    const message = "logs viewer unavailable in this pi version -- raw logs are never sent to the model";
    if (notify) notify(message, "error");
    else console.error(`[pi-dispatch/admin] ${message}`);
    return;
  }

  await custom.call(ctx.ui, makeLogViewer(jobId, tail), { overlay: true });
}

const VIEWPORT_LINES = 20;

/**
 * Build the scrollable log-viewer factory for `ctx.ui.custom`. The component renders a bounded window of
 * the tail with a title, and scrolls on up/down/pageUp/pageDown; escape closes via `done`. A missing log
 * renders a capture-off note rather than an empty view. The lines live only in this closure -- there is no
 * path from here to `sendMessage`.
 */
function makeLogViewer(jobId: string, tail: { lines?: string[]; missing?: boolean }) {
  const missing = tail.missing === true;
  const lines = missing ? [] : tail.lines ?? [];
  const maxTop = () => Math.max(0, lines.length - VIEWPORT_LINES);
  let top = 0;

  return (_tui: any, _theme: any, _keybindings: any, done: (value: void) => void) => {
    const component = {
      render(_width: number): string[] {
        if (missing) {
          return [`logs ${jobId} -- no captured log (PI_CAPTURE_JOB_LOGS off or not found). Esc to close.`, ""];
        }
        const out = [`logs ${jobId} -- ${lines.length} line(s). Up/Down scroll, PgUp/PgDn page, Esc close.`, ""];
        for (const line of lines.slice(top, top + VIEWPORT_LINES)) out.push(line);
        out.push("", `[${Math.min(top + VIEWPORT_LINES, lines.length)}/${lines.length}]`);
        return out;
      },
      invalidate(): void {
        // No cached render state to clear; the TUI redraws from render().
      },
      handleInput(data: string): void {
        if (matchesKey(data, "escape")) {
          done(undefined);
          return;
        }
        if (missing) return;
        if (matchesKey(data, "up")) top = Math.max(0, top - 1);
        else if (matchesKey(data, "down")) top = Math.min(maxTop(), top + 1);
        else if (matchesKey(data, "pageUp")) top = Math.max(0, top - VIEWPORT_LINES);
        else if (matchesKey(data, "pageDown")) top = Math.min(maxTop(), top + VIEWPORT_LINES);
        component.invalidate();
      },
    };
    return component;
  };
}

/**
 * Argument completion: the first token completes against the subcommand names; `logs <partial>` completes
 * against the run ids present on disk. Returns null (not []) when there is nothing to offer.
 */
function completeArguments(prefix: string) {
  const parts = prefix.trimStart().split(/\s+/);
  if (parts.length <= 1) {
    const token = parts[0] ?? "";
    const items = KNOWN_SUBCOMMANDS.filter((s) => s.startsWith(token)).map((s) => ({ value: s, label: s }));
    return items.length > 0 ? items : null;
  }
  if (parts[0] === "logs" && parts.length === 2) {
    const partial = parts[1];
    const ids = listRunIds({ logsDir: resolvePaths(process.env).logsDir });
    const items = ids
      .filter((id) => id.startsWith(partial))
      .map((id) => ({ value: `logs ${id}`, label: id }));
    return items.length > 0 ? items : null;
  }
  return null;
}

/**
 * Match a raw terminal input string against a named key. Prefers pi's own `matchesKey` (resolved from
 * pi-tui via the pinned pi package, since pi-tui is nested there, not hoisted) to stay faithful to pi's
 * key decoding; falls back to a small legacy-sequence matcher for the keys the viewer uses if resolution
 * is unavailable. Memoized so resolution runs at most once.
 */
let cachedMatchesKey: ((data: string, keyId: string) => boolean) | null = null;

function matchesKey(data: string, keyId: string): boolean {
  if (cachedMatchesKey === null) cachedMatchesKey = resolveMatchesKey();
  return cachedMatchesKey(data, keyId);
}

function resolveMatchesKey(): (data: string, keyId: string) => boolean {
  try {
    const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const tui = piRequire("@earendil-works/pi-tui");
    if (typeof tui.matchesKey === "function") return tui.matchesKey;
  } catch {
    // fall through to the local matcher
  }
  return localMatchesKey;
}

function localMatchesKey(data: string, keyId: string): boolean {
  switch (keyId) {
    case "escape":
      return data === "\x1b";
    case "up":
      return data === "\x1b[A" || data === "\x1bOA";
    case "down":
      return data === "\x1b[B" || data === "\x1bOB";
    case "pageUp":
      return data === "\x1b[5~";
    case "pageDown":
      return data === "\x1b[6~";
    default:
      return false;
  }
}
