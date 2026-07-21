/**
 * Pure text renderers for the admin extension: a read-model record (or array) in, a display string out.
 * No I/O, no clock, no process.env -- every input is a value the caller already fetched, so these are
 * testable with plain fixtures.
 *
 * PII discipline (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT): a renderer only ever sees the PII-free
 * record fields (`target` is `repo#issue` / `local:<basename>` only), the five settings keys, scheduler
 * keys, and flow labels. Raw `.log` bytes are untrusted, PII-bearing container output and NEVER reach a
 * renderer -- the logs overlay in index.ts is their only surface, so there is deliberately no code path
 * from here to a `.log` file (asserted by render.test.mjs).
 */

const SETTINGS_KEYS = ["model", "provider", "maxTurns", "dailyCap", "concurrency"];

const RUN_COLUMNS = [
  { key: "jobId", header: "JOB ID" },
  { key: "target", header: "TARGET" },
  { key: "flow", header: "FLOW" },
  { key: "outcome", header: "OUTCOME" },
  { key: "reason", header: "REASON" },
  { key: "turns", header: "TURNS" },
  { key: "endedAt", header: "ENDED" },
];

/** A nullish record field renders as "-" so a stable record shape reads cleanly. */
function cell(value) {
  if (value === null || value === undefined) return "-";
  return String(value);
}

/** Render the queue slice of `status`: paused state, the five job counts, and the worker count. */
export function renderStatus(queue) {
  if (!queue || queue.unreachable) {
    return `Queue: unreachable (${queue?.unreachable ?? "unknown"})`;
  }
  const counts = queue.counts ?? {};
  const line = ["waiting", "active", "paused", "delayed", "failed"]
    .map((k) => `${k} ${counts[k] ?? 0}`)
    .join("  ");
  const workers = queue.workers === undefined ? "unknown" : queue.workers;
  return [`Queue: ${queue.pausedState ? "paused" : "running"}`, `  ${line}`, `  workers: ${workers}`].join("\n");
}

/** Render the run history as aligned columns; a null field is "-", an unreachable/empty set degrades. */
export function renderRuns(runs) {
  if (runs && runs.unreachable) return `Runs: unreachable (${runs.unreachable})`;
  const list = Array.isArray(runs) ? runs : [];
  if (list.length === 0) return "No runs recorded.";

  const headers = RUN_COLUMNS.map((c) => c.header);
  const rows = list.map((r) => RUN_COLUMNS.map((c) => cell(r?.[c.key])));
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const fmt = (cells) => cells.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

/**
 * Render the budget: reserved count and the daily cap. The cap is only known to the admin when the
 * overlay sets `dailyCap`; otherwise the worker resolves it from its own env/default, which this process
 * cannot read authoritatively, so it renders as unknown rather than a guessed number.
 */
export function renderBudget({ budget, settings } = {}) {
  if (!budget || budget.unreachable) {
    return `Budget: unreachable (${budget?.unreachable ?? "unknown"})`;
  }
  return `Budget: reserved ${budget.reserved ?? 0} / cap ${capLabel(settings)}`;
}

function capLabel(settings) {
  const overlay = settings && settings.overlay;
  if (overlay && Number.isInteger(overlay.dailyCap)) return `${overlay.dailyCap} (overlay)`;
  return "unknown (worker env/default)";
}

/**
 * Render just the schedulers block: a header and one line per resident scheduler with its next fire time
 * and next-drift. `overdueMs` surfaces the silent under-firing BullMQ's no-overlap scheduler can hide
 * (design.md:249). An unreachable read or an empty set degrades in place rather than throwing.
 */
export function renderSchedulers(schedulers) {
  const out = ["Schedulers:"];
  if (schedulers && schedulers.unreachable) {
    out.push(`  unreachable (${schedulers.unreachable})`);
  } else {
    const list = Array.isArray(schedulers) ? schedulers : [];
    if (list.length === 0) out.push("  (none configured)");
    else for (const s of list) out.push(`  ${schedulerLine(s)}`);
  }
  return out.join("\n");
}

/**
 * Render triggers display-only (OQ-008): the schedulers block, then the committed label->flow allowlist.
 */
export function renderTriggers({ schedulers, flows } = {}) {
  const out = [renderSchedulers(schedulers), "", "Label -> flow:"];
  if (flows && flows.missing) {
    out.push("  (flows file not found)");
  } else if (flows && flows.invalid) {
    out.push(`  (flows file invalid: ${flows.invalid})`);
  } else {
    const mappings = (flows && flows.mappings) ?? {};
    const labels = Object.keys(mappings);
    if (labels.length === 0) out.push("  (no mappings)");
    else for (const label of labels) out.push(`  ${label} -> ${mappings[label]}`);
  }
  return out.join("\n");
}

function schedulerLine(s) {
  const id = s?.key ?? s?.name ?? "-";
  const next = typeof s?.next === "number" ? new Date(s.next).toISOString() : "no next";
  const drift =
    typeof s?.overdueMs === "number" && s.overdueMs > 0 ? `  overdue by ${Math.round(s.overdueMs / 1000)}s` : "";
  return `${id}  next ${next}${drift}`;
}

/** Render the settings overlay view: all five keys, unset ones marked, or the fail-closed invalid reason. */
export function renderSettingsView(settings) {
  const path = settings?.path ?? "(unknown path)";
  if (settings && settings.invalid) return `Settings (${path}): invalid: ${settings.invalid}`;
  const overlay = (settings && settings.overlay) ?? {};
  const out = [`Settings (${path}):`];
  for (const key of SETTINGS_KEYS) {
    const v = overlay[key];
    out.push(`  ${key}: ${v === undefined ? "(unset)" : v}`);
  }
  return out.join("\n");
}
