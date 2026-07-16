import assert from "node:assert/strict";
import { test } from "node:test";
import { localJobId } from "../src/job-id.mjs";

// localJobId is pure -- runs everywhere. It is the dedup key for local jobs (REQ-DEDUP equivalent).

test("same folder/flow/task/minute -> same jobId (a double-invoke dedups)", () => {
	const a = localJobId({ folder: "/proj", flow: "tidy", task: "dedupe", minute: "2026-07-16T12:00" });
	const b = localJobId({ folder: "/proj", flow: "tidy", task: "dedupe", minute: "2026-07-16T12:00" });
	assert.equal(a, b);
	assert.match(a, /^local-[0-9a-f]{16}$/);
});

test("any field changing changes the id -- a genuinely different run is not swallowed", () => {
	const base = { folder: "/proj", flow: "tidy", task: "dedupe", minute: "2026-07-16T12:00" };
	const id = localJobId(base);
	assert.notEqual(id, localJobId({ ...base, task: "other" }));
	assert.notEqual(id, localJobId({ ...base, folder: "/other" }));
	assert.notEqual(id, localJobId({ ...base, flow: "bug-fix" }));
	assert.notEqual(id, localJobId({ ...base, minute: "2026-07-16T12:01" }), "a minute later is a new run");
});

test("field separation is unambiguous -- concatenation collisions cannot occur", () => {
	// Without a delimiter, {folder:'a', task:'bc'} and {folder:'ab', task:'c'} would collide.
	const x = localJobId({ folder: "a", flow: "", task: "bc", minute: "m" });
	const y = localJobId({ folder: "ab", flow: "", task: "c", minute: "m" });
	assert.notEqual(x, y);
});

// Integration against a real Valkey. Runs when VALKEY_TEST_URL is set (CI provides a service).
const url = process.env.VALKEY_TEST_URL;
const skip = url ? false : "VALKEY_TEST_URL not set; the queue integration test needs a Valkey";

test("enqueue + dedup against a real Valkey", { skip }, async () => {
	const { parseConnection } = await import("../src/connection.mjs");
	const { makeQueue, enqueueLocalJob } = await import("../src/queue.mjs");
	const q = makeQueue(parseConnection(url));
	try {
		await q.obliterate({ force: true }).catch(() => {});
		const now = new Date("2026-07-16T12:00:00Z");
		const args = { folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 5, now };
		const id1 = await enqueueLocalJob(q, args);
		const id2 = await enqueueLocalJob(q, args); // same -> dedup
		assert.equal(id1, id2);
		const counts = await q.getJobCounts("waiting");
		assert.equal(counts.waiting, 1, "the duplicate must be ignored");
		const job = await q.getJob(id1);
		assert.equal(job.data.kind, "local");
		assert.equal(job.data.folder, "/proj");
	} finally {
		await q.close();
	}
});
