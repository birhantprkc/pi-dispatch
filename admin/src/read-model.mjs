/**
 * The admin extension's whole data-access surface: reads the queue, the budget counter, the durable
 * run-history files (INT-RUN-HISTORY-FILE-CONTRACT, admin is the named consumer), the settings overlay
 * (INT-CONFIG-OVERLAY-CONTRACT), and the receiver's label->flow allowlist.
 *
 * Every function takes injected dependencies (`fs`, `makeQueueFn`, `redisFn`, ...) with real defaults, so
 * the tests run fully offline against fakes and production uses the worker's own helpers unchanged. The
 * key derivations and validators are IMPORTED from the worker, never re-implemented, so the admin and the
 * worker cannot drift on the budget key, the settings contract, or the id sanitiser.
 *
 * Read-only by construction: the budget read is a plain side-effect-free GET (never reserveBudget /
 * INCR / EXPIRE), the settings read never writes, and a viewer degrades -- an unreachable queue or an
 * absent file returns a discriminated `{ unreachable }` / `{ missing }` rather than throwing to the
 * command handler.
 */

import * as nodeFs from "node:fs";
import { join } from "node:path";
import { defaultLogsDir } from "@pi-dispatch/worker/config";
import { settingsFilePath, readOverlay, writeOverlay, KNOWN_KEYS } from "@pi-dispatch/worker/runtime-settings";
import { sanitizeJobId } from "@pi-dispatch/worker/run-history";
import { dayKey } from "@pi-dispatch/worker/budget";
import { parseConnection, makeRedisClient } from "@pi-dispatch/worker/connection";
import { makeQueue } from "@pi-dispatch/worker/queue";

// Re-exported so the command layer reaches the key contract through the admin's single worker-coupling
// funnel, never re-deriving the five known keys.
export { KNOWN_KEYS };

/**
 * Resolve the paths and URLs the admin reads, from `env` alone. Mirrors the worker's own defaulting
 * (`|| default` so an empty string falls back) but deliberately NEVER calls `loadConfig`: like the CLI
 * kill switch (cli.mjs:80-88), the admin must work when the worker's GitHub auth or other env is broken,
 * so it depends only on the handful of variables it actually reads.
 */
export function resolvePaths(env = process.env) {
  return {
    valkeyUrl: env.VALKEY_URL ?? "redis://127.0.0.1:6379",
    logsDir: env.PI_LOGS_DIR || defaultLogsDir(),
    settingsFile: settingsFilePath(env),
    flowsPath: env.RECEIVER_FLOWS_PATH ?? "deploy/receiver.flows.json",
    captureJobLogs: env.PI_CAPTURE_JOB_LOGS === "1",
  };
}

/**
 * Read paused state, the five job counts, and the worker count through one failFast Queue, always closed.
 * `getWorkers` is EMPTY on Redis providers without CLIENT SETNAME, so an empty/absent list degrades to
 * "unknown" rather than reporting zero live workers. Any connection error returns `{ unreachable }`.
 */
export async function readQueueState({ url, makeQueueFn = makeQueue, parseConnectionFn = parseConnection } = {}) {
  let queue;
  try {
    queue = makeQueueFn(parseConnectionFn(url, { failFast: true }));
    const pausedState = await queue.isPaused();
    const counts = await queue.getJobCounts("waiting", "active", "paused", "delayed", "failed");
    const workers = await readWorkerCount(queue);
    return { pausedState, counts, workers };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
}

/**
 * Set the queue's durable paused state through one failFast Queue, always closed. `pause()`/`resume()`
 * mirror the CLI kill switch (cli.mjs:90-95): the state survives a worker restart. Returns
 * `{ ok: true, paused }` on success, or `{ unreachable }` on a connection error, closing in `finally`.
 */
export async function setQueuePaused({ url, paused, makeQueueFn = makeQueue, parseConnectionFn = parseConnection } = {}) {
  let queue;
  try {
    queue = makeQueueFn(parseConnectionFn(url, { failFast: true }));
    if (paused) await queue.pause();
    else await queue.resume();
    return { ok: true, paused };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
}

/**
 * Read-modify-write the settings overlay: read the current file, apply `mutate` to a copy of the base
 * overlay, and write the result through the worker's own atomic `writeOverlay`. When the existing file is
 * invalid, the base is empty `{}` and `rebuiltFrom` carries the read reason so the caller can surface the
 * loud repair notice (INT-CONFIG-OVERLAY-CONTRACT write protocol). Validation stays in `writeOverlay`; a
 * rejected candidate returns `{ invalid }`. Returns `{ ok: true, overlay, rebuiltFrom? }`.
 */
export function writeSettings({ settingsFile, mutate, fs = nodeFs }) {
  const res = readOverlay(settingsFile, { fs });
  const base = res.overlay ?? {};
  const next = mutate({ ...base });
  const w = writeOverlay(settingsFile, next, { fs });
  if (w.invalid) return { invalid: w.invalid };
  return res.invalid ? { ok: true, overlay: next, rebuiltFrom: res.invalid } : { ok: true, overlay: next };
}

async function readWorkerCount(queue) {
  try {
    const list = await queue.getWorkers();
    return Array.isArray(list) && list.length > 0 ? list.length : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read the resident job schedulers and compute per-entry `overdueMs`: BullMQ's no-overlap scheduler can
 * silently under-fire under load, so the admin surfaces `next` drift rather than let it look healthy
 * (design.md:249). Returns an array, or `{ unreachable }` on a connection error.
 */
export async function readSchedulers({
  url,
  makeQueueFn = makeQueue,
  parseConnectionFn = parseConnection,
  now = Date.now,
} = {}) {
  let queue;
  try {
    queue = makeQueueFn(parseConnectionFn(url, { failFast: true }));
    const list = await queue.getJobSchedulers(0, -1, true);
    return mapSchedulers(list, now());
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
}

/**
 * Map raw BullMQ job-scheduler entries to the PII-free display shape, computing per-entry `overdueMs`
 * against `nowMs`. Pure, so the live dashboard can map the entries it reads off its own held queue
 * without re-opening a connection per tick. A non-array input maps to an empty list.
 */
export function mapSchedulers(list, nowMs) {
  return (Array.isArray(list) ? list : []).map((s) => {
    const next = typeof s?.next === "number" ? s.next : null;
    return {
      key: s?.key ?? s?.id ?? s?.name ?? null,
      name: s?.name ?? null,
      pattern: s?.pattern ?? null,
      every: s?.every ?? null,
      next,
      overdueMs: next !== null && next < nowMs ? nowMs - next : null,
    };
  });
}

/**
 * Read today's reserved budget count with a plain, side-effect-free GET of the worker's own `dayKey()` --
 * NEVER an INCR/EXPIRE, so observing the budget cannot consume a slot. `makeRedisClient` has no failFast
 * option and would otherwise buffer the GET forever while disconnected, so the read is bounded by a
 * timeout that degrades to `{ unreachable }`; the client is force-disconnected in `finally`.
 */
export async function readBudget({ url, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  let redis;
  try {
    redis = redisFn(url);
    const settled = Promise.resolve(redis.get(dayKey())).then(
      (value) => ({ reserved: Number(value ?? 0) }),
      (err) => ({ unreachable: err?.message ?? String(err) }),
    );
    return await withTimeout(settled, timeoutMs, { unreachable: "timed out reaching the queue" });
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (redis) {
      try {
        redis.disconnect();
      } catch {
        // already closed
      }
    }
  }
}

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer?.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * List the most recent run records: parse every `*.json`, drop unparseable or mid-read-deleted entries
 * (the boot reaper may unlink between scan and read), sort by `endedAt` descending with nulls last, and
 * cap the count to 1..50. A missing logs dir is a normal empty history `[]`; any other readdir error is
 * `{ unreachable }`.
 */
export function listRuns({ logsDir, limit = 10, fs = nodeFs }) {
  const cap = clampLimit(limit);
  let names;
  try {
    names = fs.readdirSync(logsDir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    return { unreachable: `logs dir unreadable (${err?.code ?? "read-error"})` };
  }

  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readJsonFile(join(logsDir, name), fs);
    if (record && typeof record === "object") records.push(record);
  }
  records.sort(byEndedAtDesc);
  return records.slice(0, cap);
}

/** Read one run record by (raw) job id via its sanitized filename, or `null` when absent/unreadable. */
export function readRun({ logsDir, jobId, fs = nodeFs }) {
  return readJsonFile(join(logsDir, `${sanitizeJobId(jobId)}.json`), fs);
}

/**
 * Read the tail of a job's raw `.log`. Returns `{ lines }` or `{ missing: true }` when capture is off or
 * the file is absent -- an ENOENT is the normal "no captured log" case and never throws. The caller shows
 * these lines ONLY in the overlay viewer; they are never rendered into or sent to model context.
 */
export function readLogTail({ logsDir, jobId, lines = 200, fs = nodeFs }) {
  let text;
  try {
    text = fs.readFileSync(join(logsDir, `${sanitizeJobId(jobId)}.log`), "utf8");
  } catch {
    return { missing: true };
  }
  const all = text.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop(); // drop the trailing-newline empty segment
  const cap = clampLines(lines);
  return { lines: all.slice(Math.max(0, all.length - cap)) };
}

/** Read the settings overlay via the worker's own validator. Returns `{ path, overlay }` or `{ path, invalid }`. */
export function readSettingsView({ settingsFile, fs = nodeFs }) {
  const result = readOverlay(settingsFile, { fs });
  if (result.invalid) return { path: settingsFile, invalid: result.invalid };
  return { path: settingsFile, overlay: result.overlay };
}

/**
 * Read the receiver's committed label->flow allowlist for display. Unlike the receiver's fail-loud loader
 * (boot semantics), a viewer degrades: an absent file is `{ missing: true }`, malformed content is
 * `{ invalid }`, and only string flows survive into `{ mappings }`.
 */
export function readFlows({ flowsPath, fs = nodeFs }) {
  let text;
  try {
    text = fs.readFileSync(flowsPath, "utf8");
  } catch {
    return { missing: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { invalid: "flows file is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { invalid: "flows file must be a label -> flow object" };
  }
  const mappings = {};
  for (const [label, flow] of Object.entries(parsed)) {
    if (typeof flow === "string" && flow.trim() !== "") mappings[label] = flow;
  }
  return { mappings };
}

/** The sanitized ids present in the logs dir (from `*.json` filenames), for `logs <id>` autocomplete. */
export function listRunIds({ logsDir, fs = nodeFs }) {
  let names;
  try {
    names = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length));
}

function readJsonFile(path, fs) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    return null; // ENOENT (reaper raced us) or unreadable: skip, do not fail the whole listing
  }
  try {
    return JSON.parse(text);
  } catch {
    return null; // a partial write / non-JSON line: skip
  }
}

function byEndedAtDesc(a, b) {
  const ae = a?.endedAt ?? null;
  const be = b?.endedAt ?? null;
  if (ae === be) return 0;
  if (ae === null) return 1; // nulls last
  if (be === null) return -1;
  return ae < be ? 1 : -1; // ISO-8601 strings sort lexically; descending
}

function clampLimit(limit) {
  const n = Number.isFinite(limit) ? Math.floor(limit) : 10;
  return Math.min(50, Math.max(1, n));
}

function clampLines(lines) {
  const n = Number.isFinite(lines) ? Math.floor(lines) : 200;
  return Math.min(2000, Math.max(1, n));
}
