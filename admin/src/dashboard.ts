/**
 * The live `/dispatch` dashboard overlay: a self-refreshing TUI panel over the same read-model the slash
 * commands use. It holds ONE queue and ONE redis client for its whole lifetime and polls them on a fixed
 * interval -- the self-closing read-model wrappers are one-shots for a single command, so a per-second
 * tick through them would open and drop a connection every second.
 *
 * The render never blocks on I/O: a background fetch writes the latest snapshot and the component always
 * renders the last one, so a slow or unreachable queue degrades the panel rather than freezing it. A
 * fetch already in flight suppresses the next tick's fetch, so a stall cannot stack overlapping reads.
 *
 * Three in-component views share this one overlay: LIST -- a framed monochrome panel of status, spend,
 * the unified TRIGGERS pane and an interactive runs list; RUN_DETAIL -- a drill-in of one run's PII-free
 * `.json` fields; and LIVE_TAIL -- a tail of a running job's `.log`.
 *
 * PII discipline (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT): LIST and RUN_DETAIL surface only
 * PII-free run records, counts, budget, schedulers and the settings overlay. LIVE_TAIL renders tail bytes
 * obtained through the injected `tailLog` seam whose `fs` access lives in index.ts, so this module never
 * touches the filesystem -- the bytes reach the overlay alone, never `snapshot`, never a shared renderer,
 * never a message.
 */
import { dayKey, weekKey, monthKey, windowState } from "@pi-dispatch/worker/budget";
import { parseConnection, makeRedisClient } from "@pi-dispatch/worker/connection";
import { makeQueue } from "@pi-dispatch/worker/queue";
import { listRuns, readSettingsView, mapSchedulers, readTriggers } from "./read-model.mjs";
import { renderStatus, renderBudget, renderTriggers, renderSettingsView } from "./render.mjs";
import { matchesKey } from "./keys.mjs";
import { box, meter, clip } from "./panel.mjs";

const KEY_HINTS = "[p]ause  [r]esume  [q]uit";
const RUNS_ON_DASHBOARD = 10;
const REFRESH_MS = 1000;
// Lines requested per tail fetch, and the on-screen window of them the LIVE_TAIL view scrolls through.
const TAIL_LINES = 200;
const TAIL_VIEWPORT = 20;
// panel.mjs floors a box to this width; below it (or a missing/non-finite width) the panel degrades to
// unframed plain lines rather than a ragged or over-width frame.
const MIN_WIDTH = 8;

/**
 * Build the read/act/close deps for a live dashboard from resolved paths: ONE failFast queue and ONE
 * redis client, both created here and closed once in `dispose`. `fetchSnapshot` reads the whole panel in
 * one pass off those held connections; `pause`/`resume` flip the durable paused state on the same queue.
 * `getWorkers` is EMPTY on Redis providers without CLIENT SETNAME, so an error or empty list degrades to
 * "unknown" rather than reporting zero live workers.
 */
export function createDashboardDeps(paths: any) {
  const queue = makeQueue(parseConnection(paths.valkeyUrl, { failFast: true }));
  const redis = makeRedisClient(paths.valkeyUrl);
  return {
    async fetchSnapshot() {
      const [pausedState, counts, workerList, dayRaw, weekRaw, monthRaw, schedulerList, activeList] = await Promise.all([
        queue.isPaused(),
        queue.getJobCounts("waiting", "active", "paused", "delayed", "failed"),
        queue.getWorkers().catch(() => []),
        redis.get(dayKey()),
        redis.get(weekKey()),
        redis.get(monthKey()),
        queue.getJobSchedulers(0, -1, true),
        queue.getActive(0, 0).catch(() => []),
      ]);
      const workers = Array.isArray(workerList) && workerList.length > 0 ? workerList.length : "unknown";
      return {
        queue: { pausedState, counts, workers },
        budget: { day: Number(dayRaw ?? 0), week: Number(weekRaw ?? 0), month: Number(monthRaw ?? 0) },
        schedulers: mapSchedulers(schedulerList, Date.now()),
        runs: listRuns({ logsDir: paths.logsDir, limit: RUNS_ON_DASHBOARD }),
        settings: readSettingsView({ settingsFile: paths.settingsFile }),
        triggers: readTriggers({ triggersPath: paths.triggersPath }),
        // ONLY the id off the active Job -- a Job's `.data` holds issue title/body/username (PII), so it
        // never enters the snapshot (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT).
        activeJobId: activeList?.[0]?.id ?? null,
      };
    },
    async pause() {
      await queue.pause();
    },
    async resume() {
      await queue.resume();
    },
    async dispose() {
      try {
        await queue.close();
      } catch {
        // best-effort teardown
      }
      try {
        redis.disconnect();
      } catch {
        // best-effort teardown
      }
    },
  };
}

/**
 * The dashboard overlay component. `deps` is the one injection seam: production defaults to a real
 * `createDashboardDeps(paths)` (one queue + one redis for the panel's lifetime); tests pass a canned
 * `fetchSnapshot` and `pause`/`resume`/`dispose` spies and never touch Redis. The first fetch fires
 * immediately so the panel is populated before the first interval tick; every fetch requests a re-render.
 */
export function makeDashboard({
  paths,
  done,
  tui,
  intervalMs = REFRESH_MS,
  deps = createDashboardDeps(paths),
}: any = {}) {
  let snapshot: any = null;
  let fetching = false;
  let disposed = false;
  let interval: any = null;
  // In-component view machine: LIST is the framed panel with the interactive run list; RUN_DETAIL is the
  // single-record dump; LIVE_TAIL tails a running job's `.log` inside the overlay. `selected` is the list
  // cursor; `detailRun` is the record captured on Enter.
  let view = "LIST";
  let selected = 0;
  let detailRun: any = null;
  // LIVE_TAIL state, held here in dedicated component fields keyed only by the id-only `activeJobId`. The
  // raw `.log` bytes in `tail` are PII-bearing and untrusted: they live here and reach the TUI overlay via
  // render() alone -- never `snapshot`, never a shared renderer, never `sendMessage` (INT-RUN-HISTORY-FILE-CONTRACT).
  let tailJobId: any = null;
  let tail: any = null;
  let tailTop = 0;

  const refresh = async () => {
    if (fetching || disposed) return;
    fetching = true;
    try {
      snapshot = await deps.fetchSnapshot();
      // Only while the tail view is open, and only through the injected capability, re-read the tail keyed
      // by the id-only `tailJobId`. `await` unwraps a synchronous return too. The bytes stay in `tail`.
      if (view === "LIVE_TAIL" && tailJobId && deps.tailLog) {
        tail = await deps.tailLog({ jobId: tailJobId, lines: TAIL_LINES });
      }
    } catch (err: any) {
      snapshot = { unreachable: err?.message ?? String(err) };
    } finally {
      fetching = false;
      tui?.requestRender?.();
    }
  };

  const act = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch {
      // A failed pause/resume surfaces as the next snapshot's paused state; never crash the overlay.
    }
    await refresh();
  };

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    try {
      await deps.dispose();
    } catch {
      // best-effort teardown
    }
  };

  interval = setInterval(() => void refresh(), intervalMs);
  void refresh();

  const component = {
    render(width: number): string[] {
      // Clamp the cursor here so a rows list that shrank between ticks can never leave `selected` pointing
      // past the end. `rows` spans the optional ACTIVE row plus the run records.
      const rows = buildRows(snapshot);
      if (selected > rows.length - 1) selected = Math.max(0, rows.length - 1);
      // Clamp the tail scroll so a shrinking log can never scroll past the end.
      if (view === "LIVE_TAIL") {
        const len = Array.isArray(tail?.lines) ? tail.lines.length : 0;
        const maxTop = Math.max(0, len - TAIL_VIEWPORT);
        tailTop = Math.min(Math.max(0, tailTop), maxTop);
      }
      return renderPanel(snapshot, width, {
        view,
        selected,
        detailRun,
        tailJobId,
        tail,
        tailTop,
        tailAvailable: typeof deps?.tailLog === "function",
      });
    },
    invalidate(): void {
      // No cached render state to clear; the TUI redraws from render().
    },
    handleInput(data: string): void {
      if (view === "RUN_DETAIL") {
        // Escape backs out to the list only; it never closes the overlay or disposes the held clients.
        // Every other key (including q/p/r) is inert in the detail view.
        if (matchesKey(data, "escape")) {
          view = "LIST";
          tui?.requestRender?.();
        }
        return;
      }
      if (view === "LIVE_TAIL") {
        // Escape backs out to the list and drops the held tail bytes; scroll keys move the window. Every
        // other key is inert. This view never closes the overlay or disposes the held clients.
        if (matchesKey(data, "escape")) {
          view = "LIST";
          tailJobId = null;
          tail = null;
          tailTop = 0;
          tui?.requestRender?.();
          return;
        }
        const len = Array.isArray(tail?.lines) ? tail.lines.length : 0;
        const maxTop = Math.max(0, len - TAIL_VIEWPORT);
        if (matchesKey(data, "up")) {
          tailTop = Math.max(0, tailTop - 1);
          tui?.requestRender?.();
        } else if (matchesKey(data, "down")) {
          tailTop = Math.min(maxTop, tailTop + 1);
          tui?.requestRender?.();
        } else if (matchesKey(data, "pageUp")) {
          tailTop = Math.max(0, tailTop - TAIL_VIEWPORT);
          tui?.requestRender?.();
        } else if (matchesKey(data, "pageDown")) {
          tailTop = Math.min(maxTop, tailTop + TAIL_VIEWPORT);
          tui?.requestRender?.();
        }
        return;
      }
      if (matchesKey(data, "escape") || data === "q" || data === "Q") {
        void dispose().finally(() => done(undefined));
        return;
      }
      if (data === "\r" || data === "\n") {
        const rows = buildRows(snapshot);
        const row = rows[selected];
        if (!row) return;
        if (row.kind === "active") {
          // Opening the tail: fire an immediate fetch so the first frame carries the tail, not the next tick.
          tailJobId = row.jobId;
          tailTop = 0;
          view = "LIVE_TAIL";
          void refresh();
        } else {
          detailRun = row.record;
          view = "RUN_DETAIL";
          tui?.requestRender?.();
        }
        return;
      }
      if (matchesKey(data, "up")) {
        selected = Math.max(0, selected - 1);
        tui?.requestRender?.();
        return;
      }
      if (matchesKey(data, "down")) {
        selected = Math.min(Math.max(0, buildRows(snapshot).length - 1), selected + 1);
        tui?.requestRender?.();
        return;
      }
      if (data === "p" || data === "P") {
        void act(deps.pause);
        return;
      }
      if (data === "r" || data === "R") {
        void act(deps.resume);
      }
    },
    dispose,
  };
  return component;
}

/** Split a renderer's multi-line string into the per-line array a `box` section expects. */
function toLines(text: string): string[] {
  return String(text).split("\n");
}

/**
 * One meter per spend window whose cap the admin can read (the overlay sets it). The day meter always shows
 * (parity with the single-window panel); week/month meters show only when their overlay cap is set. Each
 * meter's state comes from the worker's own `windowState`, so the bar's amber/red marker cannot drift from
 * what `reserveBudget` enforces. `meter` renders "cap unknown" for a window with no readable cap, so a
 * missing overlay cap degrades in place rather than guessing a denominator.
 */
function budgetMeters(budget: any, settings: any, width: number): string[] {
  const overlay = settings?.overlay ?? {};
  const pct = Number.isInteger(overlay.softHoldPct) ? overlay.softHoldPct : null;
  const specs = [
    { key: "day", cap: overlay.dailyCap, always: true },
    { key: "week", cap: overlay.weeklyCap, always: false },
    { key: "month", cap: overlay.monthlyCap, always: false },
  ];
  const out: string[] = [];
  for (const s of specs) {
    if (!s.always && !Number.isInteger(s.cap)) continue;
    const reserved = Number(budget?.[s.key] ?? 0);
    const state = Number.isInteger(s.cap) ? windowState(reserved, s.cap, pct) : "ok";
    out.push(meter(reserved, s.cap, width, state));
  }
  return out;
}

/**
 * Compose the monochrome framed panel from the last snapshot alone, reusing the slash-command renderers so
 * the panel and the commands cannot drift. A null snapshot is the pre-first-fetch loading state; a snapshot
 * carrying `unreachable` degrades the whole panel to one line rather than a wall of empty sections. A width
 * that is missing, non-finite, or below `MIN_WIDTH` degrades to unframed plain lines; a sane width frames
 * the same content with `box`, its inner column count driving every meter and clip.
 */
function renderPanel(snapshot: any, width: number, state: any): string[] {
  const { view, selected, detailRun, tailJobId, tail, tailTop, tailAvailable } = state;
  const framed = Number.isFinite(width) && Math.trunc(width) >= MIN_WIDTH;
  const inner = Math.trunc(width) - 4;
  const title = "pi-dispatch";

  if (view === "RUN_DETAIL") {
    const detailTitle = `run ${detailRun?.jobId ?? "-"}`;
    const detailLines = renderRunDetail(detailRun);
    if (!framed) return [detailTitle, "", ...detailLines, "", "Esc back"];
    return box({ title: detailTitle, footer: "Esc back", width, sections: [{ lines: detailLines }] });
  }

  if (view === "LIVE_TAIL") {
    return renderLiveTail({ snapshot, framed, width, tailJobId, tail, tailTop, tailAvailable });
  }

  if (snapshot === null) {
    if (!framed) return [`${title} -- loading`, "", KEY_HINTS];
    return box({ title, sections: [{ lines: ["loading"] }], footer: KEY_HINTS, width });
  }
  if (snapshot.unreachable) {
    const msg = `unreachable (${snapshot.unreachable})`;
    if (!framed) return [`${title} -- ${msg}`, "", KEY_HINTS];
    return box({ title, sections: [{ lines: [msg] }], footer: KEY_HINTS, width });
  }

  const sections = [
    { title: "STATUS", lines: toLines(renderStatus(snapshot.queue)) },
    {
      title: "SPEND",
      lines: [
        ...toLines(renderBudget({ budget: snapshot.budget, settings: snapshot.settings })),
        ...budgetMeters(snapshot.budget, snapshot.settings, framed ? inner : 24),
      ],
    },
    { title: "TRIGGERS", lines: toLines(renderTriggers({ schedulers: snapshot.schedulers, triggers: snapshot.triggers })) },
    { title: "RUNS", lines: renderRunList(buildRows(snapshot), selected, framed ? inner : 24) },
    { title: "SETTINGS", lines: toLines(renderSettingsView(snapshot.settings)) },
  ];

  if (framed) return box({ title, sections, footer: KEY_HINTS, width });

  const plain = [title];
  for (const section of sections) plain.push(section.title, ...section.lines);
  plain.push(KEY_HINTS);
  return plain.join("\n\n").split("\n");
}

/**
 * The selectable LIST rows: the optional ACTIVE row first (present only when the snapshot carries an
 * id-only `activeJobId`), then one row per run record. `selected` and up/down span this array; Enter
 * dispatches on `kind`. A null or malformed snapshot yields an empty list. No `.log`, no `.data` -- the
 * ACTIVE row carries only the id-only job id.
 */
function buildRows(snapshot: any): any[] {
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const active = snapshot?.activeJobId ? [{ kind: "active", jobId: snapshot.activeJobId }] : [];
  return [...active, ...runs.map((record: any) => ({ kind: "run", record }))];
}

/**
 * The interactive RUNS list over the rows model: one compact row per entry, cursor-prefixed (`›` on the
 * selected row, space otherwise). The ACTIVE row leads with its id-only job id; run rows lead with `jobId`
 * so a jobId match still hits. Each row is `clip`ped to the inner column count so a long target can neither
 * overflow the frame nor mis-size a row. Operates only on the passed rows -- no read, no `.log`, no `.data`.
 */
function renderRunList(rows: any[], selected: number, w: number): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return [clip("(no runs)", w)];
  return rows.map((row, i) => {
    const cursor = i === selected ? "›" : " ";
    if (row.kind === "active") return clip(`${cursor} * ACTIVE ${row.jobId} running`, w);
    const run = row.record;
    const cells = [run?.jobId, run?.target, run?.flow, run?.outcome, run?.turns, run?.tokens?.total]
      .map((f) => (f === null || f === undefined ? "-" : String(f)))
      .join(" · ");
    return clip(`${cursor} ${cells}`, w);
  });
}

/**
 * The LIVE_TAIL view: a bounded, scrollable window of a running job's captured `.log`, framed in the
 * overlay. The tail bytes arrive here only through render() -> this pure function and are returned as
 * overlay lines; they never enter `snapshot`, a shared renderer, or `sendMessage` (INT-RUN-HISTORY-FILE-CONTRACT).
 * Four states: capability absent, no captured log, the windowed tail, and the tail after the job left the
 * active slot. `tailTop` is clamped to `[0, maxTop]` so a shrunk log cannot scroll past the end.
 */
function renderLiveTail({ snapshot, framed, width, tailJobId, tail, tailTop, tailAvailable }: any): string[] {
  const boxTitle = `live ${tailJobId}`;
  let lines: string[];
  let footer: string;
  if (tail === null && !tailAvailable) {
    lines = ["live tail unavailable in this build"];
    footer = "Esc back";
  } else if (tail?.missing) {
    lines = [`live ${tailJobId} -- no captured log (PI_CAPTURE_JOB_LOGS off or not found)`];
    footer = "Esc back";
  } else {
    const all = Array.isArray(tail?.lines) ? tail.lines : [];
    const len = all.length;
    const maxTop = Math.max(0, len - TAIL_VIEWPORT);
    const top = Math.min(Math.max(0, tailTop), maxTop);
    lines = [`live ${tailJobId} -- ${len} line(s)`, ...all.slice(top, top + TAIL_VIEWPORT)];
    // The job left the active slot (ended, or a different job now runs): keep showing the last tail.
    if (snapshot?.activeJobId !== tailJobId) lines.push("(run ended -- Esc to go back)");
    footer = `[${Math.min(top + TAIL_VIEWPORT, len)}/${len}]  Up/Down PgUp/PgDn scroll, Esc back`;
  }
  if (!framed) return [boxTitle, "", ...lines, "", footer];
  return box({ title: boxTitle, footer, width, sections: [{ lines }] });
}

/**
 * A monochrome key/value dump of one run record, every value nullable-safe (`-` when null or undefined) so
 * the fixture's missing fields render rather than throw. Operates only on the passed record: no read, no
 * `.log`, no `.data` -- exactly the PII-free run-history fields (INT-RUN-HISTORY-FILE-CONTRACT).
 */
function renderRunDetail(record: any): string[] {
  const r = record ?? {};
  const show = (v: any): string => (v === null || v === undefined ? "-" : String(v));
  const fields: [string, any][] = [
    ["jobId", r.jobId],
    ["kind", r.kind],
    ["target", r.target],
    ["flow", r.flow],
    ["outcome", r.outcome],
    ["reason", r.reason],
    ["turns", r.turns],
    // Per-job token accounting (issue #25): total tokens and cost-USD, or `-` when the container died
    // before reporting usage. r.tokens is `{ input, output, total, cost }` | null.
    ["tokens", r.tokens?.total],
    ["cost", typeof r.tokens?.cost === "number" ? `$${r.tokens.cost.toFixed(4)}` : null],
    ["exitCode", r.exitCode],
    ["budgetReserved", r.budgetReserved],
    ["attempt", r.attempt],
    ["chainDepth", r.chainDepth],
    ["parentJobId", r.parentJobId],
    ["chainRefused", r.chainRefused],
    ["startedAt", r.startedAt],
    ["endedAt", r.endedAt],
  ];
  return fields.map(([k, v]) => `${k}: ${show(v)}`);
}
