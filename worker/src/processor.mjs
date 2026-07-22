import { checkTokenCap, recordTokenSpend, releaseBudget, reserveBudget } from "./budget.mjs";
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
		caps, // { day, week, month }; week/month null when that window is disabled (REQ-SPEND-CAPS-MULTI-WINDOW)
		softHoldPct, // int 1-99 or null; the soft-hold band applied to every active window
		tokenCap = null, // int or null; the daily TOKEN cap (issue #25). Check-AFTER, so it gates the NEXT job on prior spend
		recordSpend = recordTokenSpend, // injected so the post-container INCRBY is testable/stubbable
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
				// exitCode/turns/tokens null: refused pre-container, so no container exit, turn, or token count exists.
				return { outcome: "policy", reason: "unprotected-branch", exitCode: null, turns: null, tokens: null, budgetReserved: false }; // return => not retried
			}
		}

		prepared = await prepareWorkspace(job, token); // resolves SHA, clones, materialises .pi/, writes prompt

		// A determinate prepare refusal (e.g. sha-gone: the default branch advanced past the resolved
		// tip) is POLICY -- return before reserveBudget so it burns no cap slot and is never retried.
		// Mirrors the branch-protection policy return above.
		if (prepared?.outcome === "policy") {
			return prepared;
		}

		// Daily TOKEN cap (issue #25): the deliberate check-AFTER control. Token cost is only known
		// post-run, so this cannot check-and-increment before the spend the way the job-count cap does
		// (CONST-BUDGET-BEFORE-TOKENS). It is a read-only GET of prior jobs' recorded spend -- it consumes
		// nothing, so it precedes reserveBudget's INCR and a refusal here burns no job-count slot. It can
		// only stop the NEXT job once the day's accumulated spend has reached the cap; the actual INCRBY
		// happens post-container via recordSpend. Reported before the job-count cap only because both are
		// spend gates; the more-actionable branch-protection precondition is still reported first above.
		const tokenGate = await checkTokenCap(redis, { cap: tokenCap, now });
		if (!tokenGate.allowed) {
			await comment(job, `Over the daily token cap (${tokenGate.spent}/${tokenGate.cap} tokens). Not run.`);
			log("over_token_budget", { spent: tokenGate.spent, cap: tokenGate.cap });
			// budgetReserved false: refused before reserveBudget, so no job-count slot was consumed.
			return { outcome: "policy", reason: "daily-token-cap", exitCode: null, turns: null, tokens: null, budgetReserved: false }; // return => not retried
		}

		// Budget last-but-before-container. A refusal here spends nothing (no container starts). Reserves across
		// every active window (day + optional week/month) and the soft-hold band in one atomic pass.
		const budget = await reserveBudget(redis, { caps, softHoldPct, now });
		reserved = true;
		if (!budget.allowed) {
			const w = budget.blockedWindow;
			const win = budget.windows[w];
			if (budget.reason === "soft-hold") {
				await comment(job, `Soft-hold: ${w} spend ${win.reserved}/${win.cap} is inside the ${softHoldPct}% hold band. New starts paused; not run.`);
				log("soft_hold", { window: w, reserved: win.reserved, cap: win.cap, pct: softHoldPct });
			} else {
				await comment(job, `Over the ${w} budget cap (${win.cap}). Not run.`);
				log("over_budget", { window: w, reserved: win.reserved, cap: win.cap });
			}
			// budgetReserved true: the slot is reserved above and kept (a refused reservation still counts). Both
			// over-budget and soft-hold are POLICY, RETURNED (not retried) -- the agent never ran.
			return { outcome: "policy", reason: budget.reason, exitCode: null, turns: null, tokens: null, budgetReserved: true }; // return => not retried
		}

		const { code, aborted, turns, tokens } = await runContainer({ job, token, prepared });
		log("container_exit", { exitCode: code, aborted });

		// Record token spend post-run (the check-AFTER half of the lagging token cap). The container ran,
		// so it spent real tokens on EVERY path that reaches here -- abort, completed, policy, AND the infra
		// throws below (an exit-1 container still spent before failing). Record before classifying so all of
		// them are accounted. Only when the cap is enabled (nothing reads the counter otherwise) and the run
		// reported a positive total. NEVER throws: money is already spent, so a Redis blip here must not turn
		// a completed paid job into a failure (mirrors the sink/comment/cleanup fault-isolation posture).
		const tokensSpent = tokens?.total ?? 0;
		if (tokenCap !== null && tokenCap !== undefined && tokensSpent > 0) {
			await recordSpend(redis, tokensSpent, { now }).catch((err) => log("token_spend_error", { reason: err?.message }));
		}

		// A WORKER-initiated stop (30-min timeout via cancelJob, or graceful-shutdown docker stop) kills
		// the container -> exit 143/137. That is our decision, not an infra fault: it is POLICY and must
		// NOT retry, or a wedged job re-runs into a second PR / double spend. Keyed on the abort FLAG,
		// not the code -- an unbidden 137 (kernel OOM) carries `aborted: false`, falls to the switch, and
		// stays infra-retryable.
		// exitCode/turns/tokens carry the container's own exit, turn count, and usage totals; budgetReserved true post-reserve.
		if (aborted) return { outcome: "policy", reason: "worker-abort", exitCode: code, turns, tokens, budgetReserved: true };

		switch (code) {
			case EXIT_COMPLETED: {
				// The SOLE chain-collection point. Read the completed parent's /outbox and enqueue children
				// BEFORE the `finally` deletes jobDir -- the await resolves inside this case, so the read
				// finishes before control leaves to cleanup. NOT reached on any other branch (policy, abort,
				// over-budget, infra): an InfraRetry job is retried, so chaining there would double-enqueue.
				// collectChain never throws; chainEnqueued/chainRefused are additive telemetry only.
				const chain = await collectChain({ job, prepared });
				return { outcome: "completed", exitCode: code, turns, tokens, budgetReserved: true, chainEnqueued: chain.enqueued, chainRefused: chain.refused };
			}
			case EXIT_POLICY:
				return { outcome: "policy", reason: "runner-policy", exitCode: code, turns, tokens, budgetReserved: true };
			case EXIT_INFRA:
				throw new InfraRetry(`infra failure, container exit ${code}`, { exitCode: code, turns, tokens });
			default:
				throw new InfraRetry(`unknown container exit ${code}`, { exitCode: code, turns, tokens });
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
			await releaseBudget(redis, { caps, now });
		}
		throw e;
	} finally {
		if (prepared) await cleanup(prepared).catch(() => {});
	}
}

/** Thrown for the retryable (infra) class only. The BullMQ processor lets this propagate to retry. */
export class InfraRetry extends Error {
	constructor(message, { cause, reason, exitCode, turns, tokens, budgetReserved } = {}) {
		super(message, cause ? { cause } : undefined);
		this.name = "InfraRetry";
		this.piDispatchRetry = true;
		this.reason = reason ?? message;
		this.exitCode = exitCode ?? null;
		this.turns = turns ?? null;
		this.tokens = tokens ?? null;
		this.budgetReserved = budgetReserved ?? null;
	}
}

export { EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY };
