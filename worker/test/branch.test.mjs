import assert from "node:assert/strict";
import { test } from "node:test";
import { issueBranch, normalizeNumber } from "../src/branch.mjs";
import { buildGithubPrompt } from "../src/github-prompt.mjs";
import { buildGitLabPrompt } from "../src/gitlab-prompt.mjs";

test("the branch derives from the number alone, so a re-run converges on the same branch", () => {
	assert.equal(issueBranch(7), "pi/issue-7");
	// The shared normaliser COERCES, so a numeric string lands on the same branch -- which is the point:
	// the prompt and the session key must not disagree because one of them was handed a string.
	assert.equal(issueBranch("7"), "pi/issue-7");
});

test("a number that is not a positive integer refuses rather than minting a garbage branch", () => {
	for (const number of [0, -1, 1.5, "abc", undefined, null, "", "../../etc/passwd"]) {
		assert.throws(
			() => issueBranch(number),
			(e) => e.piDispatchConfig === true,
			`number ${JSON.stringify(number)} must refuse -- a branch name is a path segment and a host filesystem key`,
		);
	}
});

test("normalizeNumber is the same function at both addresses, so gitlab-prompt's import did not fork", async () => {
	const { normalizeNumber: viaPrompt } = await import("../src/github-prompt.mjs");
	assert.equal(viaPrompt, normalizeNumber, "github-prompt re-exports branch.mjs's function; a copy would drift");
});

test("both envelopes name the branch branch.mjs mints -- the drift this module exists to stop is silent", () => {
	// A second copy of `pi/issue-${n}` would not throw. It would key a session on a branch the agent was
	// never told to push to, so every resume would miss and every job would look like a normal cold start.
	const target = { type: "issue", number: 42, title: "T", body: "B" };
	const branch = issueBranch(42);
	assert.ok(buildGithubPrompt({ flow: "fix", target }).includes(`\`${branch}\``));
	assert.ok(buildGitLabPrompt({ flow: "fix", target }).includes(`\`${branch}\``));
});
