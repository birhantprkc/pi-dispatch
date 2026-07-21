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
  budget: { reserved: 5 },
  settings: { path: "/s", overlay: { model: "claude-x", dailyCap: 25 } },
  runs: [
    {
      jobId: "j1",
      target: "o/r#5",
      flow: "fix",
      outcome: "completed",
      reason: null,
      turns: 4,
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
