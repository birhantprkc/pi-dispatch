import assert from "node:assert/strict";
import { test } from "node:test";
import { dayKey, weekKey, monthKey, windowState, releaseBudget, reserveBudget } from "../src/budget.mjs";

/** Minimal ioredis-compatible fake, keyed by the redis key so the three windows count independently. */
function fakeRedis() {
	const store = new Map();
	const ttl = new Map();
	return {
		store,
		ttl,
		async incr(k) {
			const v = (store.get(k) ?? 0) + 1;
			store.set(k, v);
			return v;
		},
		async decr(k) {
			const v = (store.get(k) ?? 0) - 1;
			store.set(k, v);
			return v;
		},
		async expire(k, s) {
			ttl.set(k, s);
		},
	};
}

const NOW = new Date("2026-07-16T10:00:00Z");
const DAY = "budget:2026-07-16";
const WEEK = "budget:w:2026-07-13"; // the Monday of NOW's week
const MONTH = "budget:m:2026-07";

// ---- keys ----

test("dayKey / weekKey / monthKey are distinct UTC sub-namespaces", () => {
	assert.equal(dayKey(NOW), DAY);
	assert.equal(weekKey(NOW), WEEK);
	assert.equal(monthKey(NOW), MONTH);
	// A timestamp just before UTC midnight stays on its UTC day/week/month regardless of local tz.
	assert.equal(dayKey(new Date("2026-07-16T00:00:01Z")), DAY);
});

test("weekKey buckets a whole Mon-Sun week to one Monday key, and rolls at the boundary", () => {
	assert.equal(weekKey(new Date("2026-07-13T00:00:00Z")), WEEK, "Monday");
	assert.equal(weekKey(new Date("2026-07-19T23:59:59Z")), WEEK, "the following Sunday is the same week");
	assert.equal(weekKey(new Date("2026-07-20T00:00:00Z")), "budget:w:2026-07-20", "the next Monday is a new bucket");
	// Year boundary: 2027-01-01 is a Friday, still in the week that started 2026-12-28.
	assert.equal(weekKey(new Date("2027-01-01T00:00:00Z")), "budget:w:2026-12-28");
});

// ---- windowState (the shared classifier) ----

test("windowState: ok below the band, soft-hold inside it, over beyond the cap", () => {
	// cap 10, pct 80 -> threshold floor(8) = 8. reserved <=8 ok; 9,10 soft-hold; 11+ over.
	assert.equal(windowState(8, 10, 80), "ok");
	assert.equal(windowState(9, 10, 80), "soft-hold");
	assert.equal(windowState(10, 10, 80), "soft-hold");
	assert.equal(windowState(11, 10, 80), "over");
	// pct null disables the band: everything up to the cap is ok, only over the cap is "over".
	assert.equal(windowState(10, 10, null), "ok");
	assert.equal(windowState(11, 10, null), "over");
	// cap <= 0 fails closed: any reservation is over.
	assert.equal(windowState(1, 0, null), "over");
});

// ---- single (day) window: the original behaviour, preserved ----

test("day-only: reserves within the cap, refuses beyond it, and a refusal never gives back", async () => {
	const redis = fakeRedis();
	const results = [];
	for (let i = 0; i < 5; i++) results.push(await reserveBudget(redis, { caps: { day: 3 }, now: NOW }));

	assert.deepEqual(
		results.map((r) => r.allowed),
		[true, true, true, false, false],
	);
	assert.deepEqual(
		results.map((r) => r.windows.day.reserved),
		[1, 2, 3, 4, 5],
	);
	assert.deepEqual(
		results.map((r) => r.reason),
		["ok", "ok", "ok", "over-budget", "over-budget"],
	);
	assert.equal(results[3].blockedWindow, "day");
});

test("day-only: the TTL is set once, on first reservation only", async () => {
	const redis = fakeRedis();
	await reserveBudget(redis, { caps: { day: 10 }, now: NOW });
	assert.ok(redis.ttl.has(DAY), "TTL set on first reserve");
	redis.ttl.delete(DAY);
	await reserveBudget(redis, { caps: { day: 10 }, now: NOW });
	assert.ok(!redis.ttl.has(DAY), "TTL must NOT be reset on later reserves");
});

test("day cap 0 fails closed -- every job refused, not 'unlimited'", async () => {
	const redis = fakeRedis();
	const r = await reserveBudget(redis, { caps: { day: 0 }, now: NOW });
	assert.equal(r.allowed, false);
	assert.equal(r.reason, "over-budget");
});

// ---- multi-window ----

test("multi-window: day/week/month count on independent keys", async () => {
	const redis = fakeRedis();
	const r = await reserveBudget(redis, { caps: { day: 10, week: 20, month: 30 }, now: NOW });
	assert.deepEqual(
		[r.windows.day.reserved, r.windows.week.reserved, r.windows.month.reserved],
		[1, 1, 1],
	);
	assert.equal(redis.store.get(DAY), 1);
	assert.equal(redis.store.get(WEEK), 1);
	assert.equal(redis.store.get(MONTH), 1);
	assert.ok(redis.ttl.get(WEEK) > redis.ttl.get(DAY), "the week TTL outlives the day TTL");
	assert.ok(redis.ttl.get(MONTH) > redis.ttl.get(WEEK), "the month TTL outlives the week TTL");
});

test("multi-window: ANY window over its cap refuses, and blockedWindow names it (day > week > month)", async () => {
	const redis = fakeRedis();
	redis.store.set(WEEK, 5); // the week window is already at its cap
	const r = await reserveBudget(redis, { caps: { day: 100, week: 5, month: 100 }, now: NOW });
	assert.equal(r.allowed, false);
	assert.equal(r.reason, "over-budget");
	assert.equal(r.blockedWindow, "week", "the week ceiling is the one that blocked");
	assert.equal(r.windows.day.state, "ok", "the day window is still fine");
});

test("a disabled window (null cap) is neither counted nor evaluated", async () => {
	const redis = fakeRedis();
	const r = await reserveBudget(redis, { caps: { day: 10, week: null, month: null }, now: NOW });
	assert.equal(r.allowed, true);
	assert.equal(r.windows.week, null);
	assert.equal(r.windows.month, null);
	assert.ok(!redis.store.has(WEEK), "a disabled week window creates no key");
	assert.ok(!redis.store.has(MONTH), "a disabled month window creates no key");
});

// ---- soft-hold band ----

test("soft-hold: a reservation inside the band refuses with a distinct reason, still counting", async () => {
	const redis = fakeRedis();
	redis.store.set(DAY, 8); // next reservation lands at 9, inside the 80% band of cap 10 (threshold 8)
	const r = await reserveBudget(redis, { caps: { day: 10 }, softHoldPct: 80, now: NOW });
	assert.equal(r.allowed, false);
	assert.equal(r.reason, "soft-hold");
	assert.equal(r.blockedWindow, "day");
	assert.equal(r.windows.day.reserved, 9);
	assert.equal(r.windows.day.state, "soft-hold");
});

test("soft-hold: below the band the run is allowed", async () => {
	const redis = fakeRedis();
	redis.store.set(DAY, 6); // -> 7, below the threshold of 8
	const r = await reserveBudget(redis, { caps: { day: 10 }, softHoldPct: 80, now: NOW });
	assert.equal(r.allowed, true);
	assert.equal(r.reason, "ok");
});

test("soft-hold: over-budget outranks soft-hold, and day outranks week", async () => {
	const redis = fakeRedis();
	redis.store.set(DAY, 10); // -> 11, OVER the day cap of 10
	redis.store.set(WEEK, 8); // -> 9, inside the week's soft-hold band
	const r = await reserveBudget(redis, { caps: { day: 10, week: 10 }, softHoldPct: 80, now: NOW });
	assert.equal(r.reason, "over-budget", "a hard over beats a soft-hold");
	assert.equal(r.blockedWindow, "day");
	assert.equal(r.windows.week.state, "soft-hold", "the week is still surfaced as soft-hold in its window");
});

// ---- release ----

test("release gives a slot back in every active window (infra never-started path)", async () => {
	const redis = fakeRedis();
	await reserveBudget(redis, { caps: { day: 3, week: 3, month: 3 }, now: NOW });
	await reserveBudget(redis, { caps: { day: 3, week: 3, month: 3 }, now: NOW });
	await releaseBudget(redis, { caps: { day: 3, week: 3, month: 3 }, now: NOW });
	assert.equal(redis.store.get(DAY), 1);
	assert.equal(redis.store.get(WEEK), 1);
	assert.equal(redis.store.get(MONTH), 1);
	const r = await reserveBudget(redis, { caps: { day: 3, week: 3, month: 3 }, now: NOW });
	assert.equal(r.windows.day.reserved, 2, "a released slot is reusable");
	assert.equal(r.allowed, true);
});

test("release only decrements active windows -- a disabled window is untouched", async () => {
	const redis = fakeRedis();
	redis.store.set(DAY, 5);
	await releaseBudget(redis, { caps: { day: 3, week: null, month: null }, now: NOW });
	assert.equal(redis.store.get(DAY), 4);
	assert.ok(!redis.store.has(WEEK), "a disabled window is never decremented into existence");
});
