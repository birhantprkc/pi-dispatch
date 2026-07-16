/**
 * INT-RUNNER-EXIT-CODE-PROTOCOL.
 *
 * The exit code IS the mechanism CONST-RETRY-INFRA-ONLY is implemented by: it is the
 * worker's only channel to tell "the agent ran and said no" from "the container died".
 */
export const EXIT_COMPLETED = 0; // agent ran -- INCLUDING concluding "I cannot fix this"
export const EXIT_INFRA = 1; // retryable: provider 5xx/429, network, our own bug
export const EXIT_POLICY = 2; // not retried: turn budget, cap, config error

/** packages/ai/src/types.ts:380 -- all five. Enumerated so "length" cannot hide in a default branch. */
export const STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted"];

/**
 * Classify a preflight throw.
 *
 * pi DOES throw -- its own JSDoc says so -- but only before the agent loop starts:
 * no model selected, no API key, missing streamingBehavior, an extension error, or
 * "Agent is already processing." Inside the loop it never throws; failures arrive as
 * a stopReason instead. Both mechanisms are needed and they cover disjoint sets.
 *
 * The distinction that matters here is retryable-vs-not. A missing API key is a
 * deployment error: retrying spends nothing but proves nothing, and BullMQ would keep
 * paying to rediscover it. That is EXIT_POLICY, not EXIT_INFRA.
 */
export function classifyThrow(error) {
	const message = error instanceof Error ? error.message : String(error);

	// Config errors. Retrying cannot fix these, so do not let the queue try.
	if (/no model|model not|no api key|no.*credential|not authenticated/i.test(message)) {
		return { code: EXIT_POLICY, reason: "config", message };
	}

	// Everything else -- including "Agent is already processing." -- is our bug or infra.
	return { code: EXIT_INFRA, reason: "infra", message };
}

/**
 * Map the terminal assistant message's stopReason to an exit code.
 *
 * `session.prompt()` returns Promise<void>, so there is nothing to inspect; the message
 * arrives via subscribe(). A try/catch-only runner sees a clean resolve on a provider
 * 429 and exits 0 -- the queue records success, never retries, and the job did nothing.
 *
 * `terminal` is undefined when no assistant message was ever seen (e.g. the agent loop
 * never produced one). That is not success -- we have no evidence the agent ran.
 */
export function classifyStopReason(terminal) {
	if (!terminal) {
		return { code: EXIT_INFRA, reason: "no-terminal-message" };
	}

	switch (terminal.stopReason) {
		case "aborted":
			// Our turn budget or the timeout fired. Determinate: do not retry.
			return { code: EXIT_POLICY, reason: "aborted" };

		case "error":
			// Provider 5xx/429/network. Retryable -- this is what attempts: 2 is for.
			return { code: EXIT_INFRA, reason: "error", message: terminal.errorMessage };

		case "length":
			// Truncated at the token limit. The agent ran and produced work, so this is
			// NOT a failure -- but it is not a clean finish either, and a default-to-0
			// branch would hide it entirely. Succeed loudly.
			return { code: EXIT_COMPLETED, reason: "length", truncated: true };

		case "stop":
		case "toolUse":
			return { code: EXIT_COMPLETED, reason: terminal.stopReason };

		default:
			// An unknown stopReason means pi's union grew under our pin. Do not guess it
			// is benign: CONST-PI-VERSION-PINNED exists because upstream moves silently.
			return { code: EXIT_INFRA, reason: `unknown-stop-reason:${terminal.stopReason}` };
	}
}
