import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePauseWindows, loadPauseWindows, pauseUntilMs, scopeOf } from "../src/pause-windows.mjs";

const wrap = (windows) => JSON.stringify({ windows });
const parse = (windows) => parsePauseWindows(wrap(windows), "pw.json");
const ghJob = (repo) => ({ kind: "github", repo });
const localJob = (folder) => ({ kind: "local", folder });
const UTC = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

// ── validator ───────────────────────────────────────────────────────────────────────────────────────────

test("parsePauseWindows normalizes a full window and precomputes minutes", () => {
	const [w] = parse([{ scope: "acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam", days: ["Mon", "fri"], dateFrom: "2026-08-01", dateTo: "2026-08-31" }]);
	assert.equal(w.scope, "acme/web");
	assert.equal(w.fromMin, 22 * 60);
	assert.equal(w.toMin, 6 * 60);
	assert.equal(w.tz, "Europe/Amsterdam");
	assert.deepEqual(w.days, ["mon", "fri"]);
	assert.equal(w.dateFrom, "2026-08-01");
	assert.equal(w.dateTo, "2026-08-31");
});

test("parsePauseWindows defaults tz to UTC and drops optional fields when absent", () => {
	const [w] = parse([{ scope: "/srv/site", from: "09:00", to: "17:00" }]);
	assert.equal(w.tz, "UTC");
	assert.ok(!("days" in w) && !("dateFrom" in w) && !("dateTo" in w));
});

test("parsePauseWindows rejects malformed files fail-loud", () => {
	assert.throws(() => parsePauseWindows("{ not json", "pw.json"), /not valid JSON/);
	assert.throws(() => parsePauseWindows(JSON.stringify({}), "pw.json"), /must have a "windows" array/);
	assert.throws(() => parse(["nope"]), /must be an object/);
	assert.throws(() => parse([{ from: "09:00", to: "17:00" }]), /scope must be a non-empty string/);
	assert.throws(() => parse([{ scope: "x", from: "25:00", to: "06:00" }]), /from out of range/);
	assert.throws(() => parse([{ scope: "x", from: "9", to: "06:00" }]), /from must be "HH:MM"/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "09:00" }]), /from and to must differ/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "17:00", tz: "Mars/Phobos" }]), /not a valid IANA timezone/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "17:00", days: ["funday"] }]), /unknown weekday/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "17:00", days: [] }]), /non-empty array/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "17:00", dateFrom: "2026-13-01" }]), /dateFrom must be "YYYY-MM-DD"/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "17:00", dateFrom: "2026-08-31", dateTo: "2026-08-01" }]), /dateFrom must be <= dateTo/);
});

// ── loader ──────────────────────────────────────────────────────────────────────────────────────────────

test("loadPauseWindows returns [] when the file is unset (feature disabled)", () => {
	assert.deepEqual(loadPauseWindows({ pauseWindowsFile: null }), []);
});

test("loadPauseWindows throws when the configured file is missing, else parses it", () => {
	const cfg = { pauseWindowsFile: "/x/pw.json" };
	assert.throws(() => loadPauseWindows(cfg, { existsSync: () => false, readFileSync: () => "" }), /does not exist/);
	const windows = loadPauseWindows(cfg, { existsSync: () => true, readFileSync: () => wrap([{ scope: "a", from: "22:00", to: "06:00" }]) });
	assert.equal(windows.length, 1);
	assert.equal(windows[0].scope, "a");
});

// ── predicate: same-day window (UTC) ────────────────────────────────────────────────────────────────────

test("same-day UTC window: inside returns today's end, boundaries and outside return null", () => {
	const w = parse([{ scope: "acme/web", from: "09:00", to: "17:00" }]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 23, 12)), UTC(2026, 7, 23, 17), "inside -> ends 17:00 today");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 23, 8, 59)), null, "before from");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 23, 17)), null, "at to is already resumed (exclusive)");
});

// ── predicate: overnight window (UTC) ───────────────────────────────────────────────────────────────────

test("overnight UTC window: covers the evening and the following early morning to the same end", () => {
	const w = parse([{ scope: "acme/web", from: "22:00", to: "06:00" }]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 23, 23)), UTC(2026, 7, 24, 6), "23:00 -> ends 06:00 next day");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 3)), UTC(2026, 7, 24, 6), "03:00 (started prev night) -> ends 06:00 today");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 6)), null, "06:00 exclusive -> resumed");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 12)), null, "midday -> not paused");
});

// ── predicate: weekday + date gating ────────────────────────────────────────────────────────────────────

test("days gate the window's START day (2026-07-24 is a Friday)", () => {
	const w = parse([{ scope: "acme/web", from: "22:00", to: "06:00", days: ["fri"] }]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 23)), UTC(2026, 7, 25, 6), "Fri night -> paused into Sat morning");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 25, 3)), UTC(2026, 7, 25, 6), "Sat early morning still covered (started Fri)");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 25, 23)), null, "Sat night not a Friday start -> not paused");
});

test("dateFrom/dateTo bound which days the window applies", () => {
	const w = parse([{ scope: "acme/web", from: "09:00", to: "17:00", dateFrom: "2026-08-01", dateTo: "2026-08-31" }]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 8, 15, 12)), UTC(2026, 8, 15, 17), "in range -> paused");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 31, 12)), null, "before range");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 9, 1, 12)), null, "after range");
});

// ── predicate: scope matching ───────────────────────────────────────────────────────────────────────────

test("scope matches repo (github) or folder (local), and * matches all", () => {
	assert.equal(scopeOf(ghJob("acme/web")), "acme/web");
	assert.equal(scopeOf(localJob("/srv/site")), "/srv/site");
	const repoW = parse([{ scope: "acme/web", from: "00:00", to: "23:59" }]);
	assert.ok(pauseUntilMs(repoW, ghJob("acme/web"), UTC(2026, 7, 23, 12)) !== null, "repo scope matches its github job");
	assert.equal(pauseUntilMs(repoW, localJob("/srv/site"), UTC(2026, 7, 23, 12)), null, "repo scope does not match a local job");
	const anyW = parse([{ scope: "*", from: "00:00", to: "23:59" }]);
	assert.ok(pauseUntilMs(anyW, ghJob("acme/web"), UTC(2026, 7, 23, 12)) !== null, "* matches github");
	assert.ok(pauseUntilMs(anyW, localJob("/srv/site"), UTC(2026, 7, 23, 12)) !== null, "* matches local");
	assert.equal(pauseUntilMs(anyW, { kind: "local" }, UTC(2026, 7, 23, 12)), null, "a job with no scope is never paused");
});

// ── predicate: non-UTC timezone (DST-correct via Intl) ──────────────────────────────────────────────────

test("a non-UTC window resolves its end in that zone's wall clock", () => {
	// 2026-07-23 23:00 America/New_York (EDT, UTC-4) == 2026-07-24 03:00 UTC. Window 22:00-06:00 EDT ends at
	// 2026-07-24 06:00 EDT == 2026-07-24 10:00 UTC.
	const w = parse([{ scope: "acme/web", from: "22:00", to: "06:00", tz: "America/New_York" }]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 3)), UTC(2026, 7, 24, 10), "ends 06:00 New York == 10:00 UTC");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 12)), null, "08:00 EDT is past the window");
});

test("the latest end wins when two windows overlap; empty windows -> null", () => {
	const w = parse([
		{ scope: "acme/web", from: "22:00", to: "02:00" },
		{ scope: "acme/web", from: "22:00", to: "06:00" },
	]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 23, 23)), UTC(2026, 7, 24, 6), "held until the later end");
	assert.equal(pauseUntilMs([], ghJob("acme/web"), UTC(2026, 7, 23, 23)), null);
});
