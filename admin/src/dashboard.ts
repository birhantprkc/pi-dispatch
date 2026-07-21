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
 * PII discipline (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT): the panel shows PII-free run records,
 * counts, budget, schedulers and the settings overlay only. Raw `.log` bytes are never read here -- that
 * surface belongs to the logs overlay viewer in index.ts alone.
 */
import { dayKey } from "@pi-dispatch/worker/budget";
import { parseConnection, makeRedisClient } from "@pi-dispatch/worker/connection";
import { makeQueue } from "@pi-dispatch/worker/queue";
import { listRuns, readSettingsView, mapSchedulers } from "./read-model.mjs";
import { renderStatus, renderBudget, renderRuns, renderSchedulers, renderSettingsView } from "./render.mjs";
import { matchesKey } from "./keys.mjs";

const KEY_HINTS = "[p]ause  [r]esume  [q]uit";
const RUNS_ON_DASHBOARD = 10;
const REFRESH_MS = 1000;

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
      const [pausedState, counts, workerList, reservedRaw, schedulerList] = await Promise.all([
        queue.isPaused(),
        queue.getJobCounts("waiting", "active", "paused", "delayed", "failed"),
        queue.getWorkers().catch(() => []),
        redis.get(dayKey()),
        queue.getJobSchedulers(0, -1, true),
      ]);
      const workers = Array.isArray(workerList) && workerList.length > 0 ? workerList.length : "unknown";
      return {
        queue: { pausedState, counts, workers },
        budget: { reserved: Number(reservedRaw ?? 0) },
        schedulers: mapSchedulers(schedulerList, Date.now()),
        runs: listRuns({ logsDir: paths.logsDir, limit: RUNS_ON_DASHBOARD }),
        settings: readSettingsView({ settingsFile: paths.settingsFile }),
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

  const refresh = async () => {
    if (fetching || disposed) return;
    fetching = true;
    try {
      snapshot = await deps.fetchSnapshot();
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
    render(_width: number): string[] {
      return renderDashboard(snapshot);
    },
    invalidate(): void {
      // No cached render state to clear; the TUI redraws from render().
    },
    handleInput(data: string): void {
      if (matchesKey(data, "escape") || data === "q" || data === "Q") {
        void dispose().finally(() => done(undefined));
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

/**
 * Compose the panel text from the last snapshot alone, reusing the slash-command renderers so the panel
 * and the commands cannot drift. A null snapshot is the pre-first-fetch state; a snapshot carrying
 * `unreachable` degrades the whole panel to one line rather than a wall of empty sections.
 */
function renderDashboard(snapshot: any): string[] {
  if (snapshot === null) {
    return ["pi-dispatch dashboard -- loading...", "", KEY_HINTS];
  }
  if (snapshot.unreachable) {
    return [`pi-dispatch dashboard -- unreachable (${snapshot.unreachable})`, "", KEY_HINTS];
  }
  const blocks = [
    "pi-dispatch dashboard",
    renderStatus(snapshot.queue),
    renderBudget({ budget: snapshot.budget, settings: snapshot.settings }),
    renderRuns(snapshot.runs),
    renderSchedulers(snapshot.schedulers),
    renderSettingsView(snapshot.settings),
    KEY_HINTS,
  ];
  return blocks.join("\n\n").split("\n");
}
