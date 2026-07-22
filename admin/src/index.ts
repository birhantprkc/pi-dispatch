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
 * It also registers four LLM-callable tools -- `dispatch_status`, `dispatch_runs`
 * (reads), and `dispatch_pause`/`dispatch_resume` (durable-but-reversible controls)
 * -- with no settings-write tool and no log tool, and a live dashboard overlay on
 * the bare `/dispatch` command.
 *
 * Supported pi version: 0.80.7. The factory registers nothing unless every API
 * member it consumes is present; on a miss it names the member and the
 * supported version on stderr and returns.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  resolvePaths,
  readQueueState,
  readSchedulers,
  readBudget,
  listRuns,
  readRun,
  readLogTail,
  readSettingsView,
  readFlows,
  listRunIds,
  setQueuePaused,
  writeSettings,
  KNOWN_KEYS,
} from "./read-model.mjs";
import { renderStatus, renderRuns, renderBudget, renderTriggers, renderSettingsView } from "./render.mjs";
import { makeDashboard } from "./dashboard.ts";
import { matchesKey } from "./keys.mjs";

// The single source of truth for the ExtensionAPI surface this extension
// consumes. It grows only when a task actually uses a new member.
export const USED_API = ["registerCommand", "registerTool", "sendMessage"] as const;

export const SUPPORTED_PI_VERSION = "0.80.7";

const CHANNEL = "pi-dispatch-admin";

const REBUILT_NOTICE = (reason: string) =>
  `replaced invalid settings file (${reason}) — other keys were lost`;

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

  registerTools(pi);
}

/** A one-shot text tool result. Failure is signalled by THROWing from `execute`, never by this shape. */
function toolText(text: string): { content: { type: "text"; text: string }[]; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}

/**
 * Register the four LLM-callable tools: two reads (`dispatch_status`, `dispatch_runs`) and the two
 * durable-but-reversible controls (`dispatch_pause`, `dispatch_resume`). There is deliberately NO
 * settings-write tool and NO log tool -- a write is an operator-typed command only, and raw `.log` bytes
 * never enter model context (DES-ADMIN-VIA-PI-EXTENSION injection boundary; REQ acceptance). Each read
 * reuses the self-closing read-model wrappers: a tool call is a one-shot, so a per-call connection is
 * correct here where a per-tick one on the dashboard would not be. A control that cannot reach the queue
 * THROWs, which pi reports to the model as an error rather than a false success.
 */
function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dispatch_status",
    label: "pi-dispatch status",
    description:
      "Read-only. Reports pi-dispatch queue/worker state: paused flag, job counts, connected workers, today's budget use, schedulers, runtime settings overlay.",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(process.env);
      const [queue, budget, schedulers] = await Promise.all([
        readQueueState({ url: paths.valkeyUrl }),
        readBudget({ url: paths.valkeyUrl }),
        readSchedulers({ url: paths.valkeyUrl }),
      ]);
      const settings = readSettingsView({ settingsFile: paths.settingsFile });
      return toolText(JSON.stringify({ queue, budget, settings, schedulers }));
    },
  });

  pi.registerTool({
    name: "dispatch_runs",
    label: "pi-dispatch runs",
    description:
      "Read-only. Returns structured, PII-free run records from the durable run history. Raw job logs are not available to tools — ask the user to run /dispatch logs.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      jobId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const paths = resolvePaths(process.env);
      const data = params.jobId
        ? readRun({ logsDir: paths.logsDir, jobId: params.jobId })
        : listRuns({ logsDir: paths.logsDir, limit: params.limit ?? 10 });
      return toolText(JSON.stringify(data));
    },
  });

  pi.registerTool({
    name: "dispatch_pause",
    label: "pi-dispatch pause",
    description:
      "Durably pauses pi-dispatch job processing: NEW jobs stop starting; running containers finish; jobs still enqueue. Survives worker restart. Reversible via dispatch_resume.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(process.env);
      const res = await setQueuePaused({ url: paths.valkeyUrl, paused: true });
      if (res.unreachable) {
        throw new Error(`could not reach the queue at ${paths.valkeyUrl}: ${res.unreachable}`);
      }
      return toolText("paused");
    },
  });

  pi.registerTool({
    name: "dispatch_resume",
    label: "pi-dispatch resume",
    description: "Re-enables PAID job processing after a pause. Only call when the user explicitly asks to resume.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(process.env);
      const res = await setQueuePaused({ url: paths.valkeyUrl, paused: false });
      if (res.unreachable) {
        throw new Error(`could not reach the queue at ${paths.valkeyUrl}: ${res.unreachable}`);
      }
      return toolText("resumed");
    },
  });
}

async function dispatch(pi: ExtensionAPI, args: string, ctx: any): Promise<void> {
  const notify = ctx?.ui?.notify?.bind(ctx.ui);
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sub = tokens[0] ?? "";
  const paths = resolvePaths(process.env);

  if (sub === "") {
    await openDashboard(paths, ctx, notify);
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
    case "pause":
    case "resume": {
      const paused = sub === "pause";
      const res = await setQueuePaused({ url: paths.valkeyUrl, paused });
      if (res.unreachable) {
        notify?.(`could not reach Valkey at ${paths.valkeyUrl} — is it running? (docker compose up)`, "error");
        return;
      }
      notify?.(
        paused
          ? "paused — worker will stop taking new jobs (jobs still enqueue; durable, survives restart)"
          : "resumed",
        "info",
      );
      return;
    }
    case "set": {
      applySet(paths.settingsFile, tokens, notify);
      return;
    }
    case "unset": {
      applyUnset(paths.settingsFile, tokens, notify);
      return;
    }
    default:
      notify?.(`dispatch: unknown subcommand '${sub}'. ${USAGE}`, "warning");
      return;
  }
}

/**
 * Open the live dashboard overlay for the bare `/dispatch`. The overlay is the panel's only surface, so a
 * pi build without `ctx.ui.custom` degrades to a usage note naming the reason rather than a silent no-op;
 * it never sends into the model channel. The `ctx.ui.custom` factory constructs the panel with the real
 * `tui`/`done`, so the queue and redis connections open only when the overlay actually shows.
 */
async function openDashboard(paths: any, ctx: any, notify: Notify): Promise<void> {
  const custom = ctx?.ui?.custom;
  if (typeof custom !== "function") {
    notify?.(`${USAGE} — the dashboard needs a TUI (this pi build has no overlay support)`, "info");
    return;
  }
  await custom.call(
    ctx.ui,
    (tui: any, _theme: any, _keybindings: any, done: (value: void) => void) => makeDashboard({ paths, done, tui }),
    { overlay: true, overlayOptions: { width: "75%", maxHeight: "90%", anchor: "center" } },
  );
}

type Notify = ((message: string, type?: string) => void) | undefined;

/**
 * `set <key> <value>`: the key must be a known settings key (checked BEFORE the write, since
 * `writeOverlay` silently drops unknown keys and would report ok on a no-op), the value is coerced by the
 * key's type, and exactly one value token is accepted (model ids carry no spaces). A rejected candidate
 * surfaces `writeOverlay`'s key-only reason; a rebuild over an invalid file adds a loud replaced-file
 * notice so a lost prior overlay is never silent.
 */
function applySet(settingsFile: string, tokens: string[], notify: Notify): void {
  const key = tokens[1] ?? "";
  if (!KNOWN_KEYS.includes(key)) {
    notify?.(`set: unknown key '${key}'. valid keys: ${KNOWN_KEYS.join(", ")}`, "error");
    return;
  }
  const valueTokens = tokens.slice(2);
  if (valueTokens.length !== 1) {
    notify?.(`set: ${key} takes exactly one value`, "error");
    return;
  }
  const value = coerceSettingValue(key, valueTokens[0]);
  const res = writeSettings({ settingsFile, mutate: (o) => ({ ...o, [key]: value }) });
  if (res.invalid) {
    notify?.(`set: ${res.invalid}`, "error");
    return;
  }
  notify?.(`set ${key} = ${value}`, "info");
  if (res.rebuiltFrom) notify?.(REBUILT_NOTICE(res.rebuiltFrom), "warning");
}

/**
 * `unset <key>`: the key must be a known settings key; the mutation deletes it, and an empty result `{}`
 * is a valid written state (no overrides). The same loud replaced-file notice fires when the write repaired
 * an invalid file.
 */
function applyUnset(settingsFile: string, tokens: string[], notify: Notify): void {
  const key = tokens[1] ?? "";
  if (!KNOWN_KEYS.includes(key)) {
    notify?.(`unset: unknown key '${key}'. valid keys: ${KNOWN_KEYS.join(", ")}`, "error");
    return;
  }
  const res = writeSettings({
    settingsFile,
    mutate: (o) => {
      delete o[key];
      return o;
    },
  });
  if (res.invalid) {
    notify?.(`unset: ${res.invalid}`, "error");
    return;
  }
  notify?.(`unset ${key}`, "info");
  if (res.rebuiltFrom) notify?.(REBUILT_NOTICE(res.rebuiltFrom), "warning");
}

/**
 * Coerce a raw token to the settings value its key expects: the three numeric keys parse via `Number` (a
 * non-numeric token becomes `NaN`, which `writeOverlay` then rejects with a key-only reason); `model` and
 * `provider` keep the raw string. Bounds and integer-ness stay in `writeOverlay`, the single validator.
 */
function coerceSettingValue(key: string, raw: string): number | string {
  if (key === "maxTurns" || key === "dailyCap" || key === "concurrency") return Number(raw);
  return raw;
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
  if ((parts[0] === "set" || parts[0] === "unset") && parts.length === 2) {
    const partial = parts[1];
    const items = KNOWN_KEYS.filter((k) => k.startsWith(partial)).map((k) => ({
      value: `${parts[0]} ${k}`,
      label: k,
    }));
    return items.length > 0 ? items : null;
  }
  return null;
}
