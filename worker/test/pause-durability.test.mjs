import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConnection } from "../src/connection.mjs";

// Durability of the pause switch against a real Valkey (REQ-QUEUE-BURST-NO-DROP). Gated on
// VALKEY_TEST_URL; CI provides a service, and it skips cleanly otherwise. Each test uses a
// throwaway queue name so a run never disturbs a live "pi-jobs" queue -- the durability SEMANTICS
// are what we exercise here; the real CLI's fixed "pi-jobs" name is covered by cli-control.test.mjs.
const url = process.env.VALKEY_TEST_URL;
const skip = url ? false : "needs VALKEY_TEST_URL";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `pred` (may be async) until truthy or `timeout` ms elapse. Returns the last predicate value. */
async function waitFor(pred, { timeout, interval = 100 }) {
	const start = Date.now();
	let last = await pred();
	while (!last && Date.now() - start < timeout) {
		await sleep(interval);
		last = await pred();
	}
	return last;
}

function throwawayName() {
	return `pi-jobs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test("enqueue while paused: jobs pile up pending, none active, each add resolves with an id", { skip }, async () => {
	const { Queue } = await import("bullmq");
	const connection = parseConnection(url); // maxRetriesPerRequest: null -- bullmq requirement
	const queue = new Queue(throwawayName(), { connection });
	try {
		await queue.pause();
		const added = await Promise.all([queue.add("t", { n: 1 }), queue.add("t", { n: 2 }), queue.add("t", { n: 3 })]);
		for (const job of added) assert.ok(job.id, "every enqueue while paused still resolves with a job id");

		// BullMQ v5 parks jobs enqueued while paused in the `paused` list, not `wait`
		// (getTargetQueueList.lua). The durability invariant is: all 3 pending, NONE active. Assert the
		// sum so it holds regardless of which internal list BullMQ uses, plus the exact placement.
		const counts = await queue.getJobCounts("waiting", "active", "paused");
		assert.equal(counts.active, 0, "nothing runs while paused");
		assert.equal(counts.waiting + counts.paused, 3, "all 3 enqueued-while-paused jobs are pending");
		assert.equal(counts.paused, 3, "bullmq 5.80.4 parks enqueued-while-paused jobs in the paused list");
	} finally {
		await queue.resume().catch(() => {});
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.close().catch(() => {});
	}
});

test("resume drains: a worker processes the parked jobs once resumed", { skip }, async () => {
	const { Queue, Worker } = await import("bullmq");
	const connection = parseConnection(url);
	const name = throwawayName();
	const queue = new Queue(name, { connection });
	let processed = 0;
	const worker = new Worker(name, async () => { processed += 1; }, { connection });
	try {
		await queue.pause();
		await Promise.all([queue.add("t", { n: 1 }), queue.add("t", { n: 2 }), queue.add("t", { n: 3 })]);
		assert.equal(processed, 0, "nothing drains while paused");

		await queue.resume();
		const drained = await waitFor(async () => processed === 3, { timeout: 10000 });
		assert.ok(drained, `resume must drain all 3 jobs within 10s (processed ${processed})`);
		const counts = await queue.getJobCounts("waiting", "active", "paused");
		assert.equal(counts.waiting + counts.paused + counts.active, 0, "queue is empty once drained");
	} finally {
		await worker.close().catch(() => {});
		await queue.resume().catch(() => {});
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.close().catch(() => {});
	}
});

test("pause survives worker restart: a fresh worker on a paused queue still does not drain", { skip }, async () => {
	const { Queue, Worker } = await import("bullmq");
	const connection = parseConnection(url);
	const name = throwawayName();
	const queue = new Queue(name, { connection });
	let processed = 0;
	const processor = async () => { processed += 1; };
	let w1;
	let w2;
	try {
		await queue.pause();
		await queue.add("t", { n: 1 });

		// The pause marker lives in Redis (meta.paused), not in any worker -- so a worker that starts
		// AFTER the pause reads it and refuses to drain. This is the durable kill-switch guarantee.
		w1 = new Worker(name, processor, { connection });
		await sleep(2000);
		assert.equal(processed, 0, "W1 must not drain a paused queue");
		await w1.close();

		w2 = new Worker(name, processor, { connection });
		await sleep(2000);
		assert.equal(processed, 0, "a brand-new W2 must still not drain -- pause is durable across restart");

		const counts = await queue.getJobCounts("waiting", "active", "paused");
		assert.equal(counts.active, 0, "the job never went active");
		assert.equal(counts.waiting + counts.paused, 1, "the job still sits pending across both workers");
	} finally {
		await w1?.close().catch(() => {});
		await w2?.close().catch(() => {});
		await queue.resume().catch(() => {});
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.close().catch(() => {});
	}
});
