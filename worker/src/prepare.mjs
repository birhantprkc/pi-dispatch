import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { prepareGithubWorkspace } from "./prepare-github.mjs";
import { prepareLocalWorkspace } from "./prepare-local.mjs";

/**
 * The `prepareWorkspace` dispatcher the processor injects. Creates a per-job dir under `jobsDir`
 * (holding the read-only /job inputs) and routes by job kind: local jobs go to `prepareLocalWorkspace`,
 * forge-backed jobs to the preparer registered for their kind.
 *
 * The `flow` becomes a prompt hint; the actual skill is provided by the project's materialised
 * .pi/skills.
 *
 * `forgeFor(job)` yields the `{ auth, host }` pair for that job's forge (start.mjs owns the map). The
 * preparer is handed `host.resolveDefaultBranchSha` rather than the whole pair, so a preparer can only
 * resolve a SHA -- it gets no minting capability and no comment surface it has no business holding.
 *
 * `findPreviousRun` (run-history's `makeFindPreviousRun`) feeds the cron event context below; the
 * default returns null so an unwired dispatcher (tests, a bare construction) still writes a complete
 * event with `previousRunAt: null`.
 */
export function makePrepareWorkspace({
	jobsDir,
	forgeFor,
	findPreviousRun = () => null,
	prepareLocal = prepareLocalWorkspace,
	// Keyed by `job.kind`, so a new forge is one entry rather than a new `if`. A kind with no entry falls
	// through to the throw below, which is what makes an unrouted job loud instead of a silent no-op.
	preparers = { github: prepareGithubWorkspace },
}) {
	mkdirSync(jobsDir, { recursive: true });
	return async function prepareWorkspace(job, token, { queueJobId } = {}) {
		const jobDir = mkdtempSync(join(jobsDir, "job-"));
		if (job.kind === "local") {
			// Harness text above, operator DATA below: the fixed pointer line names /job/event.json so a
			// flow can discover the trigger context (mirroring the github prompt, which names the same
			// file); nothing in-container reads it otherwise. The pointer sits AFTER the flow hint and
			// BEFORE the operator's task, which stays verbatim (CONST-ISSUE-TEXT-IS-DATA).
			const pointer = "Context about this run -- its trigger and schedule -- is in /job/event.json.\n\n";
			const task = job.flow
				? `Use the "${job.flow}" skill for this task.\n\n${pointer}${job.task ?? ""}`
				: `${pointer}${job.task ?? ""}`;
			const event = localEventContext(job, queueJobId, findPreviousRun);
			return await prepareLocal({ folder: job.folder, task, jobDir, event });
		}
		const prepare = preparers[job.kind];
		if (prepare) {
			const host = forgeFor?.(job)?.host;
			return await prepare(job, token, { jobDir, resolveDefaultBranchSha: host?.resolveDefaultBranchSha });
		}
		throw new Error(`unknown job kind: ${job.kind}`);
	};
}

/**
 * The trigger context a local job's `/job/event.json` carries (INT-CONTAINER-JOB-INPUTS). Source is
 * derived from the job data alone: a chained child carries `parentJobId`/`chainDepth` (queue.mjs sets
 * them only on chains), a scheduled job carries the cron-only `trigger` field (schedules.mjs), and
 * everything else is the operator's own `pi-dispatch run` -- manual.
 *
 * For cron, the scheduled-for instant comes from BullMQ's deterministic `repeat:<id>:<millis>` jobId
 * (DES-CRON-VIA-BULLMQ-SCHEDULER) -- the wiring injects it as `queueJobId`. When the id is missing or
 * unparseable the lookup is SKIPPED: both `scheduledFor` and `previousRunAt` are null, never a guess.
 */
function localEventContext(job, queueJobId, findPreviousRun) {
	if (job.parentJobId !== undefined || job.chainDepth !== undefined) return { source: "chain" };
	if (job.trigger) {
		const millis = scheduledForMillis(queueJobId);
		return {
			source: "cron",
			trigger: job.trigger,
			scheduledFor: millis === null ? null : new Date(millis).toISOString(),
			previousRunAt: millis === null ? null : (findPreviousRun({ schedulerId: job.trigger.id, beforeMillis: millis }) ?? null),
		};
	}
	return { source: "manual" };
}

/** Parse the millis out of a `repeat:<id>:<millis>` BullMQ scheduled jobId, or null. */
function scheduledForMillis(queueJobId) {
	if (typeof queueJobId !== "string" || !queueJobId.startsWith("repeat:")) return null;
	const tail = queueJobId.slice(queueJobId.lastIndexOf(":") + 1);
	if (tail === "") return null;
	const millis = Number(tail);
	return Number.isFinite(millis) ? millis : null;
}

/** Remove a per-job dir after the run. The workspace (the operator's folder) is never touched here. */
export async function cleanup(prepared) {
	if (prepared?.jobDir) await rm(prepared.jobDir, { recursive: true, force: true });
}
