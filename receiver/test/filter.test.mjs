import assert from "node:assert/strict";
import { test } from "node:test";
import { filter } from "../src/filter.mjs";

// The grouped webhook triggers, mirroring loadReceiverConfig's `cfg.triggers` shape (label rules, the
// single comment trigger, pull_request rules, and the knownFlows set for comment `<phrase> <flow>` overrides).
// Rule `index` values are deliberately NON-CONTIGUOUS: the filter must pass the loader's raw-file index
// through to `trigger.matched.index` verbatim, never recompute a position of its own.
const cfg = {
	triggers: {
		label: [{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }],
		comment: { index: 4, phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [],
		knownFlows: new Set(["frontend-fix", "triage"]),
	},
};
// A richer label allowlist exercising every predicate clause: any-of-many, a required `all`, exclusion
// `none`, and a second flow to prove first-match-in-file-order and single-clause routing.
const matrixCfg = {
	triggers: {
		label: [
			{ index: 2, predicate: { any: ["ai-fix", "urgent-fix"], all: ["triaged"], none: ["blocked", "wontfix"] }, flow: "fix" },
			{ index: 5, predicate: { any: ["ai-review"] }, flow: "review" },
		],
		comment: { index: 7, phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [],
		knownFlows: new Set(["fix", "review", "triage"]),
	},
};
// Pull-request triggers: a labeled rule (predicate = approval) and an auto rule (author gate = approval).
const prCfg = {
	triggers: {
		label: [],
		comment: { index: 1, phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [
			{ index: 3, actions: new Set(["labeled"]), predicate: { any: ["pi:review"] }, flow: "review" },
			{ index: 6, actions: new Set(["opened", "synchronize", "reopened"]), predicate: {}, flow: "autoreview" },
		],
		knownFlows: new Set(["review", "autoreview", "triage"]),
	},
};
const SELF_ID = 999;

/** A well-formed `issue_comment.created` subset, overridable per case. */
function commentSubset(over = {}) {
	return {
		action: "created",
		sender: { id: 7 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", pull_request: false },
		comment: { author_association: "OWNER", body: "@pi go" },
		...over,
	};
}

/** A well-formed `issues.labeled` subset, overridable per case. */
function issuesSubset(over = {}) {
	return {
		action: "labeled",
		sender: { id: 7 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
		...over,
	};
}

/** An `issues.labeled` subset carrying exactly the named labels -- for the predicate matrix. */
function labeledSubset(labelNames) {
	return issuesSubset({ issue: { number: 42, title: "T", body: "B", labels: labelNames.map((name) => ({ name })) } });
}

/** A well-formed `pull_request` subset, overridable per case. */
function prSubset({ action = "opened", senderId = 7, author = "COLLABORATOR", labels = [] } = {}) {
	return {
		action,
		sender: { id: senderId },
		repository: { full_name: "octo/repo" },
		pull_request: {
			number: 12,
			title: "PR T",
			body: "PR B",
			author_association: author,
			labels: labels.map((name) => ({ name })),
			head: { ref: "feat", sha: "abc", repo: { full_name: "fork/x" } },
			base: { ref: "main" },
		},
	};
}

// -- identity + bot-loop guards (unchanged, load-bearing order) -----------------------------------

test("self-comment is dropped even though it would clear the author gate + phrase (PAT owner mode)", () => {
	const subset = commentSubset({ sender: { id: SELF_ID } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-self");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "self");
	assert.equal(r.job, undefined);
});

test("missing sender.id rejects BEFORE the self compare (fail-closed, not fall-through to enqueue)", () => {
	for (const sender of [undefined, {}, { id: undefined }, { id: "7" }, { id: "999" }]) {
		const subset = commentSubset({ sender });
		const r = filter("issue_comment", subset, cfg, SELF_ID, "d-nosender");
		assert.equal(r.enqueue, false, `sender=${JSON.stringify(sender)} must not enqueue`);
		assert.equal(r.reason, "missing-sender-id");
	}
});

test("a valid label event with a missing sender.id fails closed (missing-sender-id, not enqueue)", () => {
	const r = filter("issues", issuesSubset({ sender: { id: undefined } }), cfg, SELF_ID, "d-x");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "missing-sender-id");
});

// -- issue label path -----------------------------------------------------------------------------

test("comment from a non-collaborator (author_association NONE) is dropped", () => {
	const subset = commentSubset({ comment: { author_association: "NONE", body: "@pi go" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-none");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "author-not-allowed");
});

test("a labeled issue whose label is not in the allowlist is dropped, no job", () => {
	const subset = issuesSubset({ issue: { number: 42, title: "T", body: "B", labels: [{ name: "bug" }] } });
	const r = filter("issues", subset, cfg, SELF_ID, "d-bug");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-allowlisted-label");
	assert.equal(r.job, undefined);
});

test("a labeled issue with an allowlisted label enqueues, carrying only subset fields", () => {
	const r = filter("issues", issuesSubset(), cfg, SELF_ID, "guid-abc");
	assert.equal(r.enqueue, true);
	assert.equal(r.reason, undefined);
	assert.deepEqual(r.job, {
		repo: "octo/repo",
		target: { type: "issue", number: 42, title: "T", body: "B" },
		flow: "frontend-fix",
		trigger: {
			event: "issues",
			action: "labeled",
			deliveryId: "guid-abc",
			sender: { id: 7 },
			matched: { index: 2, type: "label", label: "pi:frontend" },
		},
	});
	assert.equal("login" in r.job.trigger.sender, false);
	// A label-triggered job carries NO comment key at all -- `comment` exists only on the comment route.
	assert.equal("comment" in r.job.trigger, false);
	for (const forbidden of ["provider", "model", "maxTurns", "issueNumber", "title", "body"]) {
		assert.equal(forbidden in r.job, false, `job must not carry a top-level ${forbidden}`);
	}
	assert.deepEqual(Object.keys(r.job).sort(), ["flow", "repo", "target", "trigger"]);
});

test("first-matching label wins when several are present", () => {
	const subset = issuesSubset({ issue: { number: 42, title: "T", body: "B", labels: [{ name: "bug" }, { name: "pi:frontend" }] } });
	const r = filter("issues", subset, cfg, SELF_ID, "d-multi");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "frontend-fix");
});

test("issues.opened and issues.reopened also route the label path", () => {
	for (const action of ["opened", "reopened"]) {
		const r = filter("issues", issuesSubset({ action }), cfg, SELF_ID, "d-" + action);
		assert.equal(r.enqueue, true);
		assert.equal(r.job.trigger.action, action);
		assert.equal(r.job.target.type, "issue");
	}
});

test("predicate: an `any` hit with all required labels and no exclusion enqueues the flow", () => {
	const r = filter("issues", labeledSubset(["ai-fix", "triaged"]), matrixCfg, SELF_ID, "d-m1");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "fix");
});

test("predicate: an `any` hit missing a required `all` label is dropped (all makes it stricter)", () => {
	const r = filter("issues", labeledSubset(["ai-fix"]), matrixCfg, SELF_ID, "d-m2");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-allowlisted-label");
});

test("predicate: a `none` label suppresses the flow (exclusion brake); no other flow matches", () => {
	const r = filter("issues", labeledSubset(["ai-fix", "triaged", "blocked"]), matrixCfg, SELF_ID, "d-m3");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-allowlisted-label");
});

test("predicate: the first flow in file order wins when several rules could match", () => {
	const r = filter("issues", labeledSubset(["ai-fix", "triaged", "ai-review"]), matrixCfg, SELF_ID, "d-m5");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "fix");
});

test("predicate: a label matching only the second flow routes to it (single-clause any)", () => {
	const r = filter("issues", labeledSubset(["ai-review"]), matrixCfg, SELF_ID, "d-m6");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "review");
});

// -- trigger.matched on the label path ------------------------------------------------------------

test("matched reports the WINNING rule's raw-file index and the any-hit label, per rule", () => {
	// First rule wins: index 2 (non-contiguous, so a recomputed array position would be caught), and the
	// label is the `any` entry actually present -- urgent-fix, not the rule's first-listed ai-fix.
	const first = filter("issues", labeledSubset(["urgent-fix", "triaged"]), matrixCfg, SELF_ID, "d-mi1");
	assert.equal(first.enqueue, true);
	assert.deepEqual(first.job.trigger.matched, { index: 2, type: "label", label: "urgent-fix" });

	// Second rule wins: its own index (5), its own any-hit.
	const second = filter("issues", labeledSubset(["ai-review"]), matrixCfg, SELF_ID, "d-mi2");
	assert.equal(second.enqueue, true);
	assert.deepEqual(second.job.trigger.matched, { index: 5, type: "label", label: "ai-review" });
});

test("a rule matched via an `all`-only predicate reports all[0] as the matched label", () => {
	// No `any` clause: the positive selector is `all`, and all ⊆ L on a match guarantees membership.
	const allOnlyCfg = {
		triggers: {
			label: [{ index: 9, predicate: { all: ["triaged", "approved"] }, flow: "fix" }],
			comment: null,
			pullRequest: [],
			knownFlows: new Set(["fix"]),
		},
	};
	const r = filter("issues", labeledSubset(["approved", "triaged"]), allOnlyCfg, SELF_ID, "d-mi3");
	assert.equal(r.enqueue, true);
	assert.deepEqual(r.job.trigger.matched, { index: 9, type: "label", label: "triaged" });
});

// -- comment path ---------------------------------------------------------------------------------

test("comment with the phrase but no defaultFlow and no @pi <flow> is dropped as no-flow", () => {
	const noDefault = { triggers: { ...cfg.triggers, comment: { index: 4, phrase: "@pi", defaultFlow: null } } };
	const subset = commentSubset({ comment: { author_association: "MEMBER", body: "@pi please help" } });
	const r = filter("issue_comment", subset, noDefault, SELF_ID, "d-noflow");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-flow");
});

test("an explicit `@pi <flow>` names a known flow value and enqueues even with defaultFlow null", () => {
	const noDefault = { triggers: { ...cfg.triggers, comment: { index: 4, phrase: "@pi", defaultFlow: null } } };
	const subset = commentSubset({ comment: { author_association: "COLLABORATOR", body: "@pi frontend-fix please" } });
	const r = filter("issue_comment", subset, noDefault, SELF_ID, "d-explicit");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "frontend-fix");
	// The flow-override changes WHICH flow runs, never the match record: matched.phrase stays the
	// configured phrase, not the override word.
	assert.deepEqual(r.job.trigger.matched, { index: 4, type: "comment", phrase: "@pi" });
});

test("a comment lacking the trigger phrase is dropped", () => {
	const subset = commentSubset({ comment: { author_association: "OWNER", body: "just a normal comment" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-nophrase");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-trigger-phrase");
});

test("a valid comment with the default flow enqueues an issue target with defaultFlow", () => {
	const subset = commentSubset({ comment: { author_association: "OWNER", body: "hey @pi take a look" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-default");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "triage");
	assert.equal(r.job.target.type, "issue");
	// The invoking comment rides on the trigger -- exactly the two subset fields, nothing else.
	assert.deepEqual(r.job.trigger.comment, { body: "hey @pi take a look", author_association: "OWNER" });
	assert.deepEqual(r.job.trigger.matched, { index: 4, type: "comment", phrase: "@pi" });
});

test("a comment ON A PR (issue.pull_request present) routes a pull_request target, not an issue", () => {
	const subset = commentSubset({ issue: { number: 55, title: "PR T", body: "PR B", pull_request: true }, comment: { author_association: "OWNER", body: "@pi go" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-prcomment");
	assert.equal(r.enqueue, true);
	// Target unchanged by the trigger-context work: still the PR's number/title/body from subset.issue.
	assert.deepEqual(r.job.target, { type: "pull_request", number: 55, title: "PR T", body: "PR B" });
	assert.equal(r.job.flow, "triage");
	// The PR-comment variant carries the invoking comment too -- same contract as an issue comment.
	assert.deepEqual(r.job.trigger.comment, { body: "@pi go", author_association: "OWNER" });
	assert.deepEqual(r.job.trigger.matched, { index: 4, type: "comment", phrase: "@pi" });
});

// -- pull_request path ----------------------------------------------------------------------------

test("a PR labeled with a matching predicate enqueues a pull_request target with head/base as data", () => {
	const r = filter("pull_request", prSubset({ action: "labeled", labels: ["pi:review"] }), prCfg, SELF_ID, "d-prlabel");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "review");
	assert.deepEqual(r.job.target, {
		type: "pull_request",
		number: 12,
		title: "PR T",
		body: "PR B",
		head: { ref: "feat", sha: "abc", repo: "fork/x" },
		base: { ref: "main" },
	});
	assert.equal(r.job.trigger.event, "pull_request");
	// matched names the labeled rule (raw-file index 3) and the action that satisfied its action set.
	assert.deepEqual(r.job.trigger.matched, { index: 3, type: "pull_request", action: "labeled" });
	assert.equal("comment" in r.job.trigger, false);
});

test("a PR labeled with a non-matching label is dropped (no-matching-pr-trigger)", () => {
	const r = filter("pull_request", prSubset({ action: "labeled", labels: ["chore"] }), prCfg, SELF_ID, "d-prlabel2");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-matching-pr-trigger");
});

test("PR opened by a COLLABORATOR auto-fires (author gate satisfied)", () => {
	const r = filter("pull_request", prSubset({ action: "opened", author: "COLLABORATOR" }), prCfg, SELF_ID, "d-propen");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "autoreview");
	assert.equal(r.job.target.type, "pull_request");
	// The auto rule sits at raw-file index 6; matched.action is the action that fired, not the rule's set.
	assert.deepEqual(r.job.trigger.matched, { index: 6, type: "pull_request", action: "opened" });
});

test("PR opened by a non-collaborator (fork, author NONE) is dropped -- the hard author gate", () => {
	for (const author of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"]) {
		const r = filter("pull_request", prSubset({ action: "opened", author }), prCfg, SELF_ID, "d-fork");
		assert.equal(r.enqueue, false, `author=${author} must not auto-fire`);
		assert.equal(r.reason, "pr-author-not-allowed");
	}
});

test("PR opened with a missing author_association is dropped (has(undefined) === false)", () => {
	const subset = prSubset({ action: "opened" });
	delete subset.pull_request.author_association;
	const r = filter("pull_request", subset, prCfg, SELF_ID, "d-noauthor");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "pr-author-not-allowed");
});

test("PR synchronize/reopened by a collaborator auto-fires; by a fork author is dropped", () => {
	const ok = filter("pull_request", prSubset({ action: "synchronize", author: "MEMBER" }), prCfg, SELF_ID, "d-sync");
	assert.equal(ok.enqueue, true);
	assert.equal(ok.job.flow, "autoreview");
	assert.deepEqual(ok.job.trigger.matched, { index: 6, type: "pull_request", action: "synchronize" });

	const forked = filter("pull_request", prSubset({ action: "reopened", author: "NONE" }), prCfg, SELF_ID, "d-reopen");
	assert.equal(forked.enqueue, false);
	assert.equal(forked.reason, "pr-author-not-allowed");
});

test("a PR synchronize from the harness's own push (sender.id === selfId) is dropped by the bot-loop guard", () => {
	// The flow pushing to a PR head fires pull_request.synchronize; the unconditional self guard breaks the loop.
	const r = filter("pull_request", prSubset({ action: "synchronize", senderId: SELF_ID, author: "OWNER" }), prCfg, SELF_ID, "d-selfpush");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "self");
});

test("a PR labeled action does NOT require the author gate (collaborator-applied label is the approval)", () => {
	// author NONE, but a collaborator applied the pi:review label -> labeling is the approval.
	const r = filter("pull_request", prSubset({ action: "labeled", author: "NONE", labels: ["pi:review"] }), prCfg, SELF_ID, "d-prlabel-fork");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "review");
});

test("an unsupported PR action (closed) is dropped as unhandled-event", () => {
	const r = filter("pull_request", prSubset({ action: "closed" }), prCfg, SELF_ID, "d-prclosed");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "unhandled-event");
});

// -- unhandled events -----------------------------------------------------------------------------

test("an unhandled event is dropped as unhandled-event", () => {
	const r = filter("push", { action: undefined, sender: { id: 7 } }, cfg, SELF_ID, "d-push");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "unhandled-event");
});

test("an unhandled action on a handled event is dropped as unhandled-event", () => {
	const r = filter("issues", issuesSubset({ action: "closed" }), cfg, SELF_ID, "d-closed");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "unhandled-event");
});
