import { releaseBudget, reserveBudget } from "./budget.mjs";
import { configError } from "./config.mjs";
import { EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY } from "./exit-code.mjs";

/**
 * The job orchestration. Deliberately a pure-ish function over INJECTED side-effecting deps, so
 * the money-safety ORDER can be tested without GitHub, Docker, or Redis.
 *
 * The order is the contract, and every step before `runContainer` must be free of provider spend:
 *
 *   1. mint a scoped token (GitHub jobs)          -- CONST-TOKEN-SCOPED-PER-JOB
 *   2. REFUSE an unprotected default branch       -- REQ-BRANCH-PROTECTION-PRECONDITION
 *   3. resolve the default-branch SHA (fresh API), clone at it, materialise .pi/, write the prompt
 *   4. reserve a budget slot                      -- CONST-BUDGET-BEFORE-TOKENS
 *   5. ONLY NOW run the container (the only step that spends provider tokens)
 *   6. map the container exit code to retry-vs-success
 *
 * Budget is reserved as late as possible but strictly before the container, so a refusal from an
 * earlier free gate (unprotected repo, clone failure) never consumes a daily slot. The container
 * is the only thing that spends money, so "before tokens" means "before this line".
 *
 * Returns a result object on a non-retryable outcome; THROWS on a retryable (infra) one so BullMQ
 * retries per `attempts`. The caller (the BullMQ processor) turns the thrown/returned distinction
 * into the queue's retry behaviour -- that is INT-RUNNER-EXIT-CODE-PROTOCOL.
 */
export async function runJob(job, deps) {
	const {
		redis,
		cap,
		mintToken, // (repo) => scoped short-lived token | null for local-folder jobs
		isDefaultBranchProtected, // (repo, token) => boolean
		prepareWorkspace, // (job, token) => { workspaceDir, jobDir }  (clone+materialise+prompt)
		// runContainer({ job, token, prepared, name, signal }) => { code, aborted, turns }. It MUST honour
		// `signal`: stop the container on abort, and reject/exit promptly if `signal.aborted` is already
		// true at entry (the timeout can fire during a slow prepare). The wiring injects name + signal.
		runContainer,
		cleanup, // (dirs) => void
		comment, // (job, text) => void   (issue status; no-op for local jobs)
		log = () => {},
		// The outbox chain collector (INT-OUTBOX-CONTRACT). No-op default so a job whose wiring omits it --
		// or a github job with no /outbox -- chains nothing. It NEVER throws (outbox.mjs), so its counts are
		// additive telemetry that can never flip the parent's completed outcome (CONST-RETRY-INFRA-ONLY).
		collectChain = async () => ({ enqueued: 0, refused: 0 }),
		now = new Date(),
	} = deps;

	const isGitHub = job.kind === "github";
	let token = null;
	let prepared = null;
	let reserved = false;

	try {
		if (isGitHub) {
			token = await mintToken(job.repo);

			// Defense-in-depth at the DI seam: mintToken is injected, so we cannot assume it routed
			// through get-token's own empty-token guard. An empty credential here would reach
			// env-allowlist's `if (githubToken)` as a falsy value -> GITHUB_TOKEN omitted -> an
			// anonymous paid run. Refuse before reserveBudget so a bad token burns no cap slot.
			if (isGitHub && (typeof token !== "string" || token.trim() === "")) {
				throw configError("mintToken returned an empty credential");
			}

			// REQ-BRANCH-PROTECTION-PRECONDITION. The agent's token can merge (contents:write covers
			// push AND merge), so branch protection is the only technical barrier to a self-merge.
			// Refuse before spending anything.
			if (!(await isDefaultBranchProtected(job.repo, token))) {
				await comment(job, "Refused: the default branch is not protected. See SECURITY.md.");
				log("refused_unprotected", { repo: job.repo });
				// exitCode/turns null: refused pre-container, so no container exit or turn count exists.
				return { outcome: "policy", reason: "unprotected-branch", exitCode: null, turns: null, budgetReserved: false }; // return => not retried
			}
		}

		prepared = await prepareWorkspace(job, token); // resolves SHA, clones, materialises .pi/, writes prompt

		// A determinate prepare refusal (e.g. sha-gone: the default branch advanced past the resolved
		// tip) is POLICY -- return before reserveBudget so it burns no cap slot and is never retried.
		// Mirrors the branch-protection policy return above.
		if (prepared?.outcome === "policy") {
			return prepared;
		}

		// Budget last-but-before-container. A refusal here spends nothing (no container starts).
		const budget = await reserveBudget(redis, { cap, now });
		reserved = true;
		if (!budget.allowed) {
			await comment(job, `Over the daily budget cap (${budget.cap}). Not run.`);
			log("over_budget", { reserved: budget.reserved, cap: budget.cap });
			// budgetReserved true: the slot is reserved above and kept (an over-cap reservation still counts).
			return { outcome: "policy", reason: "over-budget", exitCode: null, turns: null, budgetReserved: true }; // return => not retried
		}

		const { code, aborted, turns } = await runContainer({ job, token, prepared });
		log("container_exit", { exitCode: code, aborted });

		// A WORKER-initiated stop (30-min timeout via cancelJob, or graceful-shutdown docker stop) kills
		// the container -> exit 143/137. That is our decision, not an infra fault: it is POLICY and must
		// NOT retry, or a wedged job re-runs into a second PR / double spend. Keyed on the abort FLAG,
		// not the code -- an unbidden 137 (kernel OOM) carries `aborted: false`, falls to the switch, and
		// stays infra-retryable.
		// exitCode/turns carry the container's own exit and turn count; budgetReserved true post-reserve.
		if (aborted) return { outcome: "policy", reason: "worker-abort", exitCode: code, turns, budgetReserved: true };

		switch (code) {
			case EXIT_COMPLETED: {
				// The SOLE chain-collection point. Read the completed parent's /outbox and enqueue children
				// BEFORE the `finally` deletes jobDir -- the await resolves inside this case, so the read
				// finishes before control leaves to cleanup. NOT reached on any other branch (policy, abort,
				// over-budget, infra): an InfraRetry job is retried, so chaining there would double-enqueue.
				// collectChain never throws; chainEnqueued/chainRefused are additive telemetry only.
				const chain = await collectChain({ job, prepared });
				return { outcome: "completed", exitCode: code, turns, budgetReserved: true, chainEnqueued: chain.enqueued, chainRefused: chain.refused };
			}
			case EXIT_POLICY:
				return { outcome: "policy", reason: "runner-policy", exitCode: code, turns, budgetReserved: true };
			case EXIT_INFRA:
				throw new InfraRetry(`infra failure, container exit ${code}`, { exitCode: code, turns });
			default:
				throw new InfraRetry(`unknown container exit ${code}`, { exitCode: code, turns });
		}
	} catch (e) {
		// A spawn fault (docker daemon down / binary missing) reserved a slot but never started a
		// container, so nothing was spent -- give the slot back before the retry. Every other throw
		// here (exit-1 infra, unknown exit) means the container ran and legitimately spent its slot,
		// so `reason` gates the release to the never-started case only. Guarded on `reserved` and run
		// once per invocation; a BullMQ retry reserves afresh, so this cannot double-release.
		// budgetReserved reflects whether a slot stays spent: false when never-started refunds below,
		// true for a real container that ran and spent (exit-1 infra / unknown exit).
		if (e instanceof InfraRetry) e.budgetReserved = reserved && e.reason !== "container-never-started";
		if (reserved && e instanceof InfraRetry && e.reason === "container-never-started") {
			await releaseBudget(redis, { now });
		}
		throw e;
	} finally {
		if (prepared) await cleanup(prepared).catch(() => {});
	}
}

/** Thrown for the retryable (infra) class only. The BullMQ processor lets this propagate to retry. */
export class InfraRetry extends Error {
	constructor(message, { cause, reason, exitCode, turns, budgetReserved } = {}) {
		super(message, cause ? { cause } : undefined);
		this.name = "InfraRetry";
		this.piDispatchRetry = true;
		this.reason = reason ?? message;
		this.exitCode = exitCode ?? null;
		this.turns = turns ?? null;
		this.budgetReserved = budgetReserved ?? null;
	}
}

export { EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY };
