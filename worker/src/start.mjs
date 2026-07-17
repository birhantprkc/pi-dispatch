import { configError, loadConfig } from "./config.mjs";
import { makeRedisClient, parseConnection } from "./connection.mjs";
import { makeGitHubAuth } from "./get-token.mjs";
import { makeGitHubHost } from "./github-host.mjs";
import { createWorker } from "./index.mjs";
import { cleanup, makePrepareWorkspace } from "./prepare.mjs";
import { makeRunContainer } from "./run-container.mjs";

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
	{ makeAuth = makeGitHubAuth, makeHost = makeGitHubHost, createWorkerFn = createWorker } = {},
) {
	const config = loadConfig(env);
	const log = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);

	let gh = null;
	try {
		gh = await makeAuth(config.github);
		log("self_identity", { id: gh.selfId, source: gh.source });
	} catch (err) {
		log("github_auth_unavailable", { reason: err?.message });
	}
	const host = makeHost();

	const worker = createWorkerFn({
		connection: parseConnection(config.valkeyUrl),
		concurrency: config.concurrency,
		cap: config.dailyCap,
		redis: makeRedisClient(config.valkeyUrl),
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
