import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makePrepareWorkspace } from "../src/prepare.mjs";

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
			resolveDefaultBranchSha: fakeResolve,
			prepareGithub: fakeGithub,
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

test("dispatches a local job to prepareLocal with { folder, task, jobDir }", async () => {
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
			resolveDefaultBranchSha: async () => ({ sha: "x" }),
			prepareGithub: fakeGithub,
			prepareLocal: fakeLocal,
		});

		const localJob = { kind: "local", folder: "/some/folder", flow: "tidy", task: "clean up" };
		await prepareWorkspace(localJob, undefined);

		assert.equal(githubCalled, false);
		assert.equal(calls.length, 1);
		const arg = calls[0];
		assert.equal(arg.folder, "/some/folder");
		assert.equal(arg.task, 'Use the "tidy" skill for this task.\n\nclean up');
		assert.equal(typeof arg.jobDir, "string");
		assert.ok(arg.jobDir.startsWith(jobsDir));
	} finally {
		cleanup();
	}
});

test("throws on an unknown job kind", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			resolveDefaultBranchSha: async () => ({ sha: "x" }),
			prepareGithub: async () => {},
			prepareLocal: async () => {},
		});

		await assert.rejects(() => prepareWorkspace({ kind: "banana" }, undefined), /unknown job kind/);
	} finally {
		cleanup();
	}
});
