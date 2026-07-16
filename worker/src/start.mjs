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

	log("worker_started", {
		queue: "pi-jobs",
		concurrency: config.concurrency,
		dailyCap: config.dailyCap,
		image: config.jobImage,
		valkey: config.valkeyUrl,
	});
	return worker;
}
