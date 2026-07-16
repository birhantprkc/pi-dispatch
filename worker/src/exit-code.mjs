/**
 * INT-RUNNER-EXIT-CODE-PROTOCOL, worker side.
 *
 * The container's exit code is the ONLY channel telling "the agent ran and concluded something"
 * from "the container died". The worker turns that into BullMQ's throw-vs-return, which IS
 * CONST-RETRY-INFRA-ONLY: a thrown processor is retried, a returned one is not.
 */
export const EXIT_COMPLETED = 0; // agent ran, INCLUDING "I cannot fix this" -- a determinate success
export const EXIT_INFRA = 1; // container died, network, provider 5xx/429 -- the only retryable class
export const EXIT_POLICY = 2; // budget/turn cap/config -- a determinate refusal, never retried

/**
 * Decide whether the processor should RETURN (BullMQ records success, no retry) or THROW (BullMQ
 * retries per `attempts`). Returns `{ retry }`; the caller returns on false and throws on true.
 *
 * Only exit 1 is retryable. 0 and 2 are both determinate outcomes -- the agent's verdict (or our
 * own budget refusal) is the product, not a failure to paper over by paying for it again. An
 * unknown code is treated as infra: a runner that exits with something we do not recognise is a
 * runner we cannot reason about, and retrying-then-alerting beats silently accepting it as done.
 */
export function decideRetry(exitCode) {
	switch (exitCode) {
		case EXIT_COMPLETED:
			return { retry: false, outcome: "completed" };
		case EXIT_POLICY:
			return { retry: false, outcome: "policy" };
		case EXIT_INFRA:
			return { retry: true, outcome: "infra" };
		default:
			return { retry: true, outcome: `unknown-exit-${exitCode}` };
	}
}
