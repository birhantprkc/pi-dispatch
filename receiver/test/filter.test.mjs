import assert from "node:assert/strict";
import { test } from "node:test";
import { filter } from "../src/filter.mjs";

// The reviewed allowlist + comment trigger, mirroring loadReceiverConfig's shape.
const cfg = {
	labelFlows: { "pi:frontend": "frontend-fix" },
	commentTrigger: { phrase: "@pi", defaultFlow: "triage" },
};
const SELF_ID = 999;

/** A well-formed `issue_comment.created` subset, overridable per case. */
function commentSubset(over = {}) {
	return {
		action: "created",
		sender: { id: 7 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B" },
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

test("self-comment is dropped even though it would clear the author gate + phrase (PAT owner mode)", () => {
	// author OWNER + body contains the phrase: this WOULD enqueue if the self guard were short-circuited.
	const subset = commentSubset({ sender: { id: SELF_ID }, comment: { author_association: "OWNER", body: "@pi go" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-self");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "self");
	assert.equal(r.job, undefined);
});

test("self-comment is dropped under the App bot id too (mirrors the app auth mode)", () => {
	const appSelfId = 424242;
	const subset = commentSubset({ sender: { id: appSelfId }, comment: { author_association: "OWNER", body: "@pi go" } });
	const r = filter("issue_comment", subset, cfg, appSelfId, "d-self-app");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "self");
});

test("missing sender.id rejects BEFORE the self compare (fail-closed, not fall-through to enqueue)", () => {
	// A string id: undefined/string !== the numeric selfId, so a reordered guard would fall through.
	for (const sender of [undefined, {}, { id: undefined }, { id: "7" }, { id: "999" }]) {
		const subset = commentSubset({ sender, comment: { author_association: "OWNER", body: "@pi go" } });
		const r = filter("issue_comment", subset, cfg, SELF_ID, "d-nosender");
		assert.equal(r.enqueue, false, `sender=${JSON.stringify(sender)} must not enqueue`);
		assert.equal(r.reason, "missing-sender-id");
	}
});

test("a valid label event with a missing sender.id fails closed (missing-sender-id, not enqueue)", () => {
	// Otherwise a perfect enqueue: proves identity is checked before the payload can win.
	const subset = issuesSubset({ sender: { id: undefined } });
	const r = filter("issues", subset, cfg, SELF_ID, "d-x");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "missing-sender-id");
});

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
	const subset = issuesSubset();
	const r = filter("issues", subset, cfg, SELF_ID, "guid-abc");
	assert.equal(r.enqueue, true);
	assert.equal(r.reason, undefined);
	// Full shape: exact key set proves no sender.login, no provider/model/maxTurns, no extra field.
	assert.deepEqual(r.job, {
		repo: "octo/repo",
		issueNumber: 42,
		flow: "frontend-fix",
		title: "T",
		body: "B",
		trigger: { event: "issues", action: "labeled", deliveryId: "guid-abc", sender: { id: 7 } },
	});
	// Explicit guards on the constraints the deepEqual encodes.
	assert.equal(r.job.flow, "frontend-fix");
	assert.equal(r.job.repo, "octo/repo");
	assert.equal(r.job.issueNumber, 42);
	assert.equal(r.job.trigger.deliveryId, "guid-abc");
	assert.equal(r.job.trigger.sender.id, 7);
	assert.equal("login" in r.job.trigger.sender, false);
	for (const forbidden of ["provider", "model", "maxTurns"]) {
		assert.equal(forbidden in r.job, false, `job must not carry ${forbidden}`);
	}
	assert.deepEqual(Object.keys(r.job).sort(), ["body", "flow", "issueNumber", "repo", "title", "trigger"]);
});

test("first-matching label wins when several are present", () => {
	const subset = issuesSubset({
		issue: { number: 42, title: "T", body: "B", labels: [{ name: "bug" }, { name: "pi:frontend" }] },
	});
	const r = filter("issues", subset, cfg, SELF_ID, "d-multi");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "frontend-fix");
});

test("issues.opened and issues.reopened also route the label path", () => {
	for (const action of ["opened", "reopened"]) {
		const r = filter("issues", issuesSubset({ action }), cfg, SELF_ID, "d-" + action);
		assert.equal(r.enqueue, true);
		assert.equal(r.job.trigger.action, action);
	}
});

test("comment with the phrase but no defaultFlow and no @pi <flow> is dropped as no-flow", () => {
	const noDefault = { labelFlows: cfg.labelFlows, commentTrigger: { phrase: "@pi", defaultFlow: null } };
	const subset = commentSubset({ comment: { author_association: "MEMBER", body: "@pi please help" } });
	const r = filter("issue_comment", subset, noDefault, SELF_ID, "d-noflow");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-flow");
});

test("an explicit `@pi <flow>` names a known flow value and enqueues even with defaultFlow null", () => {
	const noDefault = { labelFlows: cfg.labelFlows, commentTrigger: { phrase: "@pi", defaultFlow: null } };
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

test("a valid comment with the default flow enqueues with defaultFlow", () => {
	const subset = commentSubset({ comment: { author_association: "OWNER", body: "hey @pi take a look" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-default");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "triage");
});

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
