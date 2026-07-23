import assert from "node:assert/strict";
import { test } from "node:test";
import { filter } from "../src/filter.mjs";

// The grouped webhook triggers, mirroring loadReceiverConfig's `cfg.triggers` shape (label rules, the
// single comment trigger, pull_request rules, and the knownFlows set for comment `<phrase> <flow>` overrides).
const cfg = {
	triggers: {
		label: [{ predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }],
		comment: { phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [],
		knownFlows: new Set(["frontend-fix", "triage"]),
	},
};
// A richer label allowlist exercising every predicate clause: any-of-many, a required `all`, exclusion
// `none`, and a second flow to prove first-match-in-file-order and single-clause routing.
const matrixCfg = {
	triggers: {
		label: [
			{ predicate: { any: ["ai-fix", "urgent-fix"], all: ["triaged"], none: ["blocked", "wontfix"] }, flow: "fix" },
			{ predicate: { any: ["ai-review"] }, flow: "review" },
		],
		comment: { phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [],
		knownFlows: new Set(["fix", "review", "triage"]),
	},
};
// Pull-request triggers: a labeled rule (predicate = approval) and an auto rule (author gate = approval).
const prCfg = {
	triggers: {
		label: [],
		comment: { phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [
			{ actions: new Set(["labeled"]), predicate: { any: ["pi:review"] }, flow: "review" },
			{ actions: new Set(["opened", "synchronize", "reopened"]), predicate: {}, flow: "autoreview" },
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
		trigger: { event: "issues", action: "labeled", deliveryId: "guid-abc", sender: { id: 7 } },
	});
	assert.equal("login" in r.job.trigger.sender, false);
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

// -- comment path ---------------------------------------------------------------------------------

test("comment with the phrase but no defaultFlow and no @pi <flow> is dropped as no-flow", () => {
	const noDefault = { triggers: { ...cfg.triggers, comment: { phrase: "@pi", defaultFlow: null } } };
	const subset = commentSubset({ comment: { author_association: "MEMBER", body: "@pi please help" } });
	const r = filter("issue_comment", subset, noDefault, SELF_ID, "d-noflow");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-flow");
});

test("an explicit `@pi <flow>` names a known flow value and enqueues even with defaultFlow null", () => {
	const noDefault = { triggers: { ...cfg.triggers, comment: { phrase: "@pi", defaultFlow: null } } };
	const subset = commentSubset({ comment: { author_association: "COLLABORATOR", body: "@pi frontend-fix please" } });
	const r = filter("issue_comment", subset, noDefault, SELF_ID, "d-explicit");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "frontend-fix");
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
});

test("a comment ON A PR (issue.pull_request present) routes a pull_request target, not an issue", () => {
	const subset = commentSubset({ issue: { number: 55, title: "PR T", body: "PR B", pull_request: true }, comment: { author_association: "OWNER", body: "@pi go" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-prcomment");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.target.type, "pull_request");
	assert.equal(r.job.target.number, 55);
	assert.equal(r.job.flow, "triage");
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
