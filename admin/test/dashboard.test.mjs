import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The live dashboard overlay. `makeDashboard` takes one injection seam -- `deps` (fetchSnapshot + the
 * pause/resume/dispose actions) -- so every test here runs fully offline against a canned snapshot and
 * spies, never opening a Redis connection. Loaded through pi's own jiti (the production extension loader),
 * since the component is authored in erasable TS.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const dashboardPath = fileURLToPath(new URL("../src/dashboard.ts", import.meta.url));
const { makeDashboard } = await jiti.import(dashboardPath);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeTui = () => ({ requestRender() {} });

const SNAPSHOT = {
  queue: { pausedState: true, counts: { waiting: 2, active: 1, paused: 0, delayed: 0, failed: 3 }, workers: 1 },
  budget: { day: 5, week: 0, month: 0 },
  settings: { path: "/s", overlay: { model: "claude-x", dailyCap: 25 } },
  runs: [
    {
      jobId: "j1",
      target: "o/r#5",
      flow: "fix",
      outcome: "completed",
      reason: null,
      turns: 4,
      tokens: { input: 4000, output: 1000, total: 5000, cost: 0.0523 },
      endedAt: "2026-07-21T00:00:00.000Z",
    },
  ],
  schedulers: [{ key: "s1", next: Date.UTC(2026, 6, 21, 0, 0, 0), overdueMs: 5000 }],
};

function cannedDeps(overrides = {}) {
  return {
    fetchSnapshot: async () => SNAPSHOT,
    pause: async () => {},
    resume: async () => {},
    dispose: async () => {},
    ...overrides,
  };
}

test("renders every section from the last snapshot, reusing the command renderers", async () => {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /Queue: paused/, "header shows the paused state");
  assert.match(out, /waiting 2/, "counts line");
  assert.match(out, /workers: 1/, "worker count");
  assert.match(out, /reserved 5 \/ cap 25 \(overlay\)/, "budget line");
  assert.match(out, /j1/, "last runs");
  assert.match(out, /Schedulers:/);
  assert.match(out, /overdue by 5s/, "scheduler drift");
  assert.match(out, /Settings \(\/s\)/, "settings summary");
  assert.match(out, /\[p\]ause {2}\[r\]esume {2}\[q\]uit/, "key hints");
});

test("before the first fetch resolves it renders a loading panel, not a crash", () => {
  // A fetch that never resolves: the panel must still render (from the null snapshot) synchronously.
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({ fetchSnapshot: () => new Promise(() => {}) }),
  });
  const out = comp.render(80).join("\n");
  comp.dispose();
  assert.match(out, /loading/);
  assert.match(out, /\[p\]ause/);
});

test("a throwing fetch degrades the whole panel to one unreachable line", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => {
        throw new Error("down");
      },
    }),
  });
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();
  assert.match(out, /unreachable \(down\)/);
});

test("p pauses and r resumes on the held queue, each refreshing the snapshot", async () => {
  let paused = 0;
  let resumed = 0;
  let fetches = 0;
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => {
        fetches++;
        return SNAPSHOT;
      },
      pause: async () => {
        paused++;
      },
      resume: async () => {
        resumed++;
      },
    }),
  });
  await flush();
  const afterInit = fetches;

  comp.handleInput("p");
  await flush();
  assert.equal(paused, 1, "p paused the held queue");
  assert.ok(fetches > afterInit, "pause refreshes the snapshot immediately");

  comp.handleInput("r");
  await flush();
  assert.equal(resumed, 1, "r resumed the held queue");

  await comp.dispose();
});

test("q and escape close the overlay and its held clients", async () => {
  for (const key of ["q", "\x1b"]) {
    let closed = 0;
    let disposed = 0;
    const comp = makeDashboard({
      paths: {},
      done: () => {
        closed++;
      },
      tui: fakeTui(),
      intervalMs: 100000,
      deps: cannedDeps({
        dispose: async () => {
          disposed++;
        },
      }),
    });
    await flush();
    comp.handleInput(key);
    await flush();
    assert.equal(closed, 1, `${JSON.stringify(key)} closes the overlay`);
    assert.equal(disposed, 1, `${JSON.stringify(key)} closes the held clients`);
  }
});

test("dispose clears the interval so no fetch fires afterward, and closes the held clients once", async () => {
  let fetches = 0;
  let disposed = 0;
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 10,
    deps: cannedDeps({
      fetchSnapshot: async () => {
        fetches++;
        return SNAPSHOT;
      },
      dispose: async () => {
        disposed++;
      },
    }),
  });
  await delay(35);
  const before = fetches;
  assert.ok(before >= 1, "the live panel polls while open");

  await comp.dispose();
  await delay(35);

  assert.equal(fetches, before, "no fetch fires after dispose -- the interval is cleared");
  assert.equal(disposed, 1, "the held clients are closed exactly once");

  await comp.dispose();
  assert.equal(disposed, 1, "dispose is idempotent");
});

test("dashboard.ts has no path to raw .log content", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)), "utf8");
  assert.ok(
    !/readLogTail|readFileSync|\breadFile\b/.test(src),
    "the dashboard renders records/counts/settings only -- raw .log bytes belong to the logs viewer alone",
  );
});

test("frames to a sane width and degrades to unframed plain lines at a tiny width", async () => {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  const framed = comp.render(80);
  const tiny = comp.render(4).join("\n");
  await comp.dispose();

  assert.match(framed.join("\n"), /[┌┐└┘│─]/, "a sane width draws a box frame");
  assert.ok(framed.every((l) => l.length <= 80), "no framed line exceeds the requested width");
  assert.doesNotMatch(tiny, /[┌┐└┘│─]/, "below MIN_WIDTH the panel drops the frame rather than emitting a ragged box");
});

test("the spend meter shows a filled bar against a known cap, and (cap unknown) with no bar otherwise", async () => {
  const known = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  const knownOut = known.render(80).join("\n");
  await known.dispose();

  const unknown = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    // Overlay carries no dailyCap, so the true cap is unknown to this process: no bar, no denominator.
    deps: cannedDeps({ fetchSnapshot: async () => ({ ...SNAPSHOT, settings: { path: "/s", overlay: { model: "m" } } }) }),
  });
  await flush();
  const unknownOut = unknown.render(80).join("\n");
  await unknown.dispose();

  assert.match(knownOut, /5\/25/, "reserved/cap label against the overlay cap");
  assert.match(knownOut, /[█]/, "a filled block glyph fills the bar");
  assert.match(unknownOut, /cap unknown/, "an unknown cap renders as text");
  assert.doesNotMatch(unknownOut, /[█]/, "no bar is drawn against an unknown denominator");
});

test("the spend panel shows the soft-hold state (amber-as-text) when a window is in the band", async () => {
  // day cap 10, softHoldPct 80 -> threshold 8; reserved 9 is in-band, week/month set so all three meter.
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({
        ...SNAPSHOT,
        budget: { day: 9, week: 1, month: 1 },
        settings: { path: "/s", overlay: { dailyCap: 10, weeklyCap: 50, monthlyCap: 200, softHoldPct: 80 } },
      }),
    }),
  });
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /day: reserved 9 \/ cap 10 \(overlay\) \[soft-hold\]/, "the day window text shows soft-hold");
  assert.match(out, /soft-hold band: 80%/, "the configured band is shown");
  assert.match(out, /9\/10 soft-hold/, "the day meter carries the soft-hold marker (monochrome, so text not colour)");
  assert.match(out, /week: reserved 1 \/ cap 50/, "the week window is listed once its cap is set");
});

test("the TRIGGERS section unifies the label allowlist with the schedulers block", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({ fetchSnapshot: async () => ({ ...SNAPSHOT, flows: { rules: { fix: { any: ["bug"] } } } }) }),
  });
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /Triggers:/, "the committed trigger-rules header");
  assert.match(out, /fix: any\[bug\]/, "the per-flow rule row");
  assert.match(out, /Schedulers:/, "the schedulers block shares the section");
});

test("Enter on a run opens its detail dump, and Esc backs out to the list without quitting", async () => {
  let closed = 0;
  const comp = makeDashboard({
    paths: {},
    done: () => {
      closed++;
    },
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps(),
  });
  await flush();

  comp.handleInput("\x1b[B");
  comp.handleInput("\r");
  await flush();
  const detail = comp.render(80).join("\n");
  assert.match(detail, /run j1/, "the detail view titles on the selected run");
  assert.match(detail, /attempt: -/, "a detail-only field renders, absent as '-'");
  assert.match(detail, /tokens: 5000/, "the drill-in surfaces total tokens");
  assert.match(detail, /cost: \$0\.0523/, "the drill-in surfaces cost as $-prefixed USD");

  comp.handleInput("\x1b");
  await flush();
  const back = comp.render(80).join("\n");
  await comp.dispose();
  assert.match(back, /\[p\]ause/, "Esc returns to the interactive list");
  assert.equal(closed, 0, "Esc from a sub-view never closes the overlay");
});

test("Enter on the ACTIVE row tails its live log inside the overlay", async () => {
  const calls = [];
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({ ...SNAPSHOT, activeJobId: "jA" }),
      tailLog: (args) => {
        calls.push(args);
        return { lines: ["HELLO_TAIL"] };
      },
    }),
  });
  await flush();

  comp.handleInput("\r");
  await flush();
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /HELLO_TAIL/, "the captured tail line renders in the overlay");
  assert.match(out, /live jA/, "the tail view titles on the id-only active job");
  assert.match(out, /\[\d+\/\d+\]/, "a windowed footer counts the tail");
  assert.equal(calls[0].jobId, "jA", "the tail is keyed by the id-only active job id");
});

test("the live tail reports a missing captured log by job id", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({ ...SNAPSHOT, activeJobId: "jA" }),
      tailLog: () => ({ missing: true }),
    }),
  });
  await flush();

  comp.handleInput("\r");
  await flush();
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /no captured log \(PI_CAPTURE_JOB_LOGS/, "a missing log degrades to a captured-off notice");
});

test("the live tail reports unavailable when no tail capability is injected", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    // No tailLog capability in deps: the view degrades rather than reaching for a .log surface.
    deps: cannedDeps({ fetchSnapshot: async () => ({ ...SNAPSHOT, activeJobId: "jA" }) }),
  });
  await flush();

  comp.handleInput("\r");
  await flush();
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /unavailable/, "an absent tail capability renders as unavailable in this build");
});

test("PageDown scrolls the live tail window past the first viewport", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({ ...SNAPSHOT, activeJobId: "jA" }),
      tailLog: () => ({ lines: Array.from({ length: 50 }, (_, i) => "L" + i) }),
    }),
  });
  await flush();

  comp.handleInput("\r");
  await flush();
  await flush();
  const before = comp.render(80).join("\n");
  assert.match(before, /\[20\/50\]/, "the first frame windows the first viewport of 50 lines");

  comp.handleInput("\x1b[6~");
  await flush();
  const after = comp.render(80).join("\n");
  await comp.dispose();
  assert.match(after, /\[40\/50\]/, "PageDown advances the window a full viewport past line 20");
});
