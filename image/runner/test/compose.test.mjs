import assert from "node:assert/strict";
import { test } from "node:test";
import { captureTerminal, decideExit, EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY } from "../src/outcome.mjs";

// The wiring in run-job.mjs used to be untested -- the composition of budget + terminal capture +
// classification is exactly where this project's documented traps live. These test the two pure
// pieces that composition rests on.

test("captureTerminal reads agent_end.messages.at(-1) -- agent_end has no `message` field", () => {
	// Verified against agent-session.d.ts@0.80.7: agent_end carries messages[], not message.
	const assistant = { role: "assistant", stopReason: "stop" };
	const terminal = captureTerminal(undefined, { type: "agent_end", messages: [{ role: "user" }, assistant] });
	assert.equal(terminal, assistant);
});

test("captureTerminal reads turn_end.message", () => {
	const msg = { role: "assistant", stopReason: "toolUse" };
	assert.equal(captureTerminal(undefined, { type: "turn_end", message: msg }), msg);
});

test("captureTerminal ignores unrelated events and preserves the prior value", () => {
	const prior = { role: "assistant", stopReason: "stop" };
	assert.equal(captureTerminal(prior, { type: "message_update", message: {} }), prior);
	assert.equal(captureTerminal(prior, { type: "auto_retry_start" }), prior);
});

test("decideExit: a blown budget wins over stopReason, always", () => {
	// Even if the terminal message says "stop" (success), an abort we triggered is exit 2. Checking
	// budget FIRST means a future change to how abort surfaces as a stopReason cannot turn a blown
	// budget into a silent success.
	const outcome = decideExit({ budgetAborted: true, budgetTurns: 41, terminal: { stopReason: "stop" } });
	assert.equal(outcome.code, EXIT_POLICY);
	assert.equal(outcome.reason, "turn_budget");
	assert.equal(outcome.turns, 41);
});

test("decideExit: without an abort, the stopReason decides", () => {
	assert.equal(decideExit({ budgetAborted: false, terminal: { stopReason: "stop" } }).code, EXIT_COMPLETED);
	assert.equal(decideExit({ budgetAborted: false, terminal: { stopReason: "error" } }).code, EXIT_INFRA);
});

test("decideExit: no terminal message and no abort is infra, not success", () => {
	// Absence of evidence that the agent ran is not success.
	assert.equal(decideExit({ budgetAborted: false, terminal: undefined }).code, EXIT_INFRA);
});
