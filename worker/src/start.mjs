import { loadConfig } from "./config.mjs";
import { makeRedisClient, parseConnection } from "./connection.mjs";
import { createWorker } from "./index.mjs";
import { cleanup, makePrepareWorkspace } from "./prepare.mjs";
import { makeRunContainer } from "./run-container.mjs";

/**
 * The runnable worker. Reads config, connects to Valkey, wires every REAL dependency the processor
 * needs, and starts draining the queue. `createWorker` already installs the timeout, the
 * abort->docker-stop, and the SIGTERM/SIGINT graceful shutdown.
 *
 * GitHub deps (mintToken, isDefaultBranchProtected) are wired to throw: a github job reaching this
 * worker in this slice is a clear error, not a silent no-op.
 */
export function startWorker(env = process.env) {
	const config = loadConfig(env);
	const log = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);

	const worker = createWorker({
		connection: parseConnection(config.valkeyUrl),
		concurrency: config.concurrency,
		cap: config.dailyCap,
		redis: makeRedisClient(config.valkeyUrl),
		deps: {
			runContainer: makeRunContainer({ image: config.jobImage, hostEnv: env }),
			prepareWorkspace: makePrepareWorkspace({ jobsDir: config.jobsDir }),
			cleanup,
			comment: (job, text) => log("comment", { jobId: job?.id, text }),
			log,
			mintToken: async () => {
				throw new Error("github jobs are not implemented in this slice");
			},
			isDefaultBranchProtected: async () => {
				throw new Error("github jobs are not implemented in this slice");
			},
		},
	});

	// REQ-LOCAL-JOB-VISIBILITY: exactly one terminal line per job, carrying the job id and outcome,
	// where the operator is already looking. This is the local counterpart of the GitHub issue
	// comment and the signal for CONST-PI-VERSION-PINNED's silent-no-op mode -- a missing line is
	// what tells a human a run did nothing. The container's own output already streams via
	// runContainer's onOutput during the run.
	worker.on("completed", (job, result) => log("job_completed", { jobId: job?.id, outcome: result?.outcome }));
	worker.on("failed", (job, err) =>
		log("job_failed", { jobId: job?.id, attempt: job?.attemptsMade, reason: String(err?.message ?? err).slice(0, 120) }),
	);

	log("worker_started", {
		queue: "pi-jobs",
		concurrency: config.concurrency,
		dailyCap: config.dailyCap,
		image: config.jobImage,
		valkey: config.valkeyUrl,
	});
	return worker;
}
