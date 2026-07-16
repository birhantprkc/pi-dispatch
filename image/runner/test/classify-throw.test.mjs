import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyThrow, configError, EXIT_INFRA, EXIT_POLICY } from "../src/outcome.mjs";

// Errors WE raise carry their verdict as a tag; pi's errors are matched by vocabulary. The two
// paths are deliberately separate: tagging what we control is robust, and a regex is the only
// tool available for strings pi controls.

test("a tagged config error is honoured directly (exit 2), regardless of its text", () => {
	// This is how a bad PI_MAX_TURNS or a missing /job/prompt.md reaches exit 2 -- configError()
	// tags it, and classifyThrow trusts the tag over any pattern match.
	assert.equal(classifyThrow(configError("invalid PI_MAX_TURNS: NaN")).code, EXIT_POLICY);
	assert.equal(classifyThrow(configError("missing job input: /job/prompt.md")).code, EXIT_POLICY);
	assert.equal(classifyThrow(configError("unknown model: anthropic/x")).code, EXIT_POLICY);
});

test("pi's own preflight vocabulary is exit 2 via the regex", () => {
	// These strings are pi's, thrown from inside its SDK, so we cannot tag them -- match them.
	for (const message of [
		"No model selected",
		"No API key found for provider anthropic",
		"provider anthropic is not authenticated",
	]) {
		assert.equal(classifyThrow(new Error(message)).code, EXIT_POLICY, message);
	}
});

test("genuine infra / our-bug errors stay retryable (exit 1)", () => {
	for (const message of ["Agent is already processing.", "ECONNRESET", "socket hang up"]) {
		assert.equal(classifyThrow(new Error(message)).code, EXIT_INFRA, message);
	}
});

test("an untagged error with no pi vocabulary is infra -- we do not guess it is config", () => {
	// A plain "missing required env" string with NO tag must not be assumed config: only the tag
	// or pi's known vocabulary earns exit 2. In practice these always arrive tagged; this pins the
	// conservative default for anything that does not.
	assert.equal(classifyThrow(new Error("something unexpected happened")).code, EXIT_INFRA);
});

test("a non-Error throw is classified, not crashed on", () => {
	assert.equal(classifyThrow("bare string").code, EXIT_INFRA);
	assert.equal(classifyThrow(undefined).code, EXIT_INFRA);
	assert.equal(classifyThrow(null).code, EXIT_INFRA);
});
