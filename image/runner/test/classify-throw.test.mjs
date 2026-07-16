import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyThrow, EXIT_INFRA, EXIT_POLICY } from "../src/outcome.mjs";

// Retrying a deterministic config error pays to rediscover it. Every string a real
// deployment throws before the agent loop must land on exit 2, not the retryable 1.
test("config errors are exit 2 (not retried), not exit 1", () => {
	for (const message of [
		"missing required env: PI_PROVIDER",
		"missing required env: PI_MODEL",
		"No model selected",
		"No API key found for provider anthropic",
		"provider anthropic is not authenticated",
	]) {
		assert.equal(classifyThrow(new Error(message)).code, EXIT_POLICY, message);
	}
});

test("genuine infra/our-bug errors stay retryable (exit 1)", () => {
	for (const message of ["Agent is already processing.", "ECONNRESET", "socket hang up"]) {
		assert.equal(classifyThrow(new Error(message)).code, EXIT_INFRA, message);
	}
});

test("a non-Error throw is classified, not crashed on", () => {
	assert.equal(classifyThrow("bare string").code, EXIT_INFRA);
	assert.equal(classifyThrow(undefined).code, EXIT_INFRA);
});
