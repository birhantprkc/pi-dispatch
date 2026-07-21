import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderStatus, renderRuns, renderBudget, renderTriggers, renderSettingsView } from "../src/render.mjs";

test("render.mjs has no path to raw .log content", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/render.mjs", import.meta.url)), "utf8");
  // A renderer has no I/O: no fs read and no call into the log tail. (A doc comment may name `.log`;
  // what matters is that no code path reads one.)
  assert.ok(
    !/readLogTail|readFileSync|\breadFile\b|require\(|import\s+.*node:fs/.test(src),
    "renderers must never read raw log content -- that surface belongs to the overlay viewer only",
  );
});

test("renderStatus shows paused state, counts, and workers", () => {
  const out = renderStatus({
    pausedState: false,
    counts: { waiting: 2, active: 1, paused: 0, delayed: 0, failed: 3 },
    workers: 1,
  });
  assert.match(out, /Queue: running/);
  assert.match(out, /waiting 2/);
  assert.match(out, /failed 3/);
  assert.match(out, /workers: 1/);
});

test("renderStatus reports paused and unreachable", () => {
  assert.match(renderStatus({ pausedState: true, counts: {}, workers: "unknown" }), /Queue: paused/);
  assert.match(renderStatus({ unreachable: "down" }), /unreachable \(down\)/);
});

test("renderRuns aligns columns with a header and a data row", () => {
  const out = renderRuns([
    {
      jobId: "j1",
      target: "o/r#5",
      flow: "fix",
      outcome: "completed",
      reason: null,
      turns: 4,
      endedAt: "2026-07-21T00:00:00.000Z",
    },
  ]);
  assert.match(out, /JOB ID/);
  assert.match(out, /j1/);
  assert.match(out, /o\/r#5/);
  assert.match(out, /completed/);
});

test("renderRuns renders a fully-null record as dashes", () => {
  const out = renderRuns([{ jobId: null, target: null, flow: null, outcome: null, reason: null, turns: null, endedAt: null }]);
  const dataRow = out.split("\n")[1];
  assert.match(dataRow, /^-(\s+-)+\s*$/);
});

test("renderRuns degrades on empty and unreachable inputs", () => {
  assert.match(renderRuns([]), /No runs/);
  assert.match(renderRuns({ unreachable: "x" }), /unreachable/);
});

test("renderBudget shows reserved and the overlay-derived cap", () => {
  const out = renderBudget({ budget: { reserved: 5 }, settings: { path: "/s", overlay: { dailyCap: 25 } } });
  assert.match(out, /reserved 5/);
  assert.match(out, /cap 25 \(overlay\)/);
});

test("renderBudget marks the cap unknown when the overlay omits dailyCap", () => {
  const out = renderBudget({ budget: { reserved: 0 }, settings: { path: "/s", overlay: {} } });
  assert.match(out, /cap unknown/);
});

test("renderBudget reports unreachable", () => {
  assert.match(renderBudget({ budget: { unreachable: "down" }, settings: {} }), /unreachable/);
});

test("renderTriggers lists schedulers with next + overdue drift and the label map", () => {
  const out = renderTriggers({
    schedulers: [{ key: "s1", next: Date.UTC(2026, 6, 21, 0, 0, 0), overdueMs: 5000 }],
    flows: { mappings: { "pi:frontend": "frontend-fix" } },
  });
  assert.match(out, /s1/);
  assert.match(out, /next 2026-07-21T00:00:00.000Z/);
  assert.match(out, /overdue by 5s/);
  assert.match(out, /pi:frontend -> frontend-fix/);
});

test("renderTriggers degrades on no schedulers and missing flows", () => {
  const out = renderTriggers({ schedulers: [], flows: { missing: true } });
  assert.match(out, /none configured/);
  assert.match(out, /flows file not found/);
});

test("renderTriggers reports an unreachable scheduler read", () => {
  assert.match(renderTriggers({ schedulers: { unreachable: "down" }, flows: { mappings: {} } }), /unreachable \(down\)/);
});

test("renderSettingsView lists all five keys, unset ones marked", () => {
  const out = renderSettingsView({ path: "/s", overlay: { model: "claude", dailyCap: 5 } });
  assert.match(out, /Settings \(\/s\)/);
  assert.match(out, /model: claude/);
  assert.match(out, /dailyCap: 5/);
  assert.match(out, /provider: \(unset\)/);
  assert.match(out, /concurrency: \(unset\)/);
});

test("renderSettingsView surfaces invalid overlays", () => {
  assert.match(renderSettingsView({ path: "/s", invalid: "dailyCap must be an integer >= 1" }), /invalid/);
});
