import assert from "node:assert/strict";
import { test } from "node:test";
import { attachTurnBudget } from "../src/turn-budget.mjs";

/**
 * A stand-in for AgentSession that reproduces the two properties the budget depends on:
 * `_emit` is a synchronous unawaited loop, and abort() flips its signal synchronously
 * before any await. Both verified at agent-session.ts:527-531 and agent.ts:310-312.
 */
function fakeSession() {
	const listeners = [];
	const session = {
		aborted: false,
		abortCalls: 0,
		subscribe(listener) {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		async abort() {
			session.abortCalls += 1;
			session.aborted = true; // sync, before any await -- as pi does
			await Promise.resolve();
		},
		emit(event) {
			for (const l of listeners) l(event); // sync, unawaited -- as pi does
		},
	};
	return session;
}

test("aborts once the turn count exceeds the maximum", () => {
	const session = fakeSession();
	const budget = attachTurnBudget(session, 3);

	for (let i = 0; i < 3; i++) session.emit({ type: "turn_start" });
	assert.equal(session.aborted, false, "must not abort at or below the budget");

	session.emit({ type: "turn_start" }); // the 4th
	assert.equal(session.aborted, true);
	assert.equal(budget.state.aborted, true);
	assert.equal(budget.state.turns, 4);
});

test("abort fires exactly once even if more turns arrive", () => {
	const session = fakeSession();
	attachTurnBudget(session, 1);
	for (let i = 0; i < 5; i++) session.emit({ type: "turn_start" });
	assert.equal(session.abortCalls, 1);
});

test("the signal is set synchronously inside the listener", () => {
	// The listener is void-typed and unawaited; if abort only took effect on a later tick,
	// pi could start another paid turn before it landed. This asserts it does not.
	const session = fakeSession();
	attachTurnBudget(session, 0 + 1);
	session.emit({ type: "turn_start" });
	session.emit({ type: "turn_start" });
	assert.equal(session.aborted, true, "abort must land before emit() returns");
});

test("counts turn_start only -- turn_end must not double-count", () => {
	const session = fakeSession();
	const budget = attachTurnBudget(session, 10);
	session.emit({ type: "turn_start" });
	session.emit({ type: "turn_end", message: {} });
	session.emit({ type: "message_update", message: {} });
	assert.equal(budget.state.turns, 1);
});

test("does not rely on turnIndex -- subscribe() delivers a bare turn_start", () => {
	// packages/agent/src/types.ts:420 is `| { type: "turn_start" }` with no fields. The
	// indexed TurnStartEvent exists only on the extension bus. Reading event.turnIndex here
	// would be undefined and the budget would never fire.
	const session = fakeSession();
	const budget = attachTurnBudget(session, 2);
	for (let i = 0; i < 3; i++) session.emit({ type: "turn_start" }); // no turnIndex present
	assert.equal(budget.state.aborted, true, "budget must work off its own counter");
});

test("rejects a nonsensical budget rather than running unbounded", () => {
	for (const bad of [0, -1, 1.5, Number.NaN, undefined]) {
		assert.throws(() => attachTurnBudget(fakeSession(), bad), /invalid PI_MAX_TURNS/);
	}
});
