import assert from "node:assert/strict";
import { test } from "node:test";
import {
	classifyStopReason,
	classifyThrow,
	EXIT_COMPLETED,
	EXIT_INFRA,
	EXIT_POLICY,
	STOP_REASONS,
} from "../src/outcome.mjs";

// INT-RUNNER-EXIT-CODE-PROTOCOL. These two blocks are deliberately a PAIR: each catches
// the failure the other's implementation causes. A try/catch-only runner exits 0 on every
// provider failure; a stopReason-only runner crashes on a missing API key and exits 1,
// which the protocol defines as retryable -- so the queue pays to retry a job that can
// never succeed. Both were live in the spec at different times. Both were wrong.

test("provider error exits 1, NOT 0 -- the try/catch-only trap", () => {
	const outcome = classifyStopReason({ stopReason: "error", errorMessage: "429 rate limited" });
	assert.equal(outcome.code, EXIT_INFRA);
	assert.notEqual(outcome.code, EXIT_COMPLETED, "a 429 recorded as success is a job that did nothing");
});

test("missing API key exits 2, NOT 1 -- the stopReason-only trap", () => {
	// pi's own JSDoc: "@throws Error if no model selected or no API key available".
	const outcome = classifyThrow(new Error("No API key found for provider anthropic"));
	assert.equal(outcome.code, EXIT_POLICY);
	assert.notEqual(outcome.code, EXIT_INFRA, "retrying a missing key pays to rediscover it");
});

test("no model selected is config, not infra", () => {
	assert.equal(classifyThrow(new Error("No model selected")).code, EXIT_POLICY);
});

test("'Agent is already processing' is our bug -- infra, retryable", () => {
	// Thrown by Agent.runWithLifecycle BEFORE its own try block, so it escapes to us.
	assert.equal(classifyThrow(new Error("Agent is already processing.")).code, EXIT_INFRA);
});

test("turn-budget abort exits 2, NOT 0", () => {
	assert.equal(classifyStopReason({ stopReason: "aborted" }).code, EXIT_POLICY);
});

test("'can't fix' is a SUCCESS -- exit 0, never retried", () => {
	// CONST-RETRY-INFRA-ONLY. The agent's verdict is the product, not the failure.
	assert.equal(classifyStopReason({ stopReason: "stop" }).code, EXIT_COMPLETED);
});

test("'length' exits 0 but is flagged truncated -- not hidden by a default branch", () => {
	const outcome = classifyStopReason({ stopReason: "length" });
	assert.equal(outcome.code, EXIT_COMPLETED);
	assert.equal(outcome.truncated, true, "a truncated run must be visible, not silently 'success'");
});

test("every one of pi's five stopReasons is handled explicitly", () => {
	// packages/ai/src/types.ts:380. If pi's union grows, this fails rather than guessing.
	assert.deepEqual(STOP_REASONS, ["stop", "length", "toolUse", "error", "aborted"]);
	for (const stopReason of STOP_REASONS) {
		const outcome = classifyStopReason({ stopReason });
		assert.ok(!String(outcome.reason).startsWith("unknown-"), `${stopReason} fell through`);
	}
});

test("an unknown stopReason is infra, not assumed benign", () => {
	// CONST-PI-VERSION-PINNED: upstream moves silently. Do not guess a new value is fine.
	const outcome = classifyStopReason({ stopReason: "somethingNew" });
	assert.equal(outcome.code, EXIT_INFRA);
});

test("no terminal message is infra -- absence of evidence is not success", () => {
	assert.equal(classifyStopReason(undefined).code, EXIT_INFRA);
});
