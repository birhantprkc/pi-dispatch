import { spawn } from "node:child_process";
import { buildDockerRunArgs } from "./docker-run.mjs";
import { buildContainerEnv } from "./env-allowlist.mjs";

/**
 * The real `runContainer` the processor injects. Launches one job container and returns its exit
 * code, which INT-RUNNER-EXIT-CODE-PROTOCOL turns into retry-vs-success.
 *
 * `spawn` (not execFile) because a non-zero exit is NORMAL here: exit 1 (infra) and 2 (policy) are
 * expected outcomes, not errors to reject on. The exit code comes from the `close` event.
 *
 * The container is stopped on abort by the worker wiring (index.mjs onAbort -> docker stop), which
 * causes `docker run` to exit and this promise to resolve. We only handle the entry case here: if
 * the signal is ALREADY aborted (the 30-min timeout fired during a slow prepare), do not start a
 * container at all.
 *
 * Output is streamed to `onOutput` (default: the worker's stdout) so the operator watches the agent
 * work on their own machine -- the natural local UX. This is the operator's own console for their
 * own folder; it is not a persistent PII log.
 */
export function makeRunContainer({ image, hostEnv = process.env, onOutput = (c) => process.stdout.write(c), spawnFn = spawn }) {
	// async so a synchronous throw (e.g. buildContainerEnv on an unconfigured provider) surfaces as
	// a rejection, uniformly awaitable by the processor and by tests.
	return async function runContainer({ job, token, prepared, name, signal }) {
		if (signal?.aborted) return 137; // killed before it could start

		// Closed env allowlist: only the provider key + the declared PI_* vars. Throws (config) if
		// the provider is unconfigured -- the processor turns that into a pre-spend refusal.
		const env = buildContainerEnv({
			provider: job.provider,
			model: job.model,
			maxTurns: job.maxTurns,
			jobId: name,
			githubToken: token ?? undefined,
			hostEnv,
		});

		const args = buildDockerRunArgs({
			image,
			env,
			jobDir: prepared.jobDir,
			workspace: prepared.workspace,
			name,
		});

		return await new Promise((resolve, reject) => {
			const child = spawnFn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
			child.stdout?.on("data", onOutput);
			child.stderr?.on("data", onOutput);
			child.on("error", reject); // docker not found / cannot spawn -- a real infra failure
			child.on("close", (code) => resolve(code ?? 1));
		});
	};
}
