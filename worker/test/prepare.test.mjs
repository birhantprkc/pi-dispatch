import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeForgePreparers, makePrepareWorkspace } from "../src/prepare.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";

/** A fresh real jobsDir under os.tmpdir, plus a cleanup fn — mkdtempSync(join(jobsDir,"job-")) needs it real. */
function withJobsDir() {
	const jobsDir = mkdtempSync(join(tmpdir(), "pi-jobs-"));
	return { jobsDir, cleanup: () => rmSync(jobsDir, { recursive: true, force: true }) };
}

test("dispatches a github job to prepareGithub with (job, token, { jobDir, resolveDefaultBranchSha })", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const fakeResolve = async () => ({ sha: "deadbeef" });
		const calls = [];
		const fakeGithub = async (...args) => {
			calls.push(args);
			return { outcome: "ok" };
		};
		let localCalled = false;
		const fakeLocal = async () => {
			localCalled = true;
		};

		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			forgeFor: () => ({ host: { resolveDefaultBranchSha: fakeResolve } }),
			preparers: { github: fakeGithub },
			prepareLocal: fakeLocal,
		});

		const ghJob = { kind: "github", repo: "o/n", flow: "fix", issueNumber: 7 };
		const result = await prepareWorkspace(ghJob, "tok");

		assert.equal(result.outcome, "ok");
		assert.equal(calls.length, 1);
		assert.equal(localCalled, false);

		const [job, token, opts] = calls[0];
		assert.equal(job, ghJob);
		assert.equal(token, "tok");
		assert.equal(typeof opts.jobDir, "string");
		assert.ok(opts.jobDir.startsWith(jobsDir));
		assert.equal(opts.resolveDefaultBranchSha, fakeResolve);
	} finally {
		cleanup();
	}
});

test("dispatches a local job to prepareLocal with { folder, task, jobDir, event }", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const calls = [];
		const fakeLocal = async (arg) => {
			calls.push(arg);
			return { outcome: "ok" };
		};
		let githubCalled = false;
		const fakeGithub = async () => {
			githubCalled = true;
		};

		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			forgeFor: () => ({ host: { resolveDefaultBranchSha: async () => ({ sha: "x" }) } }),
			preparers: { github: fakeGithub },
			prepareLocal: fakeLocal,
		});

		const localJob = { kind: "local", folder: "/some/folder", flow: "tidy", task: "clean up" };
		await prepareWorkspace(localJob, undefined);

		assert.equal(githubCalled, false);
		assert.equal(calls.length, 1);
		const arg = calls[0];
		assert.equal(arg.folder, "/some/folder");
		// Exact composition: flow hint, then the fixed event.json pointer line, then the operator's task.
		assert.equal(
			arg.task,
			'Use the "tidy" skill for this task.\n\nContext about this run -- its trigger and schedule -- is in /job/event.json.\n\nclean up',
		);
		assert.equal(typeof arg.jobDir, "string");
		assert.ok(arg.jobDir.startsWith(jobsDir));
		assert.deepEqual(arg.event, { source: "manual" }, "no trigger, no parentJobId -> a manual run");
	} finally {
		cleanup();
	}
});

// The local-event helper for the cases below: a dispatcher with stubbed local/github preparers and a
// recording findPreviousRun, returning the single prepareLocal arg for a given job + queueJobId.
async function dispatchLocal(jobsDir, job, { queueJobId, findPreviousRun } = {}) {
	const calls = [];
	const prepareWorkspace = makePrepareWorkspace({
		jobsDir,
		forgeFor: () => ({ host: { resolveDefaultBranchSha: async () => ({ sha: "x" }) } }),
		preparers: { github: async () => {} },
		prepareLocal: async (arg) => {
			calls.push(arg);
			return { outcome: "ok" };
		},
		...(findPreviousRun ? { findPreviousRun } : {}),
	});
	await prepareWorkspace(job, undefined, queueJobId === undefined ? {} : { queueJobId });
	assert.equal(calls.length, 1);
	return calls[0];
}

test("a cron job's event carries trigger + scheduledFor + previousRunAt from the repeat jobId", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const lookups = [];
		const findPreviousRun = (arg) => {
			lookups.push(arg);
			return "2026-07-26T03:00:00.000Z";
		};
		const trigger = { id: "t", pattern: "0 3 * * *" };
		const job = { kind: "local", folder: "/some/folder", task: "x", trigger };

		const arg = await dispatchLocal(jobsDir, job, { queueJobId: "repeat:t:1758868620000", findPreviousRun });

		assert.deepEqual(arg.event, {
			source: "cron",
			trigger,
			scheduledFor: new Date(1758868620000).toISOString(),
			previousRunAt: "2026-07-26T03:00:00.000Z",
		});
		assert.deepEqual(lookups, [{ schedulerId: "t", beforeMillis: 1758868620000 }], "the lookup is keyed on the trigger id and the fire instant");
	} finally {
		cleanup();
	}
});

test("a chained child's event is { source: 'chain' } even without a trigger field", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const job = { kind: "local", folder: "/some/folder", task: "x", parentJobId: "local-parent", chainDepth: 1 };
		const arg = await dispatchLocal(jobsDir, job, {});
		assert.deepEqual(arg.event, { source: "chain" });
	} finally {
		cleanup();
	}
});

test("a plain local job's event is { source: 'manual' }", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const arg = await dispatchLocal(jobsDir, { kind: "local", folder: "/some/folder", task: "x" }, {});
		assert.deepEqual(arg.event, { source: "manual" });
	} finally {
		cleanup();
	}
});

test("a cron job with a missing or unparseable queueJobId gets null scheduledFor AND null previousRunAt (lookup skipped)", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const trigger = { id: "t", pattern: "0 3 * * *" };
		const nullEvent = { source: "cron", trigger, scheduledFor: null, previousRunAt: null };
		let looked = false;
		const findPreviousRun = () => {
			looked = true;
			return "2026-07-26T03:00:00.000Z";
		};

		for (const queueJobId of [undefined, "local-abc123", "repeat:t:not-millis"]) {
			const job = { kind: "local", folder: "/some/folder", task: "x", trigger };
			const arg = await dispatchLocal(jobsDir, job, { queueJobId, findPreviousRun });
			assert.deepEqual(arg.event, nullEvent, `queueJobId=${JSON.stringify(queueJobId)} -> nulls, never a guess`);
		}
		assert.equal(looked, false, "an unparseable fire instant skips the history lookup entirely");
	} finally {
		cleanup();
	}
});

test("throws on an unknown job kind", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			forgeFor: () => ({ host: { resolveDefaultBranchSha: async () => ({ sha: "x" }) } }),
			preparers: { github: async () => {} },
			prepareLocal: async () => {},
		});

		await assert.rejects(() => prepareWorkspace({ kind: "banana" }, undefined), /unknown job kind/);
	} finally {
		cleanup();
	}
});

test("makeForgePreparers hands the gitlab arm a GitLab clone URL and the glab envelope", async () => {
	// A gitlab job cloning from github.com is a silent failure: the URL either does not exist, or -- worse
	// -- does, and the job runs against a stranger's repository and reports success.
	const seen = [];
	const preparers = makeForgePreparers({
		gitlabApiUrl: "https://gl.internal",
		prepareForge: async (job, _token, opts) => (seen.push({ kind: job.kind, url: opts.remoteUrlFor?.(job), prompt: opts.buildPrompt }), { ok: true }),
	});

	await preparers.gitlab({ kind: "gitlab", repo: "group/sub/proj", flow: "fix", target: { type: "issue", number: 3 } }, "tok", { jobDir: "/j" });
	assert.equal(seen[0].url, "https://gl.internal/group/sub/proj.git");
	assert.ok(seen[0].prompt({ flow: "fix", target: { type: "issue", number: 3 } }).includes("glab"), "and the envelope must speak glab, not gh");

	// The github arm is the bare preparer: no URL builder and no prompt override, so it keeps its own
	// defaults and stays byte-identical to before the map existed.
	await preparers.github({ kind: "github", repo: "o/r" }, "tok", { jobDir: "/j" });
	assert.equal(seen[1].url, undefined);
	assert.equal(seen[1].prompt, undefined);
});

test("makeForgePreparers hands the forgejo arm a Forgejo clone URL and the tea envelope", async () => {
	// Same silent failure as the gitlab arm: a job cloning from the wrong instance either finds nothing or
	// -- worse -- finds a stranger's repository and reports success against it.
	const seen = [];
	const preparers = makeForgePreparers({
		forgejoApiUrl: "https://fj.internal",
		prepareForge: async (job, _token, opts) => (seen.push({ kind: job.kind, url: opts.remoteUrlFor?.(job), prompt: opts.buildPrompt }), { ok: true }),
	});

	await preparers.forgejo({ kind: "forgejo", repo: "acme/widgets", flow: "fix", target: { type: "issue", number: 3 } }, "tok", { jobDir: "/j" });
	assert.equal(seen[0].url, "https://fj.internal/acme/widgets.git");
	const envelope = seen[0].prompt({ flow: "fix", target: { type: "issue", number: 3 } });
	assert.ok(envelope.includes("tea"), "the envelope must speak tea");
	assert.equal(/\bgh (pr|issue) /.test(envelope), false, "and never gh -- gh implements the GitHub API");
});

test("every forge the table knows has a preparer -- a kind with none throws 'unknown job kind' at run time", async () => {
	// `prepare.mjs` dispatches on `preparers[job.kind]` and throws when there is none. That throw is loud,
	// but it happens INSIDE a job, after the budget slot is taken. Asserting the map covers the table moves
	// the discovery to here.
	const preparers = makeForgePreparers({ prepareForge: async () => ({ ok: true }) });
	for (const kind of FORGE_KINDS) {
		assert.equal(typeof preparers[kind], "function", `${kind}: a forge with no preparer burns a budget slot before it fails`);
	}
});
