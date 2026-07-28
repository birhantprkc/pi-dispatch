import { spawn } from "node:child_process";
import { buildDockerRunArgs } from "./docker-run.mjs";
import { buildContainerEnv } from "./env-allowlist.mjs";
import { InfraRetry } from "./processor.mjs";

/**
 * The real `runContainer` the processor injects. Launches one job container and returns
 * `{ code, aborted }`, where `aborted` records whether the WORKER initiated the stop (docker stop on
 * the 30-min timeout or graceful shutdown), which the processor classifies as POLICY (no retry) per
 * INT-RUNNER-EXIT-CODE-PROTOCOL. The numeric `code` alone cannot say this: a worker SIGKILL and a
 * kernel OOM both surface as 137, so the abort FLAG -- not the code -- is the discriminator.
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
 * work on their own machine -- the natural local UX. When raw capture is enabled
 * (`PI_CAPTURE_JOB_LOGS`), the same output is tee'd to a host-only, gitignored `logs/<jobId>.log`
 * that is never mounted into the container and may contain agent-echoed issue text (PII). The
 * worker's event log and the `.json` status record stay id-only.
 */
export function makeRunContainer({
	image,
	hostEnv = process.env,
	onOutput = (c) => process.stdout.write(c),
	openJobLog = () => ({ write() {}, close: async () => ({ turns: null, tokens: null }) }),
	spawnFn = spawn,
	globalPiDir = null, // REQ-GLOBAL-PI-OVERLAY: operator's global pi overlay dir, mounted :ro; null = off
	allowGlobalExtensions = true, // REQ-GLOBAL-PI-OVERLAY: the staged overlay's extensions load unless PI_GLOBAL_ALLOW_EXTENSIONS=0
	packagePaths = [], // REQ-GLOBAL-PI-OVERLAY: container paths of the operator-staged packages, resolved once at boot
	forwardEnv = [],
	authFromPi = false, // fall back to ~/.pi/agent/auth.json for the provider key when the env has none
}) {
	// async so a synchronous throw (e.g. buildContainerEnv on an unconfigured provider) surfaces as
	// a rejection, uniformly awaitable by the processor and by tests.
	return async function runContainer({ job, token, prepared, name, signal }) {
		if (signal?.aborted) return { code: 137, aborted: true, turns: null, tokens: null }; // killed before it could start

		// Closed env allowlist: only the provider key + the declared PI_* vars. Throws (config) if
		// the provider is unconfigured -- the processor turns that into a pre-spend refusal.
		const env = buildContainerEnv({
			provider: job.provider,
			model: job.model,
			maxTurns: job.maxTurns,
			maxTokens: job.maxTokens, // optional per-job token budget (issue #25); undefined => runner meter only
			jobId: name,
			githubToken: token ?? undefined,
			hostEnv,
			allowGlobalExtensions, // REQ-GLOBAL-PI-OVERLAY: false emits the explicit PI_GLOBAL_ALLOW_EXTENSIONS=0 opt-out
			// REQ-GLOBAL-PI-OVERLAY: the per-job value comes off `job` (like maxTurns), the staged set off
			// the closure (like allowGlobalExtensions) -- so a trigger can withhold what the operator staged.
			// `!== false`, because staged packages LOAD unless a trigger explicitly opts out
			// (INT-TRIGGERS-FILE-CONTRACT). The strictness that used to live in this `=== true` did not
			// disappear, it moved: parseTriggers refuses any non-boolean run.packages fail-loud at load, so a
			// hand-edited string "false" never becomes job data this comparison could misread as an opt-out.
			packagePaths: job.packages === false ? [] : packagePaths,
			forwardEnv, // extra host var names to forward (e.g. a custom provider's key)
			authFromPi, // source the provider key from pi's auth.json when the env has none
		});

		const args = buildDockerRunArgs({
			image,
			env,
			jobDir: prepared.jobDir,
			workspace: prepared.workspace,
			outboxDir: prepared.outboxDir, // undefined for github jobs -> docker-run's guard skips the /outbox mount
			globalPiDir, // undefined/null -> docker-run's guard skips the /opt/pi-global mount
			name,
		});

		// Host-side per-job log sink, teed off `onOutput`. `name` is `pi-job-<jobId>`; the sink
		// sanitizes internally. No container mount, no env var -- the sink lives on this side only.
		const sink = openJobLog(name);

		return await new Promise((resolve, reject) => {
			const child = spawnFn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
			// A throwing sink.write is swallowed so a misbehaving sink cannot break the tee or hang the run.
			const tee = (chunk) => {
				onOutput(chunk);
				try {
					sink.write(chunk);
				} catch {}
			};
			child.stdout?.on("data", tee);
			child.stderr?.on("data", tee);
			// docker not found / daemon down -- a transient infra fault, so tag it retryable
			// (CONST-RETRY-INFRA-ONLY). `reason` also cues the processor to release the budget slot,
			// since a container that never started spent nothing.
			child.on("error", (err) => {
				sink.close().catch(() => {}); // best-effort teardown; a rejecting close cannot leak an unhandled rejection
				reject(new InfraRetry("container-never-started", { cause: err, reason: "container-never-started" }));
			});
			child.on("close", async (code) => {
				const aborted = signal?.aborted === true; // capture BEFORE the await
				// A rejecting sink.close is swallowed so a misbehaving sink cannot hang the run; turns/tokens fall back to null.
				let turns = null;
				let tokens = null;
				try {
					({ turns, tokens } = await sink.close());
				} catch {
					turns = null;
					tokens = null;
				}
				resolve(aborted ? { code: code ?? 137, aborted: true, turns, tokens } : { code: code ?? 1, aborted: false, turns, tokens });
			});
		});
	};
}
