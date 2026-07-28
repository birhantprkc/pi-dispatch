import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripAnsi, visibleLen } from "../src/style.mjs";

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

  // The colored LIST layout (rendered plain here — no theme passed, so PLAIN_THEME, no ANSI).
  assert.match(out, /PAUSED/, "the status header shows the paused state");
  assert.match(out, /2 waiting/, "counts line");
  assert.match(out, /1 workers/, "worker count");
  assert.match(out, /5\/25/, "the day spend meter shows reserved/cap");
  assert.match(out, /j1/, "last runs");
  assert.match(out, /model claude-x/, "settings summary");
  assert.match(out, /p pause/, "key hints");
  assert.match(out, /q quit/, "key hints");
});

test("the LIST shows a PAUSE WINDOWS section and marks an active window with a resume countdown", async () => {
  const snap = { ...SNAPSHOT, pauseWindows: { windows: [{ scope: "acme/web", from: "00:00", to: "23:59", tz: "UTC", fromMin: 0, toMin: 1439 }] } };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  const out = comp.render(90).join("\n");
  await comp.dispose();
  assert.match(out, /PAUSE WINDOWS/, "the pause-windows section renders");
  assert.match(out, /acme\/web/, "the window's scope");
  assert.match(out, /resumes in/, "an all-day window is active now -> resume countdown");
});

test("with a theme, the framed LIST is colored (ANSI present) but every line still fits the width", async () => {
  // A theme whose fg/bold emit real SGR, so the overlay is colored and the width stays ANSI-aware.
  const theme = { fg: (_c, t) => `\x1b[38;5;42m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, theme, deps: cannedDeps() });
  await flush();
  const lines = comp.render(80);
  await comp.dispose();

  assert.ok(lines.some((l) => l.includes("\x1b[")), "the overlay applies ANSI color");
  for (const l of lines) {
    assert.equal(visibleLen(l), 80, `every framed line is exactly 80 visible cols: ${JSON.stringify(stripAnsi(l))}`);
  }
  assert.match(stripAnsi(lines.join("\n")), /PAUSED/, "plain content survives under the color");
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

  assert.match(out, /9\/10/, "the day meter shows reserved/cap");
  assert.match(out, /· soft-hold/, "the day meter carries the soft-hold marker");
  assert.match(out, /soft-hold band: 80%/, "the configured band is shown");
  assert.match(out, /1\/50/, "the week window is listed once its cap is set");
});

test("the TRIGGERS section unifies the label allowlist with the schedulers block", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({
        ...SNAPSHOT,
        triggers: { triggers: [{ type: "label", any: ["bug"], all: [], none: [], flow: "fix" }] },
      }),
    }),
  });
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /TRIGGERS/, "the triggers section divider");
  assert.match(out, /bug → github fix/, "the label trigger row: match → target flow");
});

// --- staged packages (REQ-GLOBAL-PI-OVERLAY): which triggers arm the operator's third-party code ---

/** A one-trigger snapshot: `packages` is the trigger's arming, `staged` the overlay's manifest read. */
const armedSnap = (packages, staged = { stagedAt: null, packages: [] }) => ({
  ...SNAPSHOT,
  runs: [],
  activeJobId: null,
  triggers: { triggers: [{ type: "label", any: ["bug"], all: [], none: [], flow: "fix", packages }] },
  stagedPackages: staged,
});

const openTrigger = async (snap) => {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  const list = stripAnsi(comp.render(80).join("\n"));
  comp.handleInput("\r"); // row 0 is the trigger -- triggers lead the rows list
  await flush();
  const detail = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  return { list, detail };
};

test("the LIST badges an armed trigger, and leaves an unarmed one unmarked", async () => {
  const armed = await openTrigger(armedSnap(true, { stagedAt: "2026-07-27T10:00:00.000Z", packages: ["pi-web-search@1.4.2"] }));
  assert.match(armed.list, /bug → github fix \[packages\]/, "an armed trigger row says it loads staged packages");

  const plain = await openTrigger(armedSnap(false));
  assert.doesNotMatch(plain.list, /\[packages\]/, "a trigger that loads no third-party code is unmarked");
});

test("the armed badge is colored post-layout: the badged row still measures exactly `inner` cols", async () => {
  const theme = { fg: (_c, t) => `\x1b[38;5;42m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };
  const snap = armedSnap(true, { stagedAt: null, packages: ["pi-web-search@1.4.2"] });
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, theme, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  const lines = comp.render(80);
  await comp.dispose();
  assert.match(stripAnsi(lines.join("\n")), /\[packages\]/, "the badge survives under the color");
  for (const l of lines) {
    assert.equal(visibleLen(l), 80, `every framed line is exactly 80 visible cols: ${JSON.stringify(stripAnsi(l))}`);
  }
});

test("TRIGGER_DETAIL's trust model names the staged packages and warns, only for an armed trigger", async () => {
  const armed = await openTrigger(armedSnap(true, { stagedAt: "2026-07-27T10:00:00.000Z", packages: ["pi-web-search@1.4.2", "pi-jira@0.9.0"] }));
  assert.match(armed.detail, /TRUST MODEL/, "the armed lines join the per-kind trust model");
  assert.match(armed.detail, /collaborator's label/, "the static per-kind trust model still renders");
  assert.match(armed.detail, /packages armed · pi-web-search@1\.4\.2 · pi-jira@0\.9\.0/, "the staged names+versions");
  assert.match(armed.detail, /third-party code on adversarial input, open network egress/, "the one-line consequence");

  const plain = await openTrigger(armedSnap(false, { stagedAt: null, packages: ["pi-web-search@1.4.2"] }));
  assert.match(plain.detail, /TRUST MODEL/);
  assert.doesNotMatch(plain.detail, /packages armed/, "an unarmed trigger loads none of them, staged or not");
  assert.doesNotMatch(plain.detail, /open network egress/);
});

test("TRIGGER_DETAIL says so when a trigger is armed but the overlay stages nothing", async () => {
  const { detail } = await openTrigger(armedSnap(true, { stagedAt: null, packages: [] }));
  assert.match(detail, /packages armed · \(none staged in the overlay\)/, "armed with nothing staged is stated, not blank");
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
  assert.match(detail, /completed/, "the grouped post-mortem shows the colored outcome");
  assert.match(detail, /timing/, "the post-mortem groups the timing");
  assert.match(detail, /chain[\s\S]*root/, "the chain line marks a root run");
  assert.match(detail, /tokens\s+5000/, "the drill-in surfaces total tokens");
  assert.match(detail, /\$0\.0523/, "the drill-in surfaces cost as $-prefixed USD");
  assert.match(detail, /POST-MORTEM/, "the post-mortem divider is present");

  comp.handleInput("\x1b");
  await flush();
  const back = comp.render(80).join("\n");
  await comp.dispose();
  assert.match(back, /p pause/, "Esc returns to the interactive list");
  assert.equal(closed, 0, "Esc from a sub-view never closes the overlay");
});

test("RUN_DETAIL breaks out the subagent token share, and shows nothing for a pre-metering record", async () => {
  const openRun = async (tokens) => {
    const comp = makeDashboard({
      paths: {},
      done() {},
      tui: fakeTui(),
      intervalMs: 100000,
      deps: cannedDeps({ fetchSnapshot: async () => ({ ...SNAPSHOT, runs: [{ ...SNAPSHOT.runs[0], tokens }] }) }),
    });
    await flush();
    comp.handleInput("\r"); // row 0 is the only run
    await flush();
    const out = stripAnsi(comp.render(80).join("\n"));
    await comp.dispose();
    return out;
  };

  const metered = await openRun({ input: 4000, output: 1000, total: 5000, cost: 0.0523, otherTotal: 1200 });
  assert.match(metered, /tokens\s+5000/, "the existing tokens line is unchanged");
  assert.match(metered, /of which\s+subagents: 1200/, "the process-wide meter's subagent share");

  // A record written before the runner metered process-wide has no `otherTotal` at all: no line, and
  // certainly no NaN or a misleading bare 0.
  const preMetering = await openRun({ input: 4000, output: 1000, total: 5000, cost: 0.0523 });
  assert.match(preMetering, /tokens\s+5000/);
  assert.doesNotMatch(preMetering, /subagents/, "an older record renders nothing extra");
  assert.doesNotMatch(preMetering, /NaN/);

  // A metered run that spawned no subagent reports 0 -- also nothing, rather than a noise line.
  assert.doesNotMatch(await openRun({ total: 5000, cost: 0.01, otherTotal: 0 }), /subagents/);
  assert.doesNotMatch(await openRun(null), /subagents|NaN/, "a run with no usage at all still renders");
});

test("Enter on a cron trigger opens a detail with next/health/stalls from the scheduler", async () => {
  const snap = {
    queue: { pausedState: false, counts: { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
    budget: { day: 0, week: 0, month: 0 },
    settings: { path: "/s", overlay: {} },
    triggers: { triggers: [{ type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv", flow: "tidy" }] },
    schedulers: [{ key: "nightly", pattern: "0 3 * * *", next: Date.UTC(2030, 0, 1, 3, 0, 0), overdueMs: null }],
    schedulerStalls: { nightly: "1" },
    schedulerStallMax: 2,
    runs: [],
  };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  comp.handleInput("\r"); // row 0 is the cron trigger (triggers lead the rows list)
  await flush();
  const d = comp.render(80).join("\n");
  await comp.dispose();
  assert.match(d, /trigger · cron/, "titles on the cron trigger");
  assert.match(d, /healthy/, "shows a health marker when the scheduler is not overdue");
  assert.match(d, /2030-01-01 03:00/, "formats the scheduler's real next-fire timestamp");
  assert.match(d, /stalls 1\/2/, "surfaces the stall count against the threshold");
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

// --- CRUD signaling: overlay keys close with an action the command loop drives via ctx.ui dialogs ---

const triggerSnap = (triggers) => ({ ...SNAPSHOT, runs: [], activeJobId: null, triggers: { triggers } });

test("pressing 'a' in the list signals an addTrigger action", async () => {
  const actions = [];
  const comp = makeDashboard({ paths: {}, done: (v) => actions.push(v), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  comp.handleInput("a");
  await flush();
  await flush();
  assert.deepEqual(actions, [{ action: "addTrigger" }]);
});

test("pressing 's' in the list signals an editSettings action", async () => {
  const actions = [];
  const comp = makeDashboard({ paths: {}, done: (v) => actions.push(v), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  comp.handleInput("s");
  await flush();
  await flush();
  assert.deepEqual(actions, [{ action: "editSettings" }]);
});

test("Enter on a trigger opens TRIGGER_DETAIL (trust model); e/x signal edit/delete with the file index", async () => {
  const actions = [];
  const snap = triggerSnap([{ type: "label", any: ["bug"], all: [], none: [], flow: "fix" }]);
  const comp = makeDashboard({ paths: {}, done: (v) => actions.push(v), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();

  comp.handleInput("\r"); // selected 0 is the trigger -> TRIGGER_DETAIL
  await flush();
  const detail = stripAnsi(comp.render(80).join("\n"));
  assert.match(detail, /TRUST MODEL/, "the drill-in shows the per-kind trust model");
  assert.match(detail, /collaborator's label/, "the label trust model text");

  comp.handleInput("e");
  await flush();
  await flush();
  assert.deepEqual(actions, [{ action: "editTrigger", index: 0 }], "e signals editTrigger with the file index");
});

test("x in TRIGGER_DETAIL signals deleteTrigger; Esc backs out without signaling", async () => {
  const snap = triggerSnap([{ type: "cron", id: "n", pattern: "0 3 * * *", folder: "/p", flow: "tidy" }]);
  // delete path
  const delActions = [];
  const c1 = makeDashboard({ paths: {}, done: (v) => delActions.push(v), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  c1.handleInput("\r");
  await flush();
  c1.handleInput("x");
  await flush();
  await flush();
  assert.deepEqual(delActions, [{ action: "deleteTrigger", index: 0 }]);

  // esc path: no action, back to LIST
  const escActions = [];
  const c2 = makeDashboard({ paths: {}, done: (v) => escActions.push(v), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  c2.handleInput("\r");
  await flush();
  c2.handleInput("\x1b"); // Esc
  await flush();
  assert.deepEqual(escActions, [], "Esc from the trigger detail signals no CRUD action");
  await c2.dispose();
});
