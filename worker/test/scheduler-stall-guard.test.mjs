import assert from "node:assert/strict";
import { test } from "node:test";
import { makeStallGuard } from "../src/scheduler-stall-guard.mjs";

const STALL_KEY = "pi-dispatch:sched-stalls";
const WINDOW_SECONDS = 24 * 60 * 60;

/** Minimal ioredis-compatible fake: a hash store plus per-method call counters. */
function fakeRedis() {
	const hashes = new Map(); // key -> Map(field -> number)
	const calls = { hincrby: 0, expire: 0, hdel: 0 };
	const expires = []; // { key, seconds } per expire call
	return {
		hashes,
		calls,
		expires,
		field(key, f) {
			return hashes.get(key)?.get(f);
		},
		async hincrby(key, field, n) {
			calls.hincrby++;
			let h = hashes.get(key);
			if (!h) {
				h = new Map();
				hashes.set(key, h);
			}
			const v = (h.get(field) ?? 0) + n;
			h.set(field, v);
			return v;
		},
		async expire(key, seconds) {
			calls.expire++;
			expires.push({ key, seconds });
		},
		async hdel(key, field) {
			calls.hdel++;
			hashes.get(key)?.delete(field);
		},
	};
}

/** removeJobScheduler spy; records ids, optionally rejects as if the scheduler were already gone. */
function makeRemoveSpy({ throwNotFound = false } = {}) {
	const removed = [];
	const fn = async (id) => {
		removed.push(id);
		if (throwNotFound) throw new Error(`Job scheduler ${id} not found`);
	};
	fn.removed = removed;
	return fn;
}

/** log spy: keeps every (event, fields) call and offers a per-event filter. */
function makeLog() {
	const entries = [];
	const fn = (event, fields) => entries.push({ event, fields });
	fn.entries = entries;
	fn.of = (event) => entries.filter((e) => e.event === event);
	return fn;
}

test("ordinary (non-repeat) jobId is a no-op -- no hincrby, no teardown", async () => {
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy();
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler, log });

	await onStalled("local-abc");

	assert.equal(redis.calls.hincrby, 0);
	assert.equal(redis.calls.expire, 0);
	assert.deepEqual(removeJobScheduler.removed, []);
	assert.equal(log.entries.length, 0);
});

test("repeat:<id>:<millis> increments the counter under the scheduler-id hash field", async () => {
	const redis = fakeRedis();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler: makeRemoveSpy(), log: makeLog() });

	await onStalled("repeat:nightly-tidy:1699999999999");

	assert.equal(redis.calls.hincrby, 1);
	assert.equal(redis.field(STALL_KEY, "nightly-tidy"), 1);
});

test("N stalls at or below threshold do not tear down", async () => {
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy();
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler, log });

	for (let i = 0; i < 3; i++) await onStalled("repeat:nightly-tidy:1699999999999");

	assert.equal(redis.field(STALL_KEY, "nightly-tidy"), 3);
	assert.deepEqual(removeJobScheduler.removed, []);
	assert.equal(redis.calls.hdel, 0);
	assert.equal(log.of("scheduler_torn_down").length, 0);
});

test("the stall that crosses threshold (count === threshold+1) tears down exactly once", async () => {
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy();
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler, log });

	for (let i = 0; i < 4; i++) await onStalled("repeat:nightly-tidy:1699999999999");

	assert.deepEqual(removeJobScheduler.removed, ["nightly-tidy"]);
	assert.equal(redis.calls.hdel, 1);
	const torn = log.of("scheduler_torn_down");
	assert.equal(torn.length, 1);
	assert.deepEqual(torn[0].fields, { schedulerId: "nightly-tidy", stalls: 4 });
});

test("expire is set on every hincrby, with the rolling-window TTL", async () => {
	const redis = fakeRedis();
	const onStalled = makeStallGuard({ redis, threshold: 10, removeJobScheduler: makeRemoveSpy(), log: makeLog() });

	for (let i = 0; i < 3; i++) await onStalled("repeat:nightly-tidy:1699999999999");

	assert.equal(redis.calls.expire, redis.calls.hincrby);
	assert.equal(redis.calls.expire, 3);
	for (const e of redis.expires) {
		assert.equal(e.key, STALL_KEY);
		assert.equal(e.seconds, WINDOW_SECONDS);
	}
});

test("a removeJobScheduler not-found rejection is swallowed; teardown still completes", async () => {
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy({ throwNotFound: true });
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler, log });

	// resolves despite removeJobScheduler throwing
	for (let i = 0; i < 4; i++) await onStalled("repeat:nightly-tidy:1699999999999");

	assert.deepEqual(removeJobScheduler.removed, ["nightly-tidy"]);
	assert.equal(redis.calls.hdel, 1, "hdel runs even though remove threw");
	assert.equal(log.of("scheduler_torn_down").length, 1, "torn_down logged even though remove threw");
	assert.equal(log.of("scheduler_teardown_remove_failed").length, 1);
});

test("empty schedulerId (repeat::123) is logged and never hincrby'd", async () => {
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy();
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler, log });

	await onStalled("repeat::123");

	assert.equal(redis.calls.hincrby, 0);
	assert.deepEqual(removeJobScheduler.removed, []);
	assert.equal(log.of("scheduler_stall_unparsed").length, 1);
});

test("degenerate repeat:<n> (single colon) is also treated as empty schedulerId", async () => {
	const redis = fakeRedis();
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler: makeRemoveSpy(), log });

	await onStalled("repeat:123");

	assert.equal(redis.calls.hincrby, 0);
	assert.equal(log.of("scheduler_stall_unparsed").length, 1);
});

test("a redis.hincrby that throws does not reject onStalled -- error is swallowed and logged", async () => {
	const redis = {
		async hincrby() {
			throw new Error("redis down");
		},
		async expire() {},
		async hdel() {},
	};
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler: makeRemoveSpy(), log });

	await assert.doesNotReject(onStalled("repeat:nightly-tidy:1699999999999"));
	assert.equal(log.of("scheduler_stall_guard_error").length, 1);
});

test("a schedulerId with valid internal chars parses correctly", async () => {
	const redis = fakeRedis();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler: makeRemoveSpy(), log: makeLog() });

	await onStalled("repeat:my.flow-1:123");

	assert.equal(redis.field(STALL_KEY, "my.flow-1"), 1);
});
