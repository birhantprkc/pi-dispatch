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
 * It also registers LLM-callable tools: reads (`dispatch_status`, `dispatch_runs`,
 * `dispatch_triggers`), the durable-but-reversible on/off controls (`dispatch_pause`/
 * `dispatch_resume`), the gated PAID enqueue (`dispatch_run`), and the confirm-gated
 * writes (`dispatch_set`, `dispatch_trigger_add`/`_edit`/`_delete`) -- each of which
 * refuses unless a human operator approves a confirmation dialog showing the concrete
 * change. There is still no log tool (raw `.log` bytes never enter model context), and
 * a live dashboard overlay renders on the bare `/dispatch` command. The extension also
 * ships an `operate-pi-dispatch` skill, advertised via `resources_discover`, that tells
 * the model how to use those human-in-the-loop write gates.
 *
 * Supported pi version: 0.80.7. The factory registers nothing unless every API
 * member it consumes is present; on a miss it names the member and the
 * supported version on stderr and returns.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
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
  readTriggers,
  listRunIds,
  setQueuePaused,
  writeSettings,
  writeTriggers,
  enqueueDispatchRun,
  KNOWN_KEYS,
} from "./read-model.mjs";
import { renderStatus, renderRuns, renderBudget, renderTriggers, renderSettingsView } from "./render.mjs";
import { makeDashboard, createDashboardDeps } from "./dashboard.ts";
import { matchesKey } from "./keys.mjs";

// The single source of truth for the ExtensionAPI surface this extension
// consumes. It grows only when a task actually uses a new member.
export const USED_API = ["registerCommand", "registerTool", "sendMessage", "on"] as const;

export const SUPPORTED_PI_VERSION = "0.80.7";

const CHANNEL = "pi-dispatch-admin";

const REBUILT_NOTICE = (reason: string) =>
  `replaced invalid settings file (${reason}) — other keys were lost`;

const USAGE =
  "usage: /dispatch <status|pause|resume|run|runs|logs|budget|triggers|settings|set|unset>";

const KNOWN_SUBCOMMANDS = [
  "status",
  "pause",
  "resume",
  "run",
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
      "pi-dispatch admin: status|pause|resume|run|runs|logs|budget|triggers|settings|set|unset",
    getArgumentCompletions: (prefix) => completeArguments(prefix),
    handler: async (args, ctx) => dispatch(pi, args, ctx),
  });

  registerTools(pi);
  registerSkill(pi);
}

/**
 * Advertise the bundled `operate-pi-dispatch` skill to pi via the `resources_discover` event, so it loads
 * exactly when this extension does (no separate install step). The skill does not grant capability -- the
 * tools do that -- it recommends how to use the human confirm gates on the write tools. pi's resource loader
 * honours `skillPaths` from this event; the path is the extension-relative `admin/skills` directory.
 */
function registerSkill(pi: ExtensionAPI): void {
  const skillPaths = [fileURLToPath(new URL("../skills", import.meta.url))];
  pi.on("resources_discover", () => ({ skillPaths }));
}

/** A one-shot text tool result. Failure is signalled by THROWing from `execute`, never by this shape. */
function toolText(text: string): { content: { type: "text"; text: string }[]; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}

/**
 * Register the LLM-callable tools. Reads: `dispatch_status`, `dispatch_runs`, `dispatch_triggers`. On/off:
 * `dispatch_pause`/`dispatch_resume` (durable, reversible, money-safe -- no confirm). The gated PAID enqueue:
 * `dispatch_run`. Confirm-gated writes: `dispatch_set` (a limit/setting) and `dispatch_trigger_add`/`_edit`/
 * `_delete`. There is still NO log tool -- raw `.log` bytes never enter model context (DES-ADMIN-VIA-PI-EXTENSION
 * injection boundary; REQ acceptance).
 *
 * The write tools do NOT weaken the money/trigger gates: each routes through `confirmedWrite`, which refuses
 * unless a human operator is present (`ctx.hasUI`) and approves a `ctx.ui.confirm` dialog showing the concrete
 * before->after. The model emits only the tool CALL; the operator answers the CONFIRM, so a prompt-injected
 * session cannot raise the cap or add a paid trigger without a human keypress it cannot forge (the same human
 * approval the operator-typed `/dispatch set` and the overlay CRUD already require). Without an interactive UI
 * (print/headless) the write is refused, never silently applied.
 *
 * `dispatch_run` takes no spend-knob params (model/maxTurns/dailyCap/concurrency resolve worker-side) and is
 * bounded producer-side by the folder allowlist, the committed per-flow ai-trigger gate read at a pre-agent
 * SHA, and a per-hour rate limit; the daily cap stays the worker's. Each read reuses the self-closing
 * read-model wrappers: a tool call is a one-shot, so a per-call connection is correct here where a per-tick
 * one on the dashboard would not be. A control, write, or enqueue that cannot reach the queue/file THROWs,
 * which pi reports to the model as an error rather than a false success.
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

  pi.registerTool({
    name: "dispatch_run",
    label: "pi-dispatch run",
    description:
      "Enqueues a PAID pi-dispatch agent run against a local folder, editing it in place with no undo. " +
      "Only folders under the operator's PI_DISPATCH_RUN_ROOTS, and only flows whose .pi/skills/<flow>/SKILL.md " +
      "(at HEAD) sets ai-trigger: allow, can be started. Refuses a dirty git working tree — no force option. " +
      "Rate-limited per hour.",
    executionMode: "sequential",
    parameters: Type.Object({ folder: Type.String(), flow: Type.String(), task: Type.String() }),
    async execute(_toolCallId, params) {
      const res = await enqueueDispatchRun({
        folder: params.folder,
        flow: params.flow,
        task: params.task,
        aiInvoked: true,
      });
      if (res.refused) throw new Error(res.refused);
      if (res.unreachable) throw new Error(`could not reach the queue: ${res.unreachable}`);
      return toolText(JSON.stringify({ jobId: res.jobId, folder: params.folder, flow: params.flow }));
    },
  });

  pi.registerTool({
    name: "dispatch_triggers",
    label: "pi-dispatch triggers",
    description:
      "Read-only. Lists the configured triggers as `{ index, ...trigger }` entries. Use the `index` to target " +
      "a specific trigger with dispatch_trigger_edit or dispatch_trigger_delete.",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(process.env);
      const t = readTriggers({ triggersPath: paths.triggersPath });
      const data = Array.isArray(t?.triggers)
        ? t.triggers.map((tr: any, index: number) => ({ index, ...tr }))
        : t;
      return toolText(JSON.stringify(data));
    },
  });

  pi.registerTool({
    name: "dispatch_set",
    label: "pi-dispatch set limit",
    description:
      "Changes a pi-dispatch runtime setting/limit and applies it live. The operator MUST approve a confirm " +
      "dialog showing the exact before->after; with no interactive operator the change is refused, never " +
      "applied. Omit `value` (or pass empty) to unset a key back to its default. Valid keys: " +
      KNOWN_KEYS.join(", ") + ".",
    executionMode: "sequential",
    parameters: Type.Object({ key: Type.String(), value: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!KNOWN_KEYS.includes(params.key)) {
        throw new Error(`unknown key '${params.key}'. valid keys: ${KNOWN_KEYS.join(", ")}`);
      }
      const paths = resolvePaths(process.env);
      const view = readSettingsView({ settingsFile: paths.settingsFile });
      const oldVal = view?.overlay?.[params.key];
      const unset = params.value === undefined || params.value.trim() === "";
      const newVal = unset ? undefined : coerceSettingValue(params.key, params.value.trim());
      const result = await confirmedWrite(
        ctx,
        {
          title: unset ? `Unset ${params.key}` : `Set ${params.key}`,
          message: `${params.key}: ${oldVal ?? "(unset)"} -> ${unset ? "(unset)" : newVal}`,
        },
        () => {
          const res = unset
            ? writeSettings({ settingsFile: paths.settingsFile, mutate: (o) => { delete o[params.key]; return o; } })
            : writeSettings({ settingsFile: paths.settingsFile, mutate: (o) => ({ ...o, [params.key]: newVal }) });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, key: params.key, value: unset ? null : newVal, rebuiltFrom: res.rebuiltFrom ?? null };
        },
      );
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_trigger_add",
    label: "pi-dispatch add trigger",
    description:
      "Adds a trigger to triggers.json and applies it live. The operator MUST approve a confirm dialog showing " +
      "the entry; with no interactive operator it is refused. `flow` is the .pi/skills/<name> skill the job runs " +
      "(its SKILL.md is the agent's instructions). `kind` = cron|label|comment|pull_request. cron (local) needs " +
      "id, pattern, `folder` (absolute host path the job runs in), `flow`, and `task` (the prompt text handed to " +
      "the agent), and may set optional model/provider/maxTurns for that schedule (omit = deployment default). " +
      "label needs labels[]+flow; comment needs phrase+flow; pull_request needs action[] (+ optional labels[]) + " +
      "flow. For github triggers the repo and the task come from the triggering issue/PR event — set only the " +
      "match + flow — and they run under the deployment default model.",
    executionMode: "sequential",
    parameters: Type.Object({
      kind: Type.String(),
      flow: Type.String(),
      id: Type.Optional(Type.String()),
      pattern: Type.Optional(Type.String()),
      folder: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
      phrase: Type.Optional(Type.String()),
      labels: Type.Optional(Type.Array(Type.String())),
      action: Type.Optional(Type.Array(Type.String())),
      model: Type.Optional(Type.String()),
      provider: Type.Optional(Type.String()),
      maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const entry = buildTriggerEntry(params.kind, params);
      if (!entry) throw new Error(`unknown trigger kind '${params.kind}' (cron|label|comment|pull_request)`);
      const result = await confirmedWrite(
        ctx,
        { title: `Add ${params.kind} trigger`, message: `Add to triggers.json:\n${JSON.stringify(entry)}` },
        () => {
          const res = writeTriggers({ triggersPath: resolvePaths(process.env).triggersPath, mutate: (list: any[]) => [...list, entry] });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, added: entry };
        },
      );
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_trigger_edit",
    label: "pi-dispatch edit trigger",
    description:
      "Changes which flow a trigger runs (by array index from dispatch_triggers) and applies it live. The " +
      "operator MUST approve a confirm dialog showing flow before->after; with no interactive operator it is refused.",
    executionMode: "sequential",
    parameters: Type.Object({ index: Type.Integer({ minimum: 0 }), flow: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(process.env);
      const list = triggerList(paths);
      const cur = list[params.index];
      if (!cur) throw new Error(`no trigger at index ${params.index} (have ${list.length})`);
      const flow = params.flow.trim();
      if (!flow) throw new Error("flow must be non-empty");
      const result = await confirmedWrite(
        ctx,
        { title: `Edit trigger #${params.index + 1}`, message: `trigger #${params.index + 1} (${cur.type}) flow: ${cur.flow ?? "-"} -> ${flow}` },
        () => {
          const res = writeTriggers({
            triggersPath: paths.triggersPath,
            mutate: (raw: any[]) => raw.map((tr, i) => (i === params.index ? { ...tr, run: { ...tr.run, flow } } : tr)),
          });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, index: params.index, flow };
        },
      );
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_trigger_delete",
    label: "pi-dispatch delete trigger",
    description:
      "Removes a trigger from triggers.json (by array index from dispatch_triggers) and applies it live. The " +
      "operator MUST approve a confirm dialog showing the entry; with no interactive operator it is refused.",
    executionMode: "sequential",
    parameters: Type.Object({ index: Type.Integer({ minimum: 0 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(process.env);
      const list = triggerList(paths);
      const cur = list[params.index];
      if (!cur) throw new Error(`no trigger at index ${params.index} (have ${list.length})`);
      const result = await confirmedWrite(
        ctx,
        { title: `Delete trigger #${params.index + 1}`, message: `Remove trigger #${params.index + 1}: ${cur.type} -> ${cur.flow ?? "-"}` },
        () => {
          const res = writeTriggers({ triggersPath: paths.triggersPath, mutate: (raw: any[]) => raw.filter((_, i) => i !== params.index) });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, deletedIndex: params.index };
        },
      );
      return toolText(JSON.stringify(result));
    },
  });
}

/**
 * The single human-in-the-loop gate for every write tool. It is what lets a model-callable tool touch the
 * cap or the triggers file without breaking CONST-BUDGET-BEFORE-TOKENS / CONST-TRIGGER-AUTHOR-GATE: the model
 * emits the CALL, but the mutation runs only after the OPERATOR approves a `ctx.ui.confirm` dialog that shows
 * the concrete change. Fail-closed: with no confirm-capable UI (print/headless, `ctx.hasUI` false) it THROWs
 * rather than apply -- no operator, no write. An explicit decline is a determinate, non-error outcome
 * (`{ applied:false }`) -- the caller must not loop-retry it.
 */
async function confirmedWrite(
  ctx: any,
  prompt: { title: string; message: string },
  doWrite: () => any,
): Promise<any> {
  if (!ctx?.hasUI || typeof ctx?.ui?.confirm !== "function") {
    throw new Error(
      "refused: this change needs an interactive operator to confirm it, and no confirm-capable UI is available (e.g. print/headless mode).",
    );
  }
  const ok = await ctx.ui.confirm(prompt.title, prompt.message);
  if (!ok) return { applied: false, reason: "operator declined" };
  return doWrite();
}

/** The current triggers as a display list (empty on a missing/invalid file), for index resolution + confirm text. */
function triggerList(paths: any): any[] {
  const t = readTriggers({ triggersPath: paths.triggersPath });
  return Array.isArray(t?.triggers) ? t.triggers : [];
}

/**
 * Build one `{ on, run }` trigger entry from a kind + fields. The single source of truth for the on x run
 * diagonal (cron -> local, every webhook kind -> github): the impossible combination is absent by
 * construction, mirroring the worker's load-time diagonal. Shared by the add-trigger dialog and the
 * `dispatch_trigger_add` tool, so both produce identical shapes. `labels`/`action` accept either an array
 * (tool params) or a space-separated string (dialog input) via `asWords`. Returns null for an unknown kind.
 */
function buildTriggerEntry(kind: string, f: any): any {
  if (kind === "cron") {
    // Optional per-entry provider/model/maxTurns pass through to job.data (highest precedence); omitted when
    // blank so the value still resolves against the settings overlay/env at job start (triggers.mjs:127-131).
    // undefined keys drop out of the written JSON. Only the local/cron path carries these — github triggers
    // run under the global overlay/env model, which the loader enforces.
    const run: any = { kind: "local", folder: f.folder, flow: f.flow, task: f.task };
    const model = optStr(f.model);
    const provider = optStr(f.provider);
    const maxTurns = optInt(f.maxTurns);
    if (model) run.model = model;
    if (provider) run.provider = provider;
    if (maxTurns !== undefined) run.maxTurns = maxTurns;
    return { on: { type: "cron", id: f.id, pattern: f.pattern }, run };
  }
  if (kind === "label") return { on: { type: "label", any: asWords(f.labels ?? f.any) }, run: { kind: "github", flow: f.flow } };
  if (kind === "comment") return { on: { type: "comment", phrase: f.phrase }, run: { kind: "github", flow: f.flow } };
  if (kind === "pull_request") {
    const on: any = { type: "pull_request", action: asWords(f.action) };
    const any = asWords(f.labels ?? f.any);
    if (any.length > 0) on.any = any;
    return { on, run: { kind: "github", flow: f.flow } };
  }
  return null;
}

/** Normalise a labels/action field to a trimmed non-empty string list, accepting an array or a string. */
function asWords(x: any): string[] {
  if (Array.isArray(x)) return x.map((s) => String(s).trim()).filter(Boolean);
  return splitWords(x);
}

/** A trimmed non-empty string, or undefined (so a blank optional field drops out of the written JSON). */
function optStr(x: any): string | undefined {
  const s = String(x ?? "").trim();
  return s === "" ? undefined : s;
}

/** A finite number from a string/number, or undefined when blank/absent/non-numeric. */
function optInt(x: any): number | undefined {
  if (x === undefined || x === null || String(x).trim() === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
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
      const triggers = readTriggers({ triggersPath: paths.triggersPath });
      send(pi, renderTriggers({ schedulers, triggers }));
      return;
    }
    case "settings": {
      send(pi, renderSettingsView(readSettingsView({ settingsFile: paths.settingsFile })));
      return;
    }
    case "run": {
      const folder = tokens[1];
      const flow = tokens[2];
      const task = tokens.slice(3).join(" ");
      if (!folder) {
        notify?.("usage: /dispatch run <folder> <flow> [task...]", "warning");
        return;
      }
      // Operator path (aiInvoked:false): ungated -- typing the command is the approval -- but the dirty
      // guard still fires inside enqueueDispatchRun. No spend knobs; provider/model/maxTurns resolve worker-side.
      const res = await enqueueDispatchRun({ folder, flow, task, aiInvoked: false });
      if (res.refused) {
        notify?.(res.refused, "error");
        return;
      }
      if (res.unreachable) {
        notify?.(`could not reach the queue: ${res.unreachable}`, "error");
        return;
      }
      notify?.(`queued ${res.jobId} — ${folder} (${flow})`, "info");
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
  const factory = (tui: any, theme: any, _keybindings: any, done: (value: any) => void) =>
    makeDashboard({
      paths,
      done,
      tui,
      theme,
      deps: {
        ...createDashboardDeps(paths),
        // log read stays here; overlay-only, returns readLogTail's result verbatim
        tailLog: ({ jobId, lines }: { jobId: string; lines: number }) => readLogTail({ logsDir: paths.logsDir, jobId, lines }),
      },
    });
  const opts = { overlay: true, overlayOptions: { width: "75%", maxHeight: "90%", anchor: "center" } };
  // The overlay resolves with a CRUD action the operator triggered (add/edit/delete a trigger, edit
  // settings) or `undefined` to quit. A CRUD action is driven here via ctx.ui dialogs -- writes are
  // validated + atomic (`writeTriggers`/`writeSettings`) and the worker/receiver reload the file live -- then
  // the overlay REOPENS so the change is visible immediately. Only-operator-typed, never an LLM tool.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await custom.call(ctx.ui, factory, opts);
    if (!result || !result.action) return;
    await handleDashboardAction(result, paths, ctx);
  }
}

/** Split a space-separated dialog answer into trimmed, non-empty words (label/action lists). */
function splitWords(s: string | undefined): string[] {
  return String(s ?? "")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/**
 * Drive a CRUD action the dashboard overlay signalled, using pi's `ctx.ui` dialogs (`select`/`input`/
 * `confirm`). Every write goes through `writeTriggers`/`writeSettings` (validated + atomic + fail-closed);
 * the live-reload watchers apply it without a restart. A build without the dialog primitives degrades to a
 * notice rather than a crash. `undefined` from any dialog is a cancel.
 */
export async function handleDashboardAction(result: any, paths: any, ctx: any): Promise<void> {
  const ui = ctx?.ui;
  const notify: Notify = ui?.notify?.bind(ui);
  if (typeof ui?.input !== "function" || typeof ui?.select !== "function" || typeof ui?.confirm !== "function") {
    notify?.("editing needs a newer pi (no input/select/confirm dialogs)", "warning");
    return;
  }
  switch (result.action) {
    case "addTrigger":
      return addTriggerViaDialogs(paths, ui, notify);
    case "editTrigger":
      return editTriggerFlow(paths, ui, notify, result.index);
    case "deleteTrigger":
      return deleteTriggerEntry(paths, ui, notify, result.index);
    case "editSettings":
      return editSettingsViaDialogs(paths, ui, notify);
  }
}

/** Add a trigger: kind-first (the on x run diagonal is locked by construction), then the per-kind fields. */
async function addTriggerViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const kind = await ui.select("Add trigger — kind", ["cron", "label", "comment", "pull_request"]);
  if (!kind) return;
  let entry: any;
  if (kind === "cron") {
    const id = await ui.input("cron id — unique name for this schedule, no ':'", "nightly");
    if (id === undefined) return;
    const pattern = await ui.input("schedule — cron pattern, 5 or 6 fields (min hour day month weekday)", "0 3 * * *");
    if (pattern === undefined) return;
    const folder = await ui.input("folder — absolute host path the job runs in (must exist)", "");
    if (folder === undefined) return;
    const flow = await ui.input("flow — the .pi/skills/<name> skill to run (its SKILL.md is the agent's instructions)", "fix");
    if (flow === undefined) return;
    const task = await ui.input("task — the prompt text handed to the agent for this run", "run the flow");
    if (task === undefined) return;
    // Optional per-cron overrides — blank keeps the deployment default (overlay/env) at job start.
    const model = await ui.input("model — this schedule's model (blank = deployment default)", "");
    if (model === undefined) return;
    const provider = await ui.input("provider — this schedule's provider (blank = deployment default)", "");
    if (provider === undefined) return;
    const maxTurns = await ui.input("maxTurns — turn budget for this schedule (blank = deployment default)", "");
    if (maxTurns === undefined) return;
    entry = buildTriggerEntry("cron", { id, pattern, folder, flow, task, model, provider, maxTurns });
  } else if (kind === "label") {
    // github triggers run against the triggering repo, and the issue/PR text is the task — neither is set here.
    const labels = await ui.input("labels — space-separated, any-of (a collaborator applies one to fire)", "pi:fix");
    if (labels === undefined) return;
    const flow = await ui.input("flow — the .pi/skills/<name> skill to run (the issue text is the task)", "fix");
    if (flow === undefined) return;
    entry = buildTriggerEntry("label", { labels, flow });
  } else if (kind === "comment") {
    const phrase = await ui.input("trigger phrase — a comment containing this fires the flow (e.g. @pi)", "@pi");
    if (phrase === undefined) return;
    const flow = await ui.input("flow — the .pi/skills/<name> skill to run (the comment/issue text is the task)", "fix");
    if (flow === undefined) return;
    entry = buildTriggerEntry("comment", { phrase, flow });
  } else {
    const action = await ui.input("PR actions — space-separated: labeled opened synchronize reopened", "labeled");
    if (action === undefined) return;
    const labels = await ui.input("labels for 'labeled' — space-separated (blank for the auto actions)", "pi:review");
    if (labels === undefined) return;
    const flow = await ui.input("flow — the .pi/skills/<name> skill to run (the PR text is the task)", "review");
    if (flow === undefined) return;
    entry = buildTriggerEntry("pull_request", { action, labels, flow });
  }
  const res = writeTriggers({ triggersPath: paths.triggersPath, mutate: (list: any[]) => [...list, entry] });
  notify?.(res.ok ? `trigger added (live) — ${kind} → ${entry.run.flow}` : `add rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/** Edit a trigger's flow in place (the common "change what a trigger runs" edit). */
async function editTriggerFlow(paths: any, ui: any, notify: Notify, index: number): Promise<void> {
  if (typeof index !== "number") return;
  const flow = await ui.input(`new flow for trigger #${index + 1} — the .pi/skills/<name> skill it runs`, "");
  if (flow === undefined || flow.trim() === "") return;
  const res = writeTriggers({
    triggersPath: paths.triggersPath,
    mutate: (list: any[]) => list.map((t, i) => (i === index ? { ...t, run: { ...t.run, flow: flow.trim() } } : t)),
  });
  notify?.(res.ok ? `flow updated (live) → ${flow.trim()}` : `edit rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/** Delete a trigger after an explicit confirm. */
async function deleteTriggerEntry(paths: any, ui: any, notify: Notify, index: number): Promise<void> {
  if (typeof index !== "number") return;
  const ok = await ui.confirm("Delete trigger", `Remove trigger #${index + 1} from triggers.json?`);
  if (!ok) return;
  const res = writeTriggers({ triggersPath: paths.triggersPath, mutate: (list: any[]) => list.filter((_, i) => i !== index) });
  notify?.(res.ok ? `trigger #${index + 1} deleted (live)` : `delete rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/** Edit a limit / runtime setting: pick a key, then a value (blank unsets). Reuses the operator-typed
 * `set`/`unset` path, so the same validation + effect-next-job semantics apply. */
async function editSettingsViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const key = await ui.select("Change a limit / setting", [...KNOWN_KEYS]);
  if (!key) return;
  const value = await ui.input(`${key} — new value (blank to unset)`, "");
  if (value === undefined) return;
  if (value.trim() === "") applyUnset(paths.settingsFile, ["unset", key], notify);
  else applySet(paths.settingsFile, ["set", key, value.trim()], notify);
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
 * Coerce a raw token to the settings value its key expects: `model` and `provider` keep the raw string;
 * every other overlay key is numeric and parses via `Number` (a non-numeric token becomes `NaN`, which
 * `writeOverlay` then rejects with a key-only reason). Keying off the two string exceptions rather than an
 * enumerated numeric list keeps this in lockstep with `KNOWN_KEYS` -- a new numeric knob (weekly/monthly
 * caps, the token caps) is coerced without a second edit here. Bounds and integer-ness stay in
 * `writeOverlay`, the single validator.
 */
function coerceSettingValue(key: string, raw: string): number | string {
  if (key === "model" || key === "provider") return raw;
  return Number(raw);
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
