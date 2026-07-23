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

test("renderRuns aligns columns with a header and a data row, including the chain marker", () => {
  const out = renderRuns([
    {
      jobId: "j1",
      target: "o/r#5",
      flow: "fix",
      outcome: "completed",
      reason: null,
      turns: 4,
      chainDepth: 1,
      endedAt: "2026-07-21T00:00:00.000Z",
    },
  ]);
  assert.match(out, /JOB ID/);
  assert.match(out, /CHAIN/);
  assert.match(out, /j1/);
  assert.match(out, /o\/r#5/);
  assert.match(out, /completed/);
  assert.match(out, /\bd1\b/, "a chained child renders a d<n> depth marker");
});

test("renderRuns surfaces per-job tokens and cost, and dashes them when usage is absent", () => {
  const out = renderRuns([
    { jobId: "j1", target: "o/r#5", flow: "fix", outcome: "completed", turns: 4, tokens: { input: 4000, output: 1000, total: 5000, cost: 0.0523 }, endedAt: "2026-07-21T00:00:00.000Z" },
    { jobId: "j2", target: "o/r#6", flow: "fix", outcome: "failed", turns: null, tokens: null, endedAt: "2026-07-21T00:01:00.000Z" },
  ]);
  assert.match(out, /TOKENS/);
  assert.match(out, /COST/);
  assert.match(out, /\b5000\b/, "total tokens render for a run that reported usage");
  assert.match(out, /\$0\.0523/, "cost renders as a $-prefixed fixed-decimal");
  const noUsageRow = out.split("\n").find((l) => l.includes("j2"));
  assert.match(noUsageRow, /-/, "a run without usage dashes its token/cost cells");
});

test("renderRuns renders a fully-null record as dashes (chain column included)", () => {
  const out = renderRuns([{ jobId: null, target: null, flow: null, outcome: null, reason: null, turns: null, chainDepth: null, endedAt: null }]);
  assert.match(out, /CHAIN/);
  const dataRow = out.split("\n")[1];
  assert.match(dataRow, /^-(\s+-)+\s*$/, "a non-chain record renders '-' in the chain column");
});

test("renderRuns degrades on empty and unreachable inputs", () => {
  assert.match(renderRuns([]), /No runs/);
  assert.match(renderRuns({ unreachable: "x" }), /unreachable/);
});

test("renderBudget shows the day window's reserved count and the overlay-derived cap", () => {
  const out = renderBudget({ budget: { day: 5, week: 0, month: 0 }, settings: { path: "/s", overlay: { dailyCap: 25 } } });
  assert.match(out, /day: reserved 5 \/ cap 25 \(overlay\)/);
});

test("renderBudget marks the day cap unknown when the overlay omits dailyCap", () => {
  const out = renderBudget({ budget: { day: 0 }, settings: { path: "/s", overlay: {} } });
  assert.match(out, /day: reserved 0 \/ cap unknown/);
});

test("renderBudget shows week/month windows only when the overlay sets their cap (or they are reserving)", () => {
  const withCaps = renderBudget({
    budget: { day: 1, week: 4, month: 9 },
    settings: { path: "/s", overlay: { dailyCap: 25, weeklyCap: 100, monthlyCap: 400 } },
  });
  assert.match(withCaps, /week: reserved 4 \/ cap 100 \(overlay\)/);
  assert.match(withCaps, /month: reserved 9 \/ cap 400 \(overlay\)/);

  // No overlay week/month caps and zero reserved -> those lines are omitted (window not in play).
  const dayOnly = renderBudget({ budget: { day: 1, week: 0, month: 0 }, settings: { path: "/s", overlay: { dailyCap: 25 } } });
  assert.doesNotMatch(dayOnly, /week:/);
  assert.doesNotMatch(dayOnly, /month:/);

  // An env-configured window the admin cannot read the cap for still surfaces once it is reserving.
  const envWeek = renderBudget({ budget: { day: 1, week: 3, month: 0 }, settings: { path: "/s", overlay: { dailyCap: 25 } } });
  assert.match(envWeek, /week: reserved 3 \/ cap unknown/);
});

test("renderBudget marks a window soft-hold / over via the shared windowState, and shows the band", () => {
  // day cap 10, softHoldPct 80 -> threshold 8; reserved 9 is inside the band.
  const soft = renderBudget({ budget: { day: 9 }, settings: { path: "/s", overlay: { dailyCap: 10, softHoldPct: 80 } } });
  assert.match(soft, /day: reserved 9 \/ cap 10 \(overlay\) \[soft-hold\]/);
  assert.match(soft, /soft-hold band: 80%/);

  const over = renderBudget({ budget: { day: 11 }, settings: { path: "/s", overlay: { dailyCap: 10 } } });
  assert.match(over, /\[over\]/);
});

test("renderBudget reports unreachable", () => {
  assert.match(renderBudget({ budget: { unreachable: "down" }, settings: {} }), /unreachable/);
});

test("renderTriggers lists schedulers with next + overdue drift and a label trigger line", () => {
  const out = renderTriggers({
    schedulers: [{ key: "s1", next: Date.UTC(2026, 6, 21, 0, 0, 0), overdueMs: 5000 }],
    triggers: { triggers: [{ type: "label", any: ["pi:frontend"], all: [], none: ["wontfix"], flow: "frontend-fix" }] },
  });
  assert.match(out, /s1/);
  assert.match(out, /next 2026-07-21T00:00:00.000Z/);
  assert.match(out, /overdue by 5s/);
  assert.match(out, /label {2}any\[pi:frontend\] none\[wontfix\] → frontend-fix/);
});

test("renderTriggers renders each of the four on.types", () => {
  const out = renderTriggers({
    schedulers: [],
    triggers: {
      triggers: [
        { type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/p", flow: "tidy" },
        { type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix" },
        { type: "comment", phrase: "@pi", flow: "fix" },
        { type: "pull_request", action: ["labeled"], any: ["pi:review"], all: [], none: [], flow: "review" },
      ],
    },
  });
  assert.match(out, /cron {2}nightly {2}0 3 \* \* \* → \/srv\/p\/tidy/);
  assert.match(out, /label {2}any\[pi:frontend\] → frontend-fix/);
  assert.match(out, /comment {2}"@pi" → fix/);
  assert.match(out, /pull_request {2}action\[labeled\] any\[pi:review\] → review/);
});

test("renderTriggers degrades on no schedulers and a missing triggers file", () => {
  const out = renderTriggers({ schedulers: [], triggers: { missing: true } });
  assert.match(out, /none configured/);
  assert.match(out, /triggers file not found/);
});

test("renderTriggers reports an invalid triggers file and an empty list", () => {
  assert.match(renderTriggers({ schedulers: [], triggers: { invalid: "bad" } }), /triggers file invalid: bad/);
  assert.match(renderTriggers({ schedulers: [], triggers: { triggers: [] } }), /\(no triggers\)/);
});

test("renderTriggers reports an unreachable scheduler read", () => {
  assert.match(renderTriggers({ schedulers: { unreachable: "down" }, triggers: { triggers: [] } }), /unreachable \(down\)/);
});

test("renderSettingsView lists all ten keys, unset ones marked", () => {
  const out = renderSettingsView({ path: "/s", overlay: { model: "claude", dailyCap: 5, weeklyCap: 100, softHoldPct: 80, maxTokens: 500000 } });
  assert.match(out, /Settings \(\/s\)/);
  assert.match(out, /model: claude/);
  assert.match(out, /dailyCap: 5/);
  assert.match(out, /weeklyCap: 100/);
  assert.match(out, /softHoldPct: 80/);
  assert.match(out, /maxTokens: 500000/);
  assert.match(out, /provider: \(unset\)/);
  assert.match(out, /monthlyCap: \(unset\)/);
  assert.match(out, /dailyTokenCap: \(unset\)/);
  assert.match(out, /concurrency: \(unset\)/);
});

test("renderSettingsView surfaces invalid overlays", () => {
  assert.match(renderSettingsView({ path: "/s", invalid: "dailyCap must be an integer >= 1" }), /invalid/);
});
