import { reserveBudget } from "./budget.mjs";
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
		mintToken, // (repo) => scoped 1h token  | null for local-folder jobs
		isDefaultBranchProtected, // (repo, token) => boolean
		prepareWorkspace, // (job, token) => { workspaceDir, jobDir }  (clone+materialise+prompt)
		// runContainer({ job, token, prepared, name, signal }) => exitCode. It MUST honour `signal`:
		// stop the container on abort, and reject/exit promptly if `signal.aborted` is already true
		// at entry (the timeout can fire during a slow prepare). The wiring injects name + signal.
		runContainer,
		cleanup, // (dirs) => void
		comment, // (job, text) => void   (issue status; no-op for local jobs)
		log = () => {},
		now = new Date(),
	} = deps;

	const isGitHub = job.kind === "github";
	let token = null;
	let prepared = null;
	let reserved = false;

	try {
		if (isGitHub) {
			token = await mintToken(job.repo);

			// REQ-BRANCH-PROTECTION-PRECONDITION. The agent's token can merge (contents:write covers
			// push AND merge), so branch protection is the only technical barrier to a self-merge.
			// Refuse before spending anything.
			if (!(await isDefaultBranchProtected(job.repo, token))) {
				await comment(job, "Refused: the default branch is not protected. See SECURITY.md.");
				log("refused_unprotected", { repo: job.repo });
				return { outcome: "policy", reason: "unprotected-branch" }; // return => not retried
			}
		}

		prepared = await prepareWorkspace(job, token); // resolves SHA, clones, materialises .pi/, writes prompt

		// Budget last-but-before-container. A refusal here spends nothing (no container starts).
		const budget = await reserveBudget(redis, { cap, now });
		reserved = true;
		if (!budget.allowed) {
			await comment(job, `Over the daily budget cap (${budget.cap}). Not run.`);
			log("over_budget", { reserved: budget.reserved, cap: budget.cap });
			return { outcome: "policy", reason: "over-budget" }; // return => not retried
		}

		const exitCode = await runContainer({ job, token, prepared });
		log("container_exit", { exitCode });

		switch (exitCode) {
			case EXIT_COMPLETED:
				return { outcome: "completed" };
			case EXIT_POLICY:
				return { outcome: "policy", reason: "runner-policy" };
			case EXIT_INFRA:
				throw new InfraRetry(`infra failure, container exit ${exitCode}`);
			default:
				throw new InfraRetry(`unknown container exit ${exitCode}`);
		}
	} finally {
		if (prepared) await cleanup(prepared).catch(() => {});
	}
}

/** Thrown for the retryable (infra) class only. The BullMQ processor lets this propagate to retry. */
export class InfraRetry extends Error {
	constructor(message) {
		super(message);
		this.name = "InfraRetry";
		this.piDispatchRetry = true;
	}
}

export { EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY };
