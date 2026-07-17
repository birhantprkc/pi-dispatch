import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { prepareGithubWorkspace } from "./prepare-github.mjs";
import { prepareLocalWorkspace } from "./prepare-local.mjs";

/**
 * The `prepareWorkspace` dispatcher the processor injects. Creates a per-job dir under `jobsDir`
 * (holding the read-only /job inputs) and routes by job kind: local jobs go to `prepareLocalWorkspace`,
 * GitHub jobs to `prepareGithubWorkspace`.
 *
 * The `flow` becomes a prompt hint; the actual skill is provided by the project's materialised
 * .pi/skills.
 */
export function makePrepareWorkspace({
	jobsDir,
	resolveDefaultBranchSha,
	prepareLocal = prepareLocalWorkspace,
	prepareGithub = prepareGithubWorkspace,
}) {
	mkdirSync(jobsDir, { recursive: true });
	return async function prepareWorkspace(job, token) {
		const jobDir = mkdtempSync(join(jobsDir, "job-"));
		if (job.kind === "local") {
			const task = job.flow ? `Use the "${job.flow}" skill for this task.\n\n${job.task ?? ""}` : (job.task ?? "");
			return await prepareLocal({ folder: job.folder, task, jobDir });
		}
		if (job.kind === "github") {
			return await prepareGithub(job, token, { jobDir, resolveDefaultBranchSha });
		}
		throw new Error(`unknown job kind: ${job.kind}`);
	};
}

/** Remove a per-job dir after the run. The workspace (the operator's folder) is never touched here. */
export async function cleanup(prepared) {
	if (prepared?.jobDir) await rm(prepared.jobDir, { recursive: true, force: true });
}
