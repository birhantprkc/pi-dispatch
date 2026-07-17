import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UnrecoverableError, Worker } from "bullmq";
import { InfraRetry, runJob } from "./processor.mjs";

const exec = promisify(execFile);

export const QUEUE = "pi-jobs";
export const JOB_TIMEOUT_MS = 30 * 60 * 1000; // REQ-JOB-TIMEOUT-30M

/**
 * Build the BullMQ processor.
 *
 * It MUST declare exactly three parameters (job, token, signal). BullMQ only allocates an
 * AbortController when `processor.length >= 3` (it inspects the function's arity at construction),
 * so dropping the unused `token` would silently disable BOTH the 30-minute timeout and the shutdown
 * abort -- with no error. A test asserts the arity precisely because the failure is silent.
 *
 * Dependencies are injected so this is testable without a live queue: `cancelJob` (fired by the
 * timeout), `stopContainer` (fired by the abort), and the orchestration deps.
 */
export function makeProcessor({ cancelJob, stopContainer, redis, cap, deps, timeoutMs = JOB_TIMEOUT_MS }) {
	return async function processor(job, token, signal) {
		const name = `pi-job-${job.id}`;
		const timer = setTimeout(() => {
			// BullMQ has no per-job kill timer; this is ours. cancelJob raises the AbortSignal.
			Promise.resolve(cancelJob(job.id, "job-timeout-30m")).catch(() => {});
		}, timeoutMs);

		// Abort (timeout OR shutdown) => stop the container. docker stop sends SIGTERM then SIGKILL
		// after the grace period; the runner exits and runContainer returns/throws.
		const onAbort = () => {
			Promise.resolve(stopContainer(name)).catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });

		try {
			return await runJob(job.data, {
				redis,
				cap,
				...deps,
				runContainer: (ctx) => deps.runContainer({ ...ctx, name, signal }),
			});
		} catch (error) {
			if (error instanceof InfraRetry) throw error; // retryable: BullMQ retries per attempts
			// A non-retryable, non-infra error (our bug) must not retry forever. UnrecoverableError
			// records it as failed-and-distinct on the dashboard without a retry.
			throw new UnrecoverableError(error.message);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	};
}

export function createWorker({ connection, concurrency, cap, redis, deps, limiter, extraClosers = [] }) {
	let worker; // referenced by cancelJob before assignment; only called later, so the TDZ is fine
	const processor = makeProcessor({
		cancelJob: (id, reason) => worker.cancelJob(id, reason),
		stopContainer: (name) => exec("docker", ["stop", "-t", "5", name]),
		redis,
		cap,
		deps,
	});

	worker = new Worker(QUEUE, processor, {
		// maxRetriesPerRequest: null is REQUIRED for BullMQ's blocking connections, or it throws.
		connection: { ...connection, maxRetriesPerRequest: null },
		concurrency,
		maxStalledCount: 0, // a stalled paid job FAILS, never silently re-runs (verified live)
		...(limiter ? { limiter } : {}),
	});

	const shutdown = async () => {
		// Abort active jobs (=> docker stop via onAbort), then close. Without the cancel,
		// worker.close() would wait up to 30 minutes for the container.
		await Promise.resolve(worker.cancelAllJobs?.("shutdown")).catch(() => {});
		await worker.close();
		// Close auxiliary resources (e.g. a cron scheduler) after the worker drains. Per-item catch
		// so one failing or absent closer never strands the others or blocks exit -- matches the
		// swallow posture on cancelAllJobs above.
		await Promise.all(extraClosers.map((c) => Promise.resolve(c.close?.()).catch(() => {})));
		process.exit(0);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);

	return worker;
}
