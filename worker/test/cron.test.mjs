import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcile, reloadSchedules } from "../src/cron.mjs";

// reconcile is pure over the injected queue -- no bullmq, no real Valkey. The fake queue captures every
// call so tests assert on exact arguments, and its return values / throws are configurable per case.
function makeFakeQueue({ upsertResult = "scheduler-key", upsertThrows = false, residents = [], removeThrows = false } = {}) {
	const calls = { upsert: [], getJobSchedulers: [], removed: [] };
	return {
		calls,
		async upsertJobScheduler(id, repeatOpts, tmpl) {
			calls.upsert.push({ id, repeatOpts, tmpl });
			if (upsertThrows) throw new Error("upstream upsert boom");
			return upsertResult;
		},
		async getJobSchedulers(start, end, asc) {
			calls.getJobSchedulers.push({ start, end, asc });
			return residents;
		},
		async removeJobScheduler(id) {
			calls.removed.push(id);
			if (removeThrows) throw new Error("scheduler not found");
		},
	};
}

// A normalized schedule as schedules.mjs emits it.
const sched = (id, pattern = "0 3 * * *") => ({
	schedulerId: id,
	name: "local",
	pattern,
	data: { kind: "local", folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 30 },
	opts: { removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } },
});

const noLog = () => {};

test("upserts once per schedule with {pattern} as 2nd arg and {name,data,opts} as 3rd", async () => {
	const q = makeFakeQueue();
	const schedules = [sched("a"), sched("b", "0 4 * * *")];
	await reconcile(q, schedules, { log: noLog });

	assert.equal(q.calls.upsert.length, 2);
	const first = q.calls.upsert[0];
	assert.equal(first.id, "a");
	assert.deepEqual(first.repeatOpts, { pattern: "0 3 * * *" });
	assert.deepEqual(Object.keys(first.tmpl).sort(), ["data", "name", "opts"]);
	assert.equal(first.tmpl.name, "local");
	assert.equal(first.tmpl.data.folder, "/proj");

	const second = q.calls.upsert[1];
	assert.equal(second.id, "b");
	assert.deepEqual(second.repeatOpts, { pattern: "0 4 * * *" });
});

test("no jobId is passed anywhere in the upsert opts", async () => {
	const q = makeFakeQueue();
	await reconcile(q, [sched("a")], { log: noLog });
	for (const c of q.calls.upsert) {
		assert.equal("jobId" in c.repeatOpts, false);
		assert.equal("jobId" in c.tmpl, false);
		assert.equal("jobId" in (c.tmpl.opts ?? {}), false);
	}
});

test("upsertJobScheduler returning -10 (SchedulerJobIdCollision) rejects, naming the schedulerId and code", async () => {
	const q = makeFakeQueue({ upsertResult: -10 });
	await assert.rejects(
		() => reconcile(q, [sched("collide")], { log: noLog }),
		(e) => e.message.includes("collide") && e.message.includes("-10") && e.message.includes("SchedulerJobIdCollision"),
	);
});

test("upsertJobScheduler returning -11 (SchedulerJobSlotsBusy) rejects, naming the schedulerId and code", async () => {
	const q = makeFakeQueue({ upsertResult: -11 });
	await assert.rejects(
		() => reconcile(q, [sched("busy")], { log: noLog }),
		(e) => e.message.includes("busy") && e.message.includes("-11") && e.message.includes("SchedulerJobSlotsBusy"),
	);
});

test("upsertJobScheduler throwing rejects loudly, naming the schedulerId", async () => {
	const q = makeFakeQueue({ upsertThrows: true });
	await assert.rejects(
		() => reconcile(q, [sched("kaboom")], { log: noLog }),
		(e) => e.piDispatchConfig === true && e.message.includes("kaboom"),
	);
});

test("prunes resident schedulers absent from config (.key shape): removes b, keeps a", async () => {
	const q = makeFakeQueue({ residents: [{ key: "a" }, { key: "b" }] });
	const res = await reconcile(q, [sched("a")], { log: noLog });
	assert.deepEqual(q.calls.removed, ["b"]);
	assert.equal(res.removed, 1);
});

test("robust id extraction from .id-shaped descriptors", async () => {
	const q = makeFakeQueue({ residents: [{ id: "a" }, { id: "b" }] });
	await reconcile(q, [sched("a")], { log: noLog });
	assert.deepEqual(q.calls.removed, ["b"]);
});

test("robust id extraction from bare-string descriptors", async () => {
	const q = makeFakeQueue({ residents: ["a", "b"] });
	await reconcile(q, [sched("a")], { log: noLog });
	assert.deepEqual(q.calls.removed, ["b"]);
});

test("empty config prunes all residents (orphan prune covers empty config)", async () => {
	const q = makeFakeQueue({ residents: [{ key: "x" }] });
	const res = await reconcile(q, [], { log: noLog });
	assert.deepEqual(q.calls.removed, ["x"]);
	assert.deepEqual(res, { installed: 0, removed: 1 });
});

test("config matching residents removes nothing (idempotent re-run)", async () => {
	const q = makeFakeQueue({ residents: [{ key: "a" }, { key: "b" }] });
	const res = await reconcile(q, [sched("a"), sched("b")], { log: noLog });
	assert.deepEqual(q.calls.removed, []);
	assert.equal(res.removed, 0);
});

test("removeJobScheduler throwing not-found is tolerated; reconcile resolves with correct counts", async () => {
	const q = makeFakeQueue({ residents: [{ key: "orphan" }], removeThrows: true });
	const res = await reconcile(q, [], { log: noLog });
	assert.deepEqual(q.calls.removed, ["orphan"]); // removal was attempted
	assert.deepEqual(res, { installed: 0, removed: 1 }); // counted despite the throw
});

test("queries residents with getJobSchedulers(0, -1, true)", async () => {
	const q = makeFakeQueue();
	await reconcile(q, [sched("a")], { log: noLog });
	assert.deepEqual(q.calls.getJobSchedulers, [{ start: 0, end: -1, asc: true }]);
});

test('logs "scheduler_removed_orphan" with the pruned id', async () => {
	const events = [];
	const q = makeFakeQueue({ residents: [{ key: "b" }] });
	await reconcile(q, [], { log: (event, fields) => events.push({ event, fields }) });
	assert.deepEqual(events, [{ event: "scheduler_removed_orphan", fields: { schedulerId: "b" } }]);
});

test("returns {installed, removed} reflecting config size and orphan count", async () => {
	const q = makeFakeQueue({ residents: [{ key: "a" }, { key: "gone1" }, { key: "gone2" }] });
	const res = await reconcile(q, [sched("a"), sched("new")], { log: noLog });
	assert.equal(res.installed, 2); // both schedules upserted
	assert.equal(res.removed, 2); // gone1 + gone2 pruned
	assert.deepEqual(q.calls.removed, ["gone1", "gone2"]);
});

// reloadSchedules: the live-edit path (OQ-008). loadFn/reconcileFn injected -> no fs, no bullmq.

test("reloadSchedules re-selects cron and reconciles on a valid file", async () => {
	const reconciled = [];
	const res = await reloadSchedules({ triggersFile: "/t.json" }, {}, {
		log: () => {},
		loadFn: () => [{ schedulerId: "a", name: "local", pattern: "0 3 * * *", data: {}, opts: {} }],
		reconcileFn: async (_q, s) => (reconciled.push(s.length), { installed: s.length, removed: 0 }),
	});
	assert.deepEqual(res, { ok: true, installed: 1, removed: 0 });
	assert.deepEqual(reconciled, [1], "the new schedule set is reconciled");
});

test("reloadSchedules keeps the running schedulers when the new file is invalid (never reconciles a bad file)", async () => {
	let reconciled = false;
	const res = await reloadSchedules({ triggersFile: "/t.json" }, {}, {
		log: () => {},
		loadFn: () => {
			throw Object.assign(new Error("bad cron id"), { piDispatchConfig: true });
		},
		reconcileFn: async () => ((reconciled = true), {}),
	});
	assert.ok(res.invalid, "an invalid reload reports the reason");
	assert.equal(reconciled, false, "a bad edit never reconciles -- the running schedulers are kept");
});
