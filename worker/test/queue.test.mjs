import assert from "node:assert/strict";
import { test } from "node:test";
import { chainedJobId, deliveryJobId, localJobId } from "../src/job-id.mjs";

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

// deliveryJobId is pure -- runs everywhere. It is the exact-per-delivery dedup key for GitHub jobs
// (REQ-DEDUP-BY-DELIVERY-GUID): the X-GitHub-Delivery GUID, prefixed.

test("deliveryJobId prefixes the GUID -- a redelivery resolves to the same id", () => {
	assert.equal(deliveryJobId("abc"), "gh-abc");
});

test("deliveryJobId throws on a missing/empty GUID -- no random fallback that would defeat dedup", () => {
	assert.throws(() => deliveryJobId(""));
	assert.throws(() => deliveryJobId(undefined));
	assert.throws(() => deliveryJobId(null));
});

// chainedJobId is pure -- runs everywhere. It is the retry-idempotent dedup key for chained (outbox)
// child jobs (INT-OUTBOX-CONTRACT): parent id + content-hash(flow, task), with NO time component.

test("chainedJobId is deterministic and carries no time component -- a retry re-enqueues the same id", () => {
	const args = { parentJobId: "parent-1", flow: "tidy", task: "dedupe" };
	const a = chainedJobId(args);
	const b = chainedJobId(args); // a later collection (retry) of the same parent+request
	assert.equal(a, b, "same parent+flow+task -> same id regardless of when it is computed");
	assert.match(a, /^chain-[0-9a-f]{16}$/);
});

test("chainedJobId binds the parent -- two parents requesting the same flow+task do not collide", () => {
	const base = { flow: "tidy", task: "dedupe" };
	assert.notEqual(chainedJobId({ ...base, parentJobId: "parent-1" }), chainedJobId({ ...base, parentJobId: "parent-2" }));
});

test("chainedJobId changes when flow or task changes -- a genuinely different request is not swallowed", () => {
	const base = { parentJobId: "parent-1", flow: "tidy", task: "dedupe" };
	const id = chainedJobId(base);
	assert.notEqual(id, chainedJobId({ ...base, flow: "bug-fix" }));
	assert.notEqual(id, chainedJobId({ ...base, task: "other" }));
});

test("chainedJobId field separation is unambiguous -- concatenation collisions cannot occur", () => {
	// NUL-delimited so {parentJobId:'a', flow:'bc'} and {parentJobId:'ab', flow:'c'} cannot collide.
	const x = chainedJobId({ parentJobId: "a", flow: "bc", task: "" });
	const y = chainedJobId({ parentJobId: "ab", flow: "c", task: "" });
	assert.notEqual(x, y);
});

// enqueueLocalJob's chain passthrough, verified without a live Valkey: a fake queue captures the
// (name, data, opts) it hands to queue.add. A non-chained job must stay byte-identical to the base shape.
const NON_CHAINED_KEYS = ["kind", "folder", "flow", "task", "provider", "model", "maxTurns"];

test("enqueueLocalJob keeps a non-chained job byte-identical -- no chainDepth/parentJobId keys", async () => {
	const { enqueueLocalJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };

	const now = new Date("2026-07-16T12:00:00Z");
	const jobId = await enqueueLocalJob(fakeQueue, { folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 5, now });

	assert.deepEqual(Object.keys(captured.data), NON_CHAINED_KEYS);
	assert.equal(jobId, localJobId({ folder: "/proj", flow: "tidy", task: "t", minute: "2026-07-16T12:00" }));
	assert.equal(captured.opts.jobId, jobId);
});

test("enqueueLocalJob puts chainDepth/parentJobId on data only when supplied", async () => {
	const { enqueueLocalJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };

	await enqueueLocalJob(fakeQueue, { folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 5, chainDepth: 1, parentJobId: "parent-1", now: new Date("2026-07-16T12:00:00Z") });

	assert.equal(captured.data.chainDepth, 1);
	assert.equal(captured.data.parentJobId, "parent-1");
});

test("enqueueLocalJob uses an explicit jobId override instead of the computed localJobId", async () => {
	const { enqueueLocalJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };

	const override = chainedJobId({ parentJobId: "parent-1", flow: "tidy", task: "t" });
	const jobId = await enqueueLocalJob(fakeQueue, { folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 5, jobId: override, now: new Date("2026-07-16T12:00:00Z") });

	assert.equal(jobId, override);
	assert.equal(captured.opts.jobId, override);
	assert.notEqual(captured.opts.jobId, localJobId({ folder: "/proj", flow: "tidy", task: "t", minute: "2026-07-16T12:00" }));
});

// The enqueue contract, verified without a live Valkey: a fake queue captures the (name, data, opts)
// that enqueueGitHubJob hands to queue.add. This asserts the money-path invariants -- exact-per-GUID
// jobId, the additive semantic dedup window, 31d retention, and the absence of a `sha` field.
test("enqueueGitHubJob builds the github data shape and dedup opts (fake queue captures add args)", async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = {
		add: (name, data, opts) => {
			captured = { name, data, opts };
			return { id: opts.jobId };
		},
	};

	const trigger = { event: "issues", action: "labeled", deliveryId: "guid-123", sender: { id: 42, login: "octocat" } };
	const jobId = await enqueueGitHubJob(fakeQueue, {
		repo: "owner/repo",
		issueNumber: 7,
		flow: "frontend-fix",
		title: "Button is misaligned",
		body: "The submit button overflows on mobile",
		trigger,
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
	});

	assert.equal(jobId, "gh-guid-123");
	assert.equal(captured.name, "github");

	// Data shape: kind:"github", NO sha, trigger passed through verbatim.
	assert.equal(captured.data.kind, "github");
	assert.equal("sha" in captured.data, false, "no sha -- resolved fresh in prepare (C1)");
	assert.equal(captured.data.repo, "owner/repo");
	assert.equal(captured.data.issueNumber, 7);
	assert.equal(captured.data.flow, "frontend-fix");
	assert.deepEqual(captured.data.trigger, trigger);

	// Opts: exact-per-delivery jobId + additive semantic window + 31d retention.
	assert.equal(captured.opts.jobId, `gh-${trigger.deliveryId}`);
	assert.equal(captured.opts.deduplication.id, "owner/repo#7:frontend-fix");
	assert.equal(captured.opts.deduplication.ttl, 10 * 60 * 1000);
	assert.ok(captured.opts.removeOnComplete.age >= 30 * 24 * 3600, "retention >= 30d");
	assert.ok(captured.opts.removeOnFail.age >= 30 * 24 * 3600, "fail retention >= 30d");
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

// A uniquely-named queue per run so parallel/repeated Valkey tests cannot see each other's jobs.
async function freshGitHubQueue() {
	const { Queue } = await import("bullmq");
	const { parseConnection } = await import("../src/connection.mjs");
	const name = `pi-jobs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	return new Queue(name, { connection: parseConnection(url) });
}

test("same delivery GUID twice -> one job (exact redelivery dedup)", { skip }, async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	const q = await freshGitHubQueue();
	try {
		const base = { repo: "owner/repo", issueNumber: 7, flow: "frontend-fix", title: "t", body: "b", provider: "anthropic", model: "m", maxTurns: 5 };
		const trigger = { event: "issues", action: "labeled", deliveryId: "guid-same", sender: { id: 1, login: "u" } };
		const id1 = await enqueueGitHubJob(q, { ...base, trigger });
		const id2 = await enqueueGitHubJob(q, { ...base, trigger }); // redelivery -> same jobId
		assert.equal(id1, id2);
		const counts = await q.getJobCounts("waiting");
		assert.equal(counts.waiting, 1, "the redelivery must be ignored");
		const job = await q.getJob(id1);
		assert.equal(job.data.kind, "github");
		assert.equal("sha" in job.data, false);
	} finally {
		await q.obliterate({ force: true }).catch(() => {});
		await q.close();
	}
});

test("two different GUIDs on distinct issues -> two jobs", { skip }, async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	const q = await freshGitHubQueue();
	try {
		const base = { repo: "owner/repo", flow: "frontend-fix", title: "t", body: "b", provider: "anthropic", model: "m", maxTurns: 5 };
		const id1 = await enqueueGitHubJob(q, { ...base, issueNumber: 1, trigger: { event: "issues", action: "labeled", deliveryId: "guid-a", sender: { id: 1, login: "u" } } });
		const id2 = await enqueueGitHubJob(q, { ...base, issueNumber: 2, trigger: { event: "issues", action: "labeled", deliveryId: "guid-b", sender: { id: 1, login: "u" } } });
		assert.notEqual(id1, id2);
		const counts = await q.getJobCounts("waiting");
		assert.equal(counts.waiting, 2, "distinct deliveries on distinct issues are distinct jobs");
	} finally {
		await q.obliterate({ force: true }).catch(() => {});
		await q.close();
	}
});

test("two different GUIDs, same repo#issue:flow within the window -> one active (semantic coalescing)", { skip }, async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	const q = await freshGitHubQueue();
	try {
		const base = { repo: "owner/repo", issueNumber: 7, flow: "frontend-fix", title: "t", body: "b", provider: "anthropic", model: "m", maxTurns: 5 };
		const id1 = await enqueueGitHubJob(q, { ...base, trigger: { event: "issues", action: "labeled", deliveryId: "guid-x", sender: { id: 1, login: "u" } } });
		const id2 = await enqueueGitHubJob(q, { ...base, trigger: { event: "issues", action: "labeled", deliveryId: "guid-y", sender: { id: 1, login: "u" } } });
		assert.notEqual(id1, id2, "distinct GUIDs -> distinct jobIds");
		const counts = await q.getJobCounts("waiting");
		assert.equal(counts.waiting, 1, "a rapid re-label coalesces within the semantic window");
	} finally {
		await q.obliterate({ force: true }).catch(() => {});
		await q.close();
	}
});
