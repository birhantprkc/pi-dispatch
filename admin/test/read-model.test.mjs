import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey } from "@pi-dispatch/worker/budget";
import {
  resolvePaths,
  readQueueState,
  readSchedulers,
  readBudget,
  listRuns,
  readRun,
  readLogTail,
  readSettingsView,
  readFlows,
  listRunIds,
  setQueuePaused,
  writeSettings,
} from "../src/read-model.mjs";

/**
 * An in-memory fs keyed by basename. A file value that is `{ __throw, code }` throws on read (to model a
 * mid-read ENOENT); `readdirError` makes the directory scan itself throw.
 */
function fakeFs(files, { readdirError } = {}) {
  return {
    readdirSync() {
      if (readdirError) {
        const e = new Error(readdirError.message ?? "readdir failed");
        e.code = readdirError.code;
        throw e;
      }
      return Object.keys(files);
    },
    readFileSync(path) {
      const name = String(path).split(/[\\/]/).pop();
      if (!(name in files)) {
        const e = new Error(`ENOENT: ${name}`);
        e.code = "ENOENT";
        throw e;
      }
      const value = files[name];
      if (value && value.__throw) {
        const e = new Error(value.message ?? "read failed");
        e.code = value.code;
        throw e;
      }
      return value;
    },
  };
}

test("resolvePaths reads env with safe defaults and never calls loadConfig", () => {
  const p = resolvePaths({
    VALKEY_URL: "redis://h:1",
    PI_LOGS_DIR: "/l",
    PI_SETTINGS_FILE: "/s.json",
    RECEIVER_FLOWS_PATH: "/f.json",
    PI_CAPTURE_JOB_LOGS: "1",
  });
  assert.deepEqual(p, {
    valkeyUrl: "redis://h:1",
    logsDir: "/l",
    settingsFile: "/s.json",
    flowsPath: "/f.json",
    captureJobLogs: true,
  });
});

test("resolvePaths falls back to defaults on empty env (no worker config required)", () => {
  const p = resolvePaths({});
  assert.equal(p.valkeyUrl, "redis://127.0.0.1:6379");
  assert.equal(p.flowsPath, "deploy/receiver.flows.json");
  assert.equal(p.captureJobLogs, false);
  assert.ok(typeof p.logsDir === "string" && p.logsDir.length > 0);
  assert.ok(typeof p.settingsFile === "string" && p.settingsFile.length > 0);
});

test("listRuns parses records, sorts by endedAt desc with nulls last, skips non-json/unparseable", () => {
  const files = {
    "a.json": JSON.stringify({ jobId: "a", endedAt: "2026-07-20T10:00:00.000Z" }),
    "b.json": JSON.stringify({ jobId: "b", endedAt: "2026-07-21T10:00:00.000Z" }),
    "c.json": JSON.stringify({ jobId: "c", endedAt: null }),
    "d.json": "{ not valid json",
    "notes.txt": "ignored",
  };
  const runs = listRuns({ logsDir: "/logs", fs: fakeFs(files) });
  assert.deepEqual(
    runs.map((r) => r.jobId),
    ["b", "a", "c"],
  );
});

test("listRuns clamps the limit to 1..50", () => {
  const files = {};
  for (let i = 0; i < 60; i++) {
    files[`j${i}.json`] = JSON.stringify({ jobId: `j${i}`, endedAt: `2026-07-01T00:00:${String(i).padStart(2, "0")}.000Z` });
  }
  assert.equal(listRuns({ logsDir: "/logs", limit: 5, fs: fakeFs(files) }).length, 5);
  assert.equal(listRuns({ logsDir: "/logs", limit: 999, fs: fakeFs(files) }).length, 50);
  assert.equal(listRuns({ logsDir: "/logs", limit: 0, fs: fakeFs(files) }).length, 1);
});

test("listRuns returns [] when the logs dir does not exist", () => {
  assert.deepEqual(listRuns({ logsDir: "/nope", fs: fakeFs({}, { readdirError: { code: "ENOENT" } }) }), []);
});

test("listRuns skips a record deleted between scan and read (reaper race)", () => {
  const files = {
    "a.json": JSON.stringify({ jobId: "a", endedAt: "2026-07-20T00:00:00.000Z" }),
    "b.json": { __throw: true, code: "ENOENT", message: "gone" },
  };
  assert.deepEqual(
    listRuns({ logsDir: "/logs", fs: fakeFs(files) }).map((r) => r.jobId),
    ["a"],
  );
});

test("readRun resolves the sanitized filename for a colon-bearing id", () => {
  const files = { "repeat_x_123.json": JSON.stringify({ jobId: "repeat:x:123", outcome: "completed" }) };
  const rec = readRun({ logsDir: "/logs", jobId: "repeat:x:123", fs: fakeFs(files) });
  assert.equal(rec.outcome, "completed");
  assert.equal(rec.jobId, "repeat:x:123", "the body keeps the raw id");
});

test("readRun returns null when the record is absent", () => {
  assert.equal(readRun({ logsDir: "/logs", jobId: "nope", fs: fakeFs({}) }), null);
});

test("readLogTail returns { missing:true } when the .log is absent (capture off)", () => {
  assert.deepEqual(readLogTail({ logsDir: "/logs", jobId: "x", fs: fakeFs({}) }), { missing: true });
});

test("readLogTail returns the last N lines, dropping the trailing-newline segment", () => {
  const content = "l1\nl2\nl3\nl4\nl5\n";
  const rec = readLogTail({ logsDir: "/logs", jobId: "x", lines: 2, fs: fakeFs({ "x.log": content }) });
  assert.deepEqual(rec.lines, ["l4", "l5"]);
});

test("readBudget issues only a GET of the day key and never mutates", async () => {
  const commands = [];
  const redis = {
    async get(key) {
      commands.push(["get", key]);
      return "7";
    },
    disconnect() {
      commands.push(["disconnect"]);
    },
  };
  const res = await readBudget({ url: "redis://x", redisFn: () => redis });
  assert.deepEqual(res, { reserved: 7 });
  assert.deepEqual(
    commands.filter((c) => c[0] !== "disconnect").map((c) => c[0]),
    ["get"],
    "only GET -- never INCR/EXPIRE",
  );
  assert.equal(commands[0][1], dayKey(), "GET is keyed on the worker's own dayKey()");
});

test("readBudget returns { unreachable } when the client errors", async () => {
  const redis = {
    async get() {
      throw new Error("ECONNREFUSED");
    },
    disconnect() {},
  };
  const res = await readBudget({ url: "redis://x", redisFn: () => redis });
  assert.match(res.unreachable, /ECONNREFUSED/);
});

test("readQueueState reports paused state, counts, and worker count", async () => {
  const makeQueueFn = () => ({
    async isPaused() {
      return true;
    },
    async getJobCounts() {
      return { waiting: 2, active: 1, paused: 0, delayed: 0, failed: 3 };
    },
    async getWorkers() {
      return [{}, {}];
    },
    async close() {},
  });
  const res = await readQueueState({ url: "redis://x", makeQueueFn, parseConnectionFn: () => ({}) });
  assert.equal(res.pausedState, true);
  assert.equal(res.counts.failed, 3);
  assert.equal(res.workers, 2);
});

test("readQueueState degrades workers to 'unknown' when getWorkers is empty (no SETNAME)", async () => {
  const makeQueueFn = () => ({
    async isPaused() {
      return false;
    },
    async getJobCounts() {
      return {};
    },
    async getWorkers() {
      return [];
    },
    async close() {},
  });
  const res = await readQueueState({ url: "redis://x", makeQueueFn, parseConnectionFn: () => ({}) });
  assert.equal(res.workers, "unknown");
});

test("readQueueState returns { unreachable } and still closes when the queue is down", async () => {
  let closed = false;
  const makeQueueFn = () => ({
    async isPaused() {
      throw new Error("connection down");
    },
    async close() {
      closed = true;
    },
  });
  const res = await readQueueState({ url: "redis://x", makeQueueFn, parseConnectionFn: () => ({}) });
  assert.match(res.unreachable, /connection down/);
  assert.equal(closed, true);
});

test("readSchedulers computes overdueMs for a next in the past", async () => {
  const now = 1_000_000;
  const makeQueueFn = () => ({
    async getJobSchedulers() {
      return [
        { key: "s1", name: "local", pattern: "* * * * *", next: now - 5000 },
        { key: "s2", name: "local", every: 60000, next: now + 5000 },
        { key: "s3", name: "local" },
      ];
    },
    async close() {},
  });
  const res = await readSchedulers({ url: "redis://x", makeQueueFn, parseConnectionFn: () => ({}), now: () => now });
  assert.equal(res[0].overdueMs, 5000);
  assert.equal(res[1].overdueMs, null, "a future next is not overdue");
  assert.equal(res[2].next, null);
  assert.equal(res[2].overdueMs, null);
});

test("readSchedulers returns { unreachable } on a connection error", async () => {
  const makeQueueFn = () => ({
    async getJobSchedulers() {
      throw new Error("down");
    },
    async close() {},
  });
  const res = await readSchedulers({ url: "redis://x", makeQueueFn, parseConnectionFn: () => ({}) });
  assert.match(res.unreachable, /down/);
});

test("readFlows returns the label->flow mappings", () => {
  const files = { "receiver.flows.json": JSON.stringify({ "pi:frontend": "frontend-fix", "pi:backend": "backend-fix" }) };
  const res = readFlows({ flowsPath: "/x/receiver.flows.json", fs: fakeFs(files) });
  assert.deepEqual(res.mappings, { "pi:frontend": "frontend-fix", "pi:backend": "backend-fix" });
});

test("readFlows returns { missing:true } when the file is absent (viewer degrades)", () => {
  assert.deepEqual(readFlows({ flowsPath: "/x/none.json", fs: fakeFs({}) }), { missing: true });
});

test("readSettingsView returns the validated overlay via the worker's own reader", () => {
  const files = { "settings.json": JSON.stringify({ model: "m", dailyCap: 5 }) };
  const res = readSettingsView({ settingsFile: "/x/settings.json", fs: fakeFs(files) });
  assert.equal(res.path, "/x/settings.json");
  assert.deepEqual(res.overlay, { model: "m", dailyCap: 5 });
});

test("readSettingsView surfaces an invalid overlay without throwing (fail closed)", () => {
  const files = { "settings.json": JSON.stringify({ dailyCap: 0 }) };
  const res = readSettingsView({ settingsFile: "/x/settings.json", fs: fakeFs(files) });
  assert.ok(res.invalid, "an out-of-bounds key makes the whole overlay invalid");
});

test("listRunIds returns the sanitized ids from json filenames only", () => {
  const files = { "repeat_x_123.json": "{}", "local-abc.json": "{}", "x.log": "raw", "n.txt": "" };
  assert.deepEqual(listRunIds({ logsDir: "/logs", fs: fakeFs(files) }).sort(), ["local-abc", "repeat_x_123"]);
});

// ---- setQueuePaused ----

test("setQueuePaused pauses through one queue and closes it in finally", async () => {
  const calls = [];
  let closed = false;
  const makeQueueFn = () => ({
    async pause() {
      calls.push("pause");
    },
    async resume() {
      calls.push("resume");
    },
    async close() {
      closed = true;
    },
  });
  const res = await setQueuePaused({ url: "redis://x", paused: true, makeQueueFn, parseConnectionFn: () => ({}) });
  assert.deepEqual(res, { ok: true, paused: true });
  assert.deepEqual(calls, ["pause"], "pause, never resume");
  assert.equal(closed, true, "closed in finally");
});

test("setQueuePaused resumes when paused is false", async () => {
  const calls = [];
  const makeQueueFn = () => ({
    async pause() {
      calls.push("pause");
    },
    async resume() {
      calls.push("resume");
    },
    async close() {},
  });
  const res = await setQueuePaused({ url: "redis://x", paused: false, makeQueueFn, parseConnectionFn: () => ({}) });
  assert.deepEqual(res, { ok: true, paused: false });
  assert.deepEqual(calls, ["resume"]);
});

test("setQueuePaused returns { unreachable } and still closes when the queue is down", async () => {
  let closed = false;
  const makeQueueFn = () => ({
    async pause() {
      throw new Error("connection down");
    },
    async close() {
      closed = true;
    },
  });
  const res = await setQueuePaused({ url: "redis://x", paused: true, makeQueueFn, parseConnectionFn: () => ({}) });
  assert.match(res.unreachable, /connection down/);
  assert.equal(closed, true, "closed in finally even on error");
});

// ---- writeSettings ----

/** An in-memory fs keyed by full path, supporting the read-modify-write path (read, mkdir, write tmp, rename). */
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFileSync(path) {
      const p = String(path);
      if (!files.has(p)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = "ENOENT";
        throw e;
      }
      return files.get(p);
    },
    mkdirSync() {},
    writeFileSync(path, data) {
      files.set(String(path), data);
    },
    renameSync(from, to) {
      const f = String(from);
      if (!files.has(f)) {
        const e = new Error(`ENOENT: ${f}`);
        e.code = "ENOENT";
        throw e;
      }
      files.set(String(to), files.get(f));
      files.delete(f);
    },
  };
}

test("writeSettings merges into the existing overlay, preserving prior keys", () => {
  const path = "/s/settings.json";
  const fs = memFs({ [path]: JSON.stringify({ model: "m1", dailyCap: 5 }) });
  const res = writeSettings({ settingsFile: path, mutate: (o) => ({ ...o, maxTurns: 12 }), fs });
  assert.deepEqual(res, { ok: true, overlay: { model: "m1", dailyCap: 5, maxTurns: 12 } });
  assert.deepEqual(JSON.parse(fs.files.get(path)), { model: "m1", dailyCap: 5, maxTurns: 12 });
});

test("writeSettings rebuilds from scratch over an invalid file, keeping only the new key and reporting rebuiltFrom", () => {
  const path = "/s/settings.json";
  const fs = memFs({ [path]: "{ not valid json" });
  const res = writeSettings({ settingsFile: path, mutate: (o) => ({ ...o, dailyCap: 7 }), fs });
  assert.equal(res.ok, true);
  assert.ok(res.rebuiltFrom, "carries the read reason so the caller can warn loudly");
  assert.deepEqual(res.overlay, { dailyCap: 7 }, "base was empty; only the new key persists");
  assert.deepEqual(JSON.parse(fs.files.get(path)), { dailyCap: 7 });
});

test("writeSettings passes through writeOverlay's { invalid } and leaves the file untouched", () => {
  const path = "/s/settings.json";
  const fs = memFs({ [path]: JSON.stringify({ model: "m1" }) });
  const res = writeSettings({ settingsFile: path, mutate: (o) => ({ ...o, dailyCap: 0 }), fs });
  assert.ok(res.invalid);
  assert.ok(res.invalid.includes("dailyCap"));
  assert.deepEqual(JSON.parse(fs.files.get(path)), { model: "m1" }, "original overlay untouched (validate-before-write)");
});
