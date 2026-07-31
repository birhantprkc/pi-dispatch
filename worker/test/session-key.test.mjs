import assert from "node:assert/strict";
import { test } from "node:test";
import { issueBranch } from "../src/branch.mjs";
import { keyParts, sessionKeyFor } from "../src/session-key.mjs";

const ghIssue = { kind: "github", repo: "o/r", target: { type: "issue", number: 7 } };
const ghPr = { kind: "github", repo: "o/r", target: { type: "pull_request", number: 8 } };
const sameRepo = { headRef: "pi/issue-7", headRepo: "o/r" };

test("an issue job keys on the branch its own envelope names, so the issue and its PR converge", () => {
	// This convergence IS the feature: issue #7's job opens PR #8 on pi/issue-7, and a later job on PR #8
	// resolves the same key because the head ref is that branch. Keying on the NUMBER would give 7 and 8
	// and never join -- the mistake a reviewer will propose.
	assert.deepEqual(keyParts(ghIssue), ["github", "o/r", "pi/issue-7"]);
	assert.equal(sessionKeyFor(ghPr, sameRepo), sessionKeyFor(ghIssue));
});

test("a fork pull request resolves NO KEY -- the one hole with a stranger on the other side", () => {
	// A stranger forks, names a branch pi/issue-7, and gets a collaborator to act on the PR. Without this
	// gate they are handed issue 7's transcript: tool output, file contents, the model's own reasoning.
	assert.equal(sessionKeyFor(ghPr, { headRef: "pi/issue-7", headRepo: "stranger/r" }), null);
	assert.equal(keyParts(ghPr, { headRef: "pi/issue-7", headRepo: "stranger/r" }), null);
	// Absence of a key, never a flag: there is no later stage that could forget to check it.
	for (const headRepo of [undefined, null, "", 7, {}, "o/r2", "O/R"]) {
		assert.equal(sessionKeyFor(ghPr, { headRef: "pi/issue-7", headRepo }), null, `headRepo ${JSON.stringify(headRepo)} must not resolve against base o/r`);
	}
});

test("an unresolved head ref is a cold start, not a guess", () => {
	for (const headRef of [undefined, null, "", 7]) {
		assert.equal(sessionKeyFor(ghPr, { headRef, headRepo: "o/r" }), null, `headRef ${JSON.stringify(headRef)} must not resolve`);
	}
	assert.equal(sessionKeyFor(ghPr), null, "no resolution at all means no key");
});

test("the key separates repo from ref, so two repos and two branches are four transcripts", () => {
	const keys = new Set([
		sessionKeyFor({ ...ghIssue, repo: "o/r" }),
		sessionKeyFor({ ...ghIssue, repo: "o/r2" }),
		sessionKeyFor({ ...ghIssue, target: { type: "issue", number: 8 } }),
		sessionKeyFor({ ...ghIssue, repo: "o/r2", target: { type: "issue", number: 8 } }),
	]);
	assert.equal(keys.size, 4, "a container that could name another repo's or another PR's transcript is a cross-tenant leak");
});

test("the delimiter stops a repo/ref boundary shift from colliding two distinct keys", () => {
	// ("ab", "c") and ("a", "bc") must not hash alike -- job-id.mjs's NUL reasoning, same failure.
	const a = sessionKeyFor({ kind: "github", repo: "o/rx", target: { type: "pull_request" } }, { headRef: "y", headRepo: "o/rx" });
	const b = sessionKeyFor({ kind: "github", repo: "o/r", target: { type: "pull_request" } }, { headRef: "xy", headRepo: "o/r" });
	assert.notEqual(a, b);
});

test("the same branch on the two forges is two transcripts, not one", () => {
	assert.notEqual(sessionKeyFor(ghIssue), sessionKeyFor({ ...ghIssue, kind: "gitlab" }));
});

test("a cron job keys on its scheduler id -- operator-authored, chosen by nobody untrusted", () => {
	const cron = { kind: "local", folder: "/srv/app", flow: "maintain", trigger: { id: "nightly", pattern: "0 3 * * *" } };
	assert.deepEqual(keyParts(cron), ["local", "", "nightly"]);
	assert.notEqual(sessionKeyFor(cron), sessionKeyFor({ ...cron, trigger: { id: "weekly" } }));
	// The folder is deliberately NOT in the key: the scheduler id already identifies the entry uniquely,
	// and a host path in the key would put the OS account name into a directory name on Windows.
	assert.equal(sessionKeyFor(cron), sessionKeyFor({ ...cron, folder: "/somewhere/else" }));
});

test("a job with no trigger entry that could have armed run.resume resolves null", () => {
	// A CLI `pi-dispatch run` and a chained /outbox child both arrive as kind:"local" with no trigger.
	assert.equal(sessionKeyFor({ kind: "local", folder: "/srv/app", flow: "fix", task: "do it" }), null);
	assert.equal(sessionKeyFor({ kind: "local", flow: "fix", parentJobId: "gh-abc", chainDepth: 1 }), null);
	assert.equal(sessionKeyFor({ kind: "local", trigger: { pattern: "0 3 * * *" } }), null, "a trigger without an id is not an identity");
});

test("the function is total: no input throws, because a throw here would fail a job over a cache miss", () => {
	for (const job of [undefined, null, {}, { kind: "github" }, { kind: "github", repo: "o/r" }, { kind: "nonsense", repo: "o/r" }, { kind: "github", repo: 7, target: { type: "issue", number: 1 } }, { kind: "github", repo: "o/r", target: { type: "issue", number: "not-a-number" } }, { kind: "github", repo: "o/r", target: { type: "issue", number: 0 } }]) {
		assert.doesNotThrow(() => sessionKeyFor(job), `sessionKeyFor(${JSON.stringify(job)}) must not throw`);
		assert.equal(sessionKeyFor(job), null, `sessionKeyFor(${JSON.stringify(job)}) must be a cold start`);
	}
});

test("the key is a hash, so an attacker-chosen ref never becomes a host path segment", () => {
	const hostile = sessionKeyFor({ kind: "github", repo: "o/r", target: { type: "pull_request" } }, { headRef: "../../../../etc/passwd", headRepo: "o/r" });
	assert.match(hostile, /^[0-9a-f]{32}$/, "validating a ref into a safe path segment is the losing half of the argument; hashing makes traversal unreachable");
	assert.equal(hostile.includes(".."), false);
	// And the listing carries no repo or branch name -- PII-free by construction, as `local:<basename>` is.
	assert.equal(hostile.includes("o/r"), false);
});

test("the branch half comes from branch.mjs, so the key and the envelope cannot drift", () => {
	assert.deepEqual(keyParts(ghIssue), ["github", "o/r", issueBranch(7)]);
});
