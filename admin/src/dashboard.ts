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
import { dayKey, weekKey, monthKey, tokenDayKey, windowState } from "@pi-dispatch/worker/budget";
import { parseConnection, makeRedisClient } from "@pi-dispatch/worker/connection";
import { makeQueue } from "@pi-dispatch/worker/queue";
import { listRuns, readSettingsView, mapSchedulers, readTriggers } from "./read-model.mjs";
import { renderStatus, renderBudget, renderTriggers, renderSettingsView } from "./render.mjs";
import { matchesKey } from "./keys.mjs";
import { box, meter, clip } from "./panel.mjs";
import { makeStyler, frame, RULE } from "./style.mjs";

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
      const [pausedState, counts, workerList, dayRaw, weekRaw, monthRaw, tokenRaw, schedulerList, activeList] = await Promise.all([
        queue.isPaused(),
        queue.getJobCounts("waiting", "active", "paused", "delayed", "failed"),
        queue.getWorkers().catch(() => []),
        redis.get(dayKey()),
        redis.get(weekKey()),
        redis.get(monthKey()),
        redis.get(tokenDayKey()), // issue #25 daily token spend (budget:t:YYYY-MM-DD)
        queue.getJobSchedulers(0, -1, true),
        queue.getActive(0, 0).catch(() => []),
      ]);
      const workers = Array.isArray(workerList) && workerList.length > 0 ? workerList.length : "unknown";
      return {
        queue: { pausedState, counts, workers },
        budget: { day: Number(dayRaw ?? 0), week: Number(weekRaw ?? 0), month: Number(monthRaw ?? 0), tokensToday: Number(tokenRaw ?? 0) },
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
  theme,
  intervalMs = REFRESH_MS,
  deps = createDashboardDeps(paths),
}: any = {}) {
  // The overlay-only color styler, bound to pi's injected theme (null in tests -> plain, same geometry).
  const styler = makeStyler(theme);
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
  let detailTrigger: any = null; // the trigger opened in TRIGGER_DETAIL (its display record + file index)
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
  interval?.unref?.(); // never keep the process alive on the poll timer alone (dispose still clears it)
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
        detailTrigger,
        tailJobId,
        tail,
        tailTop,
        tailAvailable: typeof deps?.tailLog === "function",
      }, styler);
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
      if (view === "TRIGGER_DETAIL") {
        // Read-only trust-model view. `e` edits the flow, `x` deletes -- both close the overlay with a CRUD
        // action the command loop drives via ctx.ui dialogs, then reopens; Esc backs out to the list.
        if (matchesKey(data, "escape")) {
          view = "LIST";
          detailTrigger = null;
          tui?.requestRender?.();
          return;
        }
        if (data === "e" || data === "E") {
          void dispose().finally(() => done({ action: "editTrigger", index: detailTrigger?.index }));
          return;
        }
        if (data === "x" || data === "X") {
          void dispose().finally(() => done({ action: "deleteTrigger", index: detailTrigger?.index }));
          return;
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
        if (row.kind === "trigger") {
          detailTrigger = { record: row.trigger, index: row.index };
          view = "TRIGGER_DETAIL";
          tui?.requestRender?.();
        } else if (row.kind === "active") {
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
      // CRUD (operator-typed, live via the reload watchers): add a trigger, or edit the limits/settings.
      // Both close the overlay with an action the command loop drives via ctx.ui dialogs, then reopen.
      if (data === "a" || data === "A") {
        void dispose().finally(() => done({ action: "addTrigger" }));
        return;
      }
      if (data === "s" || data === "S") {
        void dispose().finally(() => done({ action: "editSettings" }));
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
function renderPanel(snapshot: any, width: number, state: any, styler: any): string[] {
  const { view, selected, detailRun, detailTrigger, tailJobId, tail, tailTop, tailAvailable } = state;
  const framed = Number.isFinite(width) && Math.trunc(width) >= MIN_WIDTH;
  const inner = Math.trunc(width) - 4;
  const title = "pi-dispatch";

  if (view === "TRIGGER_DETAIL") {
    const t = detailTrigger?.record;
    const detailTitle = `trigger · ${t?.type ?? "?"}`;
    const lines = renderTriggerDetail(t, framed ? inner : 24, styler);
    if (!framed) return [detailTitle, "", ...lines.map((l: string) => styler.stripAnsi(l)), "", "e edit · x delete · esc back"];
    return frame(styler, { title: detailTitle, width, lines, footer: triggerDetailHints(inner, styler) });
  }

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

  // LIST — the colored dashboard. Content is composed on PLAIN text (widths via styler.cell/visibleLen)
  // and colored last, so pi's ANSI-aware visibleWidth frames it correctly.
  if (framed) {
    const lines = buildListLines(snapshot, selected, inner, styler);
    return frame(styler, { title, width, lines, footer: keyHints(inner, styler) });
  }

  // Degraded (too-narrow) plain path — reuse the shared, plain renderers unframed.
  const sections = [
    { title: "STATUS", lines: toLines(renderStatus(snapshot.queue)) },
    {
      title: "SPEND",
      lines: [
        ...toLines(renderBudget({ budget: snapshot.budget, settings: snapshot.settings })),
        ...budgetMeters(snapshot.budget, snapshot.settings, 24),
      ],
    },
    { title: "TRIGGERS", lines: toLines(renderTriggers({ schedulers: snapshot.schedulers, triggers: snapshot.triggers })) },
    { title: "RUNS", lines: renderRunList(buildRows(snapshot), selected, 24) },
    { title: "SETTINGS", lines: toLines(renderSettingsView(snapshot.settings)) },
  ];
  const plain = [title];
  for (const section of sections) plain.push(section.title, ...section.lines);
  plain.push(KEY_HINTS);
  return plain.join("\n\n").split("\n");
}

// ── colored LIST builders (overlay-only; every returned line is exactly `inner` visible columns) ────────

const KIND_COLOR: Record<string, string> = { cron: "accent", label: "syntaxType", comment: "syntaxKeyword", pull_request: "syntaxFunction" };
const KIND_WIDTH = 13; // fits "pull_request "

/** Pad an already-colored line up to `inner` visible columns; if it overflows, clip its plain form. */
function fitLine(line: string, inner: number, styler: any): string {
  const vis = styler.visibleLen(line);
  if (vis === inner) return line;
  if (vis < inner) return line + " ".repeat(inner - vis);
  return styler.cell(styler.stripAnsi(line), inner);
}

/** Compose the colored LIST body lines (RULE marks a `├──┤` separator). */
function buildListLines(snapshot: any, selected: number, inner: number, styler: any): any[] {
  const lines: any[] = [];
  lines.push(statusHeader(snapshot.queue, inner, styler));
  lines.push(RULE);

  lines.push(styler.divider("spend & limits", "jobs & tokens/day · s set", inner));
  for (const l of spendLines(snapshot.budget, snapshot.settings, inner, styler)) lines.push(l);
  lines.push(RULE);

  // Triggers are selectable and come FIRST in buildRows, so a trigger's file index == its selection index.
  const trg = triggerLines(snapshot.triggers, selected, inner, styler);
  lines.push(styler.divider("triggers", `${trg.count} standing · a add · ↵ open`, inner));
  for (const l of trg.lines) lines.push(l);
  lines.push(RULE);

  // Active + run rows follow the triggers in buildRows, so offset the selection index by the trigger count.
  const runRows = buildRows(snapshot).slice(trg.count);
  const runCount = Array.isArray(snapshot.runs) ? snapshot.runs.length : 0;
  lines.push(styler.divider("runs", `last ${runCount}`, inner));
  for (const l of runLines(runRows, selected - trg.count, inner, styler)) lines.push(l);
  lines.push(RULE);

  lines.push(styler.divider("settings", "s edit", inner));
  for (const l of settingsLines(snapshot.settings, inner, styler)) lines.push(l);
  return lines;
}

/** The one-line STATUS header: `● RUNNING  N waiting · … · K workers        HH:MM:SS`. */
function statusHeader(queue: any, inner: number, styler: any): string {
  if (!queue || queue.unreachable) {
    return styler.cell(`queue unreachable (${queue?.unreachable ?? "?"})`, inner, { color: "error" });
  }
  const c = queue.counts ?? {};
  const running = !queue.pausedState;
  const failed = Number(c.failed ?? 0);
  const stateColor = running ? "success" : "warning";
  const dot = styler.fg(stateColor, "●");
  const word = styler.bold(styler.fg(stateColor, running ? "RUNNING" : "PAUSED"));
  const sep = styler.fg("dim", " · ");
  const vitals =
    `${c.waiting ?? 0} waiting` + sep + `${c.active ?? 0} active` + sep +
    (failed > 0 ? styler.fg("error", `${failed} failed`) : `${failed} failed`) + sep +
    `${queue.workers ?? "?"} workers`;
  const clock = new Date().toISOString().slice(11, 19); // HH:MM:SS UTC
  const left = `${dot} ${word}  ${vitals}`;
  const gap = inner - styler.visibleLen(left) - clock.length;
  if (gap < 1) return styler.cell(styler.stripAnsi(left), inner);
  return left + " ".repeat(gap) + styler.fg("dim", clock);
}

/** Colored spend meters (day/week/month) with reset countdown + soft-hold marker. */
function spendLines(budget: any, settings: any, inner: number, styler: any): string[] {
  if (!budget || budget.unreachable) {
    return [styler.cell(`budget unreachable (${budget?.unreachable ?? "?"})`, inner, { color: "error" })];
  }
  const overlay = (settings && settings.overlay) ?? {};
  const pct = Number.isInteger(overlay.softHoldPct) ? overlay.softHoldPct : null;
  const now = new Date();
  const specs = [
    { key: "day", label: "day", cap: overlay.dailyCap, reset: nextDayResetMs(now), always: true },
    { key: "week", label: "week", cap: overlay.weeklyCap, reset: nextWeekResetMs(now), always: false },
    { key: "month", label: "month", cap: overlay.monthlyCap, reset: nextMonthResetMs(now), always: false },
  ];
  const out: string[] = [];
  const labW = 6;
  for (const s of specs) {
    const reserved = Number(budget[s.key] ?? 0);
    const capSet = Number.isInteger(s.cap);
    // The day cap always applies (env default even when the overlay is silent). Week/month default to
    // disabled, so when the overlay sets no cap and nothing has reserved, show them as an off, enableable
    // window rather than hiding them — the operator sees every limit and which are switched off.
    if (!capSet && !s.always && reserved === 0) {
      out.push(styler.fg("muted", s.label.padEnd(labW)) + styler.fg("dim", "off · no cap set (s to enable)"));
      continue;
    }
    const state = capSet ? windowState(reserved, s.cap, pct) : "ok";
    const marker = state === "soft-hold" ? " · soft-hold" : state === "over" ? " · over" : "";
    const tail = countdownText(s.reset) + marker;
    const barW = Math.max(8, inner - labW - 2 - tail.length);
    const line =
      styler.cell(s.label, labW, { color: "muted" }) + " " +
      styler.meter(reserved, s.cap, barW, state) + " " +
      styler.fg("dim", tail);
    out.push(fitLine(line, inner, styler));
  }
  if (pct !== null) out.push(styler.cell(`soft-hold band: ${pct}% of each cap`, inner, { color: "muted" }));
  out.push(tokenLine(budget, overlay, pct, inner, styler));
  return out;
}

/** The daily token counter (issue #25): today's spend vs the daily token cap, plus the per-job budget. */
function tokenLine(budget: any, overlay: any, pct: number | null, inner: number, styler: any): string {
  const spent = Number(budget?.tokensToday ?? 0);
  const cap = overlay?.dailyTokenCap;
  const perJob = overlay?.maxTokens;
  const perJobNote = Number.isInteger(perJob) ? ` · per-job ${fmtTokens(perJob)}` : " · per-job budget off";
  const lab = styler.fg("muted", "tokens") + " "; // 6-wide label + space, matching the meter rows
  if (Number.isInteger(cap)) {
    const state = spent >= cap ? "over" : Number.isInteger(pct) && spent > Math.floor((cap * pct) / 100) ? "soft-hold" : "ok";
    const color = state === "over" ? "error" : state === "soft-hold" ? "warning" : "success";
    const marker = state === "soft-hold" ? " soft-hold" : state === "over" ? " over" : "";
    return fitLine(lab + styler.fg(color, `${fmtTokens(spent)} / ${fmtTokens(cap)} today${marker}`) + styler.fg("dim", perJobNote), inner, styler);
  }
  return fitLine(lab + styler.fg("text", `${fmtTokens(spent)} today`) + styler.fg("dim", ` · daily cap off${perJobNote}`), inner, styler);
}

/** Compact token count: 1234 -> "1.2k", 1234567 -> "1.2M". */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** The configured triggers as colored rows: `<kind>  <match>  → <target> <flow>`. */
function triggerLines(triggers: any, selected: number, inner: number, styler: any): { count: number; lines: string[] } {
  const lines: string[] = [];
  if (triggers && triggers.missing) { lines.push(styler.cell("(triggers file not found · a to add)", inner, { color: "dim" })); return { count: 0, lines }; }
  if (triggers && triggers.invalid) { lines.push(styler.cell(`(triggers file invalid: ${triggers.invalid})`, inner, { color: "error" })); return { count: 0, lines }; }
  const list = (triggers && triggers.triggers) ?? [];
  if (list.length === 0) { lines.push(styler.cell("(no triggers · a to add)", inner, { color: "dim" })); return { count: 0, lines }; }
  list.forEach((t: any, i: number) => lines.push(triggerRow(t, i === selected, inner, styler)));
  return { count: list.length, lines };
}

function triggerRow(t: any, sel: boolean, inner: number, styler: any): string {
  const cursor = sel ? styler.fg("accent", "›") : " ";
  const kind = t?.type ?? "?";
  const badge = styler.cell(kind, KIND_WIDTH, { color: KIND_COLOR[kind] ?? "muted" });
  return fitLine(`${cursor} ${badge} ${matchColored(t, styler)} ${targetColored(t, styler)}`, inner, styler);
}

function matchColored(t: any, styler: any): string {
  switch (t?.type) {
    case "cron": return styler.fg("text", `${t.id ?? "-"}  ${t.pattern ?? "-"}`);
    case "comment": return styler.fg("text", `"${t.phrase ?? "-"}"`);
    case "label":
    case "pull_request": {
      const parts: string[] = [];
      if (t.type === "pull_request") parts.push(styler.fg("muted", `[${(t.action ?? []).join(",")}]`));
      for (const x of t.any ?? []) parts.push(styler.fg("success", x));
      for (const x of t.all ?? []) parts.push(styler.fg("success", `+${x}`));
      for (const x of t.none ?? []) parts.push(styler.fg("error", `!${x}`));
      return parts.length ? parts.join(" ") : styler.fg("dim", "(any)");
    }
    default: return styler.fg("dim", "?");
  }
}

function targetColored(t: any, styler: any): string {
  const arrow = styler.fg("dim", "→");
  const flow = styler.bold(styler.fg("text", t?.flow ?? "-"));
  if (t?.type === "cron") {
    // A local/cron trigger runs its flow against a folder — show `local <folder>/<flow>` so the target
    // (not just the flow name) is visible; github triggers get their repo from the webhook, so none there.
    const base = t.folder ? String(t.folder).split(/[/\\]/).filter(Boolean).pop() ?? "" : "";
    const folderPart = base ? styler.fg("muted", base) + styler.fg("dim", "/") : "";
    return `${arrow} ${styler.fg("success", "local")} ${folderPart}${flow}`;
  }
  return `${arrow} ${styler.fg("accent", "github")} ${flow}`;
}

/** The interactive RUNS list, colored: cursor, id, target, flow, outcome (✔/⚠/✘), turns, tokens. */
function runLines(rows: any[], selected: number, inner: number, styler: any): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return [styler.cell("(no runs)", inner, { color: "dim" })];
  return rows.map((row, i) => runRow(row, i === selected, inner, styler));
}

function runRow(row: any, sel: boolean, inner: number, styler: any): string {
  const cursor = sel ? styler.fg("accent", "›") : " ";
  if (row.kind === "active") {
    return fitLine(`${cursor} ${styler.fg("success", "● ACTIVE")} ${styler.fg("text", row.jobId)} ${styler.fg("dim", "running")}`, inner, styler);
  }
  const r = row.record ?? {};
  const tree = r.chainDepth > 0 ? styler.fg("dim", "└ ") : "";
  const sep = styler.fg("dim", " · ");
  const cells = [
    styler.fg("text", r.jobId ?? "-"),
    styler.fg("muted", r.target ?? "-"),
    styler.fg("accent", r.flow ?? "-"),
    outcomeColored(r.outcome, r.reason, styler),
    styler.fg("dim", `${r.turns ?? "-"}t`),
    styler.fg("dim", `${r.tokens?.total ?? "-"}`),
  ];
  return fitLine(`${cursor} ${tree}${cells.join(sep)}`, inner, styler);
}

function outcomeColored(outcome: any, reason: any, styler: any): string {
  if (outcome === "completed") return styler.fg("success", "✔ done");
  if (outcome === "policy") return styler.fg("warning", `⚠ ${reason ?? "policy"}`);
  return styler.fg("error", `✘ ${reason ?? outcome ?? "failed"}`);
}

/** A compact colored settings summary (the full editor is the `s` drill-in). */
function settingsLines(settings: any, inner: number, styler: any): string[] {
  if (settings && settings.invalid) return [styler.cell(`settings invalid: ${settings.invalid}`, inner, { color: "error" })];
  const o = (settings && settings.overlay) ?? {};
  const kv = (k: string, v: any) => styler.fg("muted", k) + " " + styler.fg("text", v === undefined ? "·" : String(v));
  const gap = styler.fg("dim", "   ");
  const l1 = [kv("model", o.model), kv("provider", o.provider), kv("maxTurns", o.maxTurns)].join(gap);
  const l2 = [kv("dailyCap", o.dailyCap), kv("dailyTokenCap", o.dailyTokenCap), kv("concurrency", o.concurrency), kv("softHold", o.softHoldPct)].join(gap);
  return [fitLine(l1, inner, styler), fitLine(l2, inner, styler)];
}

/**
 * The TRIGGER_DETAIL drill-in: the trigger's filter + a per-kind TRUST MODEL block (following the design
 * mock). Read-only; the `e`/`x` keys drive edit/delete through the command loop. Every line is `inner` cols.
 */
function renderTriggerDetail(t: any, inner: number, styler: any): string[] {
  if (!t) return [styler.cell("(no trigger)", inner, { color: "dim" })];
  const out: string[] = [];
  const kv = (k: string, v: string, color = "text") =>
    fitLine(styler.cell(k, 12, { color: "muted" }) + " " + styler.fg(color, v), inner, styler);

  out.push(fitLine(styler.fg(KIND_COLOR[t.type] ?? "muted", t.type ?? "?") + "  " + styler.bold(styler.fg("text", `→ ${t.flow ?? "-"}`)), inner, styler));
  out.push(styler.cell("", inner));
  if (t.type === "cron") {
    out.push(kv("when", `${t.pattern ?? "-"}`));
    out.push(kv("produces", `local · ${t.folder ?? "-"} · flow ${t.flow ?? "-"}`, "success"));
  } else if (t.type === "label" || t.type === "pull_request") {
    if (t.type === "pull_request") out.push(kv("actions", (t.action ?? []).join(", ") || "-"));
    out.push(kv("any of", (t.any ?? []).join(" · ") || "-", "success"));
    out.push(kv("all of", (t.all ?? []).join(" · ") || "-", "success"));
    out.push(kv("none of", (t.none ?? []).join(" · ") || "-", "error"));
    out.push(kv("produces", `github · repo#issue · flow ${t.flow ?? "-"}`, "accent"));
  } else if (t.type === "comment") {
    out.push(kv("phrase", `"${t.phrase ?? "-"}"`));
    out.push(kv("produces", `github · flow ${t.flow ?? "-"}`, "accent"));
  }
  out.push(styler.cell("", inner));
  out.push(styler.divider("trust model", null, inner));
  for (const line of trustModel(t)) out.push(fitLine(styler.fg("border", "· ") + styler.fg("text", line), inner, styler));
  return out;
}

/** The static per-kind trust model (who authorizes it, how it dedups, which service owns it). */
function trustModel(t: any): string[] {
  switch (t?.type) {
    case "cron":
      return [
        "authorized by the operator's triggers file, at boot",
        "dedup by time — deterministic repeat:<id>:<millis> id",
        "lives in the worker · task is operator-authored",
      ];
    case "label":
    case "pull_request":
      return [
        "authorized by a collaborator's label + HMAC webhook + author gate",
        "dedup by X-GitHub-Delivery GUID (redelivery-safe)",
        "lives in the receiver · task is adversarial issue/PR text",
      ];
    case "comment":
      return [
        "authorized by a collaborator comment (author_association) + HMAC",
        "dedup by X-GitHub-Delivery GUID",
        "lives in the receiver · task is adversarial comment text",
      ];
    default:
      return [];
  }
}

/** The TRIGGER_DETAIL footer hints. */
function triggerDetailHints(inner: number, styler: any): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  return fitLine([k("e", "edit flow"), k("x", "delete"), k("esc", "back")].join(styler.fg("dim", "  ·  ")), inner, styler);
}

/** The colored key-hint footer. */
function keyHints(inner: number, styler: any): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  const hints = [k("↑↓", "select"), k("↵", "open"), k("a", "add"), k("l", "logs"), k("p", "pause"), k("r", "resume"), k("q", "quit")].join(styler.fg("dim", " · "));
  return fitLine(hints, inner, styler);
}

/** ms until the next UTC midnight / Monday 00:00 UTC / month-1 00:00 UTC. */
function nextDayResetMs(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
}
function nextWeekResetMs(now: Date): number {
  const daysUntilMon = ((1 - now.getUTCDay() + 7) % 7) || 7;
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMon) - now.getTime();
}
function nextMonthResetMs(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime();
}

/** "resets in 9h 54m" / "resets in 12m" / "" when unknown. */
function countdownText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin >= 2 * 1440) return `resets ${Math.round(totalMin / 1440)}d`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `resets ${h}h ${m}m` : `resets ${m}m`;
}

/**
 * The selectable LIST rows: the optional ACTIVE row first (present only when the snapshot carries an
 * id-only `activeJobId`), then one row per run record. `selected` and up/down span this array; Enter
 * dispatches on `kind`. A null or malformed snapshot yields an empty list. No `.log`, no `.data` -- the
 * ACTIVE row carries only the id-only job id.
 */
function buildRows(snapshot: any): any[] {
  // Triggers lead the selectable list (Enter -> TRIGGER_DETAIL), then the optional ACTIVE row, then runs.
  // A trigger row carries its file `index` so a CRUD action can target the right entry in triggers.json.
  const triggers = (snapshot?.triggers?.triggers ?? []).map((t: any, i: number) => ({ kind: "trigger", trigger: t, index: i }));
  const active = snapshot?.activeJobId ? [{ kind: "active", jobId: snapshot.activeJobId }] : [];
  const runs = (Array.isArray(snapshot?.runs) ? snapshot.runs : []).map((record: any) => ({ kind: "run", record }));
  return [...triggers, ...active, ...runs];
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
