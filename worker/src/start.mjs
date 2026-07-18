import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configError, loadConfig } from "./config.mjs";
import { makeRedisClient, parseConnection } from "./connection.mjs";
import { reconcile } from "./cron.mjs";
import { makeGitHubAuth } from "./get-token.mjs";
import { makeGitHubHost } from "./github-host.mjs";
import { createWorker } from "./index.mjs";
import { cleanup, makePrepareWorkspace } from "./prepare.mjs";
import { makeQueue } from "./queue.mjs";
import { makeRunContainer } from "./run-container.mjs";
import { loadSchedules } from "./schedules.mjs";
import { makeStallGuard } from "./scheduler-stall-guard.mjs";

const exec = promisify(execFile);

/**
 * Boot-time reaper: clear stray `pi-job-*` containers a previous worker crash left behind, before
 * the new worker starts draining. A leaked container keeps spending, so it must go before any new
 * job launches.
 *
 * It runs `docker ps` / `docker rm -f` ONLY. It never inspects a container's exit code, never touches
 * the queue, and never re-enqueues -- queue and retry state belong to Redis, not to docker
 * (INT-RUNNER-EXIT-CODE-PROTOCOL / CONST-RETRY-INFRA-ONLY). It logs container names only (no PII).
 *
 * It assumes ONE worker per docker daemon: a co-located second worker's boot would remove the first's
 * in-flight `pi-job-*` container. That is the accepted v1 shape (DES-CONCURRENCY-3, single worker per
 * host).
 *
 * `reap()` NEVER throws: a missing docker binary or a down daemon is caught, logged as
 * `reaper_skipped`, and boot continues to the worker.
 */
export function makeReaper({ log }) {
	return async function reap() {
		try {
			const { stdout } = await exec("docker", ["ps", "--filter", "name=pi-job-", "--format", "{{.Names}}"]);
			const names = stdout
				.split("\n")
				.map((n) => n.trim())
				.filter(Boolean);
			for (const name of names) {
				await exec("docker", ["rm", "-f", name]);
				log("reaped_container", { name });
			}
		} catch (err) {
			log("reaper_skipped", { reason: err?.message });
		}
	};
}

/**
 * The runnable worker. Reads config, connects to Valkey, wires every REAL dependency the processor
 * needs, and starts draining the queue. `createWorker` already installs the timeout, the
 * abort->docker-stop, and the SIGTERM/SIGINT graceful shutdown.
 *
 * GitHub auth is initialised best-effort: a local-only deployment must still boot when no working
 * GITHUB_AUTH_SOURCE is present, so an auth failure is logged and the github deps fail closed per
 * job (mintToken throws configError) rather than blocking startup. Collaborators are injectable
 * (defaulting to the real ones) so the wiring is testable offline with no Redis and no GitHub.
 */
export async function startWorker(
	env = process.env,
	{ makeAuth = makeGitHubAuth, makeHost = makeGitHubHost, createWorkerFn = createWorker, makeReaper: makeReaperFn = makeReaper } = {},
) {
	const config = loadConfig(env);
	const log = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);

	// DES-CRON-VIA-BULLMQ-SCHEDULER: load and validate the schedule file with the operator present and
	// before any Valkey contact, so a misconfigured schedule refuses startup loudly (configError) rather
	// than upserting a broken scheduler. [] means cron disabled (no PI_SCHEDULES_FILE).
	const schedules = loadSchedules(config);

	let gh = null;
	try {
		gh = await makeAuth(config.github);
		log("self_identity", { id: gh.selfId, source: gh.source });
	} catch (err) {
		log("github_auth_unavailable", { reason: err?.message });
	}
	const host = makeHost();

	// Clear strays left by a previous crash before the worker starts draining. Best-effort: the reaper
	// swallows its own docker errors; this guard keeps any reaper failure from blocking boot.
	try {
		await makeReaperFn({ log })();
	} catch (err) {
		log("reaper_skipped", { reason: err?.message });
	}

	// One raw Redis client, shared by the budget (via the worker) and the scheduler stall guard, so it is
	// hoisted out of the createWorkerFn arg object.
	const redis = makeRedisClient(config.valkeyUrl);
	// The persistent runtime queue the stall guard tears schedulers down through. Non-failFast: a long-lived
	// handle rides out a Valkey blip. Registered as an extraCloser so shutdown drains it after the worker.
	const schedulerQueue = makeQueue(parseConnection(config.valkeyUrl));

	const worker = createWorkerFn({
		connection: parseConnection(config.valkeyUrl),
		concurrency: config.concurrency,
		cap: config.dailyCap,
		redis,
		extraClosers: [schedulerQueue],
		deps: {
			runContainer: makeRunContainer({ image: config.jobImage, hostEnv: env }),
			prepareWorkspace: makePrepareWorkspace({
				jobsDir: config.jobsDir,
				resolveDefaultBranchSha: host.resolveDefaultBranchSha,
			}),
			cleanup,
			comment: async (job, text) => {
				// Best-effort: the processor awaits comment() inside its try, so a rejection here would
				// corrupt the job outcome and could drive a wrong retry / second PR (CONST-RETRY-INFRA-ONLY).
				// This adapter NEVER throws.
				if (job?.kind === "github" && gh) {
					try {
						const token = await gh.mintToken(job.repo);
						await host.postStatusComment(job.repo, job.issueNumber, text, token);
					} catch (err) {
						log("comment_failed", { jobId: job?.id, reason: err?.message });
					}
					return;
				}
				log("comment", { jobId: job?.id, text });
			},
			log,
			mintToken:
				gh?.mintToken ??
				(async () => {
					throw configError("github jobs require a working GITHUB_AUTH_SOURCE (gh/pat/app)");
				}),
			isDefaultBranchProtected: host.isDefaultBranchProtected,
		},
	});

	// REQ-LOCAL-JOB-VISIBILITY: exactly one terminal line per job, carrying the job id and outcome,
	// where the operator is already looking. This is the local counterpart of the GitHub issue
	// comment and the signal for CONST-PI-VERSION-PINNED's silent-no-op mode -- a missing line is
	// what tells a human a run did nothing. The container's own output already streams via
	// runContainer's onOutput during the run.
	// `reason` is a fixed enum (worker-abort | over-budget | unprotected-branch | runner-policy), never
	// user content. Included only when present so success lines stay clean; a shutdown-aborted job logs
	// { outcome: "policy", reason: "worker-abort" }, making a restart-dropped job visible.
	worker.on("completed", (job, result) =>
		log("job_completed", { jobId: job?.id, outcome: result?.outcome, ...(result?.reason ? { reason: result.reason } : {}) }),
	);
	worker.on("failed", (job, err) =>
		log("job_failed", { jobId: job?.id, attempt: job?.attemptsMade, reason: String(err?.message ?? err).slice(0, 120) }),
	);

	// CONST-RETRY-INFRA-ONLY money backstop: BullMQ's maxStalledCount does not bound scheduler jobs, so a
	// wedged scheduled run is re-paid on every stall. The guard counts stalls per scheduler and tears the
	// scheduler down past the threshold. Keyed on "stalled", not "failed" -- only a stall is the unbounded re-run.
	const guard = makeStallGuard({
		redis,
		threshold: config.schedulerStallMax,
		removeJobScheduler: (id) => schedulerQueue.removeJobScheduler(id),
		log,
	});
	worker.on("stalled", (jobId) => void guard.onStalled(jobId));

	// DES-CRON-VIA-BULLMQ-SCHEDULER: install the schedule set (and prune orphans) before announcing the
	// worker is up, so schedules_installed always precedes worker_started. An empty set skips the reconcile
	// queue entirely -- no getJobSchedulers Redis hit -- but still logs {0,0} so the operator sees cron is off.
	if (schedules.length > 0) {
		const rq = makeQueue(parseConnection(config.valkeyUrl, { failFast: true }));
		try {
			const r = await reconcile(rq, schedules, { log });
			log("schedules_installed", { installed: r.installed, removed: r.removed });
		} finally {
			await rq.close().catch(() => {});
		}
	} else {
		log("schedules_installed", { installed: 0, removed: 0 });
	}

	log("worker_started", {
		queue: "pi-jobs",
		concurrency: config.concurrency,
		dailyCap: config.dailyCap,
		image: config.jobImage,
		valkey: config.valkeyUrl,
	});
	return worker;
}
