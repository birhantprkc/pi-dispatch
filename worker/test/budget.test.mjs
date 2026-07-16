import assert from "node:assert/strict";
import { test } from "node:test";
import { dayKey, releaseBudget, reserveBudget } from "../src/budget.mjs";

/** Minimal ioredis-compatible fake: atomic enough for single-threaded test semantics. */
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

test("dayKey is a UTC YYYY-MM-DD key", () => {
	assert.equal(dayKey(new Date("2026-07-16T23:30:00Z")), "budget:2026-07-16");
	// A timestamp just before UTC midnight stays on its UTC day regardless of local tz.
	assert.equal(dayKey(new Date("2026-07-16T00:00:01Z")), "budget:2026-07-16");
});

test("reserves within the cap, refuses beyond it, and never lets a refusal spend", async () => {
	const redis = fakeRedis();
	const now = new Date("2026-07-16T10:00:00Z");
	const results = [];
	for (let i = 0; i < 5; i++) results.push(await reserveBudget(redis, { cap: 3, now }));

	assert.deepEqual(
		results.map((r) => r.allowed),
		[true, true, true, false, false],
	);
	assert.deepEqual(
		results.map((r) => r.reserved),
		[1, 2, 3, 4, 5],
	);
});

test("the TTL is set once, on first reservation only", async () => {
	const redis = fakeRedis();
	const now = new Date("2026-07-16T10:00:00Z");
	await reserveBudget(redis, { cap: 10, now });
	assert.ok(redis.ttl.has("budget:2026-07-16"), "TTL set on first reserve");
	redis.ttl.delete("budget:2026-07-16");
	await reserveBudget(redis, { cap: 10, now });
	assert.ok(!redis.ttl.has("budget:2026-07-16"), "TTL must NOT be reset on later reserves");
});

test("cap 0 fails closed -- every job refused, not 'unlimited'", async () => {
	const redis = fakeRedis();
	const r = await reserveBudget(redis, { cap: 0, now: new Date("2026-07-16T10:00:00Z") });
	assert.equal(r.allowed, false);
});

test("release gives a slot back (infra-fault path only)", async () => {
	const redis = fakeRedis();
	const now = new Date("2026-07-16T10:00:00Z");
	await reserveBudget(redis, { cap: 3, now });
	await reserveBudget(redis, { cap: 3, now });
	await releaseBudget(redis, { now });
	const r = await reserveBudget(redis, { cap: 3, now });
	assert.equal(r.reserved, 2, "a released slot is reusable");
	assert.equal(r.allowed, true);
});
