/**
 * REQ-RUNNER-TURN-BUDGET.
 *
 * pi has NO max-turns, step limit, or iteration cap. A repo-wide search for
 * maxTurns|maxSteps|stepLimit|turnLimit returns zero hits; the agent loop is an outer
 * `while (true)` wrapping an inner `while (hasMoreToolCalls || pendingMessages.length)`,
 * bounded only by an AbortSignal. session.abort() is the only control surface there is.
 *
 * REQ-JOB-TIMEOUT-30M does not substitute: it bounds wall-clock. An agent can burn 200
 * turns in 29 minutes and exit "successfully" having spent the entire money budget.
 * Time and spend are different axes.
 *
 * Negative fact: this module exists because of an upstream absence. If pi ships a turn
 * limit, delete this rather than carrying it forever as unexplained ballast.
 */

/**
 * Attach a turn counter that aborts at `maxTurns`.
 *
 * Two things here are not stylistic:
 *
 * 1. The listener is SYNCHRONOUS. `_emit` is a plain `for (const l of listeners) l(event)`
 *    with no await, so an async listener is fire-and-forget: the next turn can start
 *    before an awaiting budget check has run, and the budget silently overshoots.
 *
 * 2. `void session.abort()`. abort() returns a promise (it awaits waitForIdle), but
 *    Agent.abort() flips the AbortController synchronously before that await -- so the
 *    signal is set the instant we call it. Awaiting here would mean awaiting inside an
 *    unawaited listener, which is (1) again. Fire it and return.
 *
 * The event is the bare AgentEvent `{ type: "turn_start" }` -- it carries NO turnIndex.
 * The indexed TurnStartEvent exists only on the extension bus, which subscribe() is not.
 * So we count ourselves.
 */
export function attachTurnBudget(session, maxTurns, { onAbort } = {}) {
	if (!Number.isInteger(maxTurns) || maxTurns < 1) {
		throw new Error(`invalid PI_MAX_TURNS: ${maxTurns}`);
	}

	const state = { turns: 0, aborted: false };

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "turn_start") {
			state.turns += 1;
			if (state.turns > maxTurns && !state.aborted) {
				state.aborted = true;
				onAbort?.(state.turns);
				void session.abort();
			}
		}
	});

	return { state, unsubscribe };
}
