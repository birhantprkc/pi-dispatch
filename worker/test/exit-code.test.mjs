import assert from "node:assert/strict";
import { test } from "node:test";
import { decideRetry, EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY } from "../src/exit-code.mjs";

// INT-RUNNER-EXIT-CODE-PROTOCOL / CONST-RETRY-INFRA-ONLY. The whole point: only infra retries.

test("exit 0 (agent ran, incl. 'can't fix') is success, NOT retried", () => {
	assert.deepEqual(decideRetry(EXIT_COMPLETED), { retry: false, outcome: "completed" });
});

test("exit 2 (budget/policy) is determinate, NOT retried -- paying twice for a refusal is the bug", () => {
	assert.equal(decideRetry(EXIT_POLICY).retry, false);
});

test("exit 1 (infra) is the ONLY retryable class", () => {
	assert.equal(decideRetry(EXIT_INFRA).retry, true);
});

test("an unknown exit code is retried-then-visible, not silently accepted as done", () => {
	// A runner we can't reason about must not be recorded as a clean success.
	const d = decideRetry(137); // SIGKILL, e.g. OOM
	assert.equal(d.retry, true);
	assert.match(d.outcome, /unknown-exit-137/);
});
