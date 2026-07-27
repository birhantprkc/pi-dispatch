import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { makeReceiver } from "../src/receiver.mjs";

const SECRET = "test-webhook-secret";
const SELF_ID = 999;
const cfg = {
	webhookSecret: SECRET,
	triggers: {
		label: [{ index: 0, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }],
		comment: { index: 1, phrase: "@pi", defaultFlow: null },
		pullRequest: [{ index: 2, actions: new Set(["opened", "synchronize"]), predicate: {}, flow: "review" }],
		knownFlows: new Set(["frontend-fix", "review"]),
	},
};

/** GitHub's `X-Hub-Signature-256` shape, computed the same way GitHub computes it. */
function sign(secret, raw) {
	return "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

/** EventEmitter-backed request mock: real streams are EventEmitters, so `on`/`emit` come for free. */
function mockReq({ method = "POST", headers = {} } = {}) {
	const req = new EventEmitter();
	req.method = method;
	req.headers = headers;
	req.destroyed = false;
	req.destroy = () => {
		req.destroyed = true;
	};
	return req;
}

/** Plain object response mock recording writeHead/statusCode/end -- no real socket. */
function mockRes() {
	return {
		statusCode: 0,
		headersSent: false,
		body: undefined,
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers;
			this.headersSent = true;
			return this;
		},
		end(body) {
			this.body = body;
			this.ended = true;
			return this;
		},
	};
}

/** Drive a handler: attach synchronously, then feed the raw bytes and await completion. */
async function drive(handler, req, res, raw) {
	const done = handler(req, res);
	if (raw !== undefined) {
		req.emit("data", Buffer.from(raw, "utf8"));
		req.emit("end");
	}
	await done;
}

/** Build the request headers GitHub sends, signing `raw` (or `signBytes` when it differs). */
function headersFor(event, delivery, raw, signBytes = raw) {
	return {
		"content-type": "application/json",
		"x-hub-signature-256": sign(SECRET, signBytes),
		"x-github-event": event,
		"x-github-delivery": delivery,
	};
}

/** A queue whose `add` records every call and returns a jobId, mirroring BullMQ's add contract. */
function recordingQueue() {
	const calls = [];
	const queue = {
		add: async (name, data, opts) => {
			calls.push({ name, data, opts });
			return { id: opts?.jobId };
		},
	};
	return { calls, queue };
}

test("signed issues.labeled (pi:frontend) enqueues one github job and responds 202", async () => {
	const delivery = "d-labeled";
	const payload = {
		action: "labeled",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	const req = mockReq({ headers: headersFor("issues", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "github");
	assert.equal(calls[0].data.kind, "github");
	assert.equal(calls[0].data.flow, "frontend-fix");
	assert.equal(calls[0].data.target.type, "issue");
	assert.equal(calls[0].data.target.number, 42);
	assert.equal(calls[0].opts.jobId, "gh-" + delivery);
	assert.equal(res.statusCode, 202);
});

test("signed issue_comment with `@pi <flow>` enqueues 202: trigger.comment rides the job, never the log", async () => {
	const delivery = "d-comment";
	const payload = {
		action: "created",
		sender: { id: 1, login: "octocat-the-login" },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B" },
		comment: { author_association: "OWNER", body: "@pi frontend-fix comment-body-marker" },
	};
	const raw = JSON.stringify(payload);

	const logs = [];
	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: (entry) => logs.push(entry) });
	const req = mockReq({ headers: headersFor("issue_comment", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(res.statusCode, 202);
	assert.equal(calls.length, 1);
	// The enqueued job carries the invoking comment and the match record end to end.
	assert.deepEqual(calls[0].data.trigger.comment, { body: "@pi frontend-fix comment-body-marker", author_association: "OWNER" });
	assert.deepEqual(calls[0].data.trigger.matched, { index: 1, type: "comment", phrase: "@pi" });

	// no-pii-in-logs: the comment body is job DATA, never log material -- the enqueued line carries
	// stable identifiers only, and no login appears anywhere in it.
	const enqueued = logs.find((entry) => entry.event === "enqueued");
	assert.ok(enqueued, "an enqueued log line is emitted");
	const line = JSON.stringify(enqueued);
	assert.equal(line.includes("comment-body-marker"), false, "the enqueued log line must not carry the comment body");
	assert.equal(line.includes("octocat-the-login"), false, "the enqueued log line must not carry a login");
	assert.equal(line.includes("login"), false);
});

test("signed pull_request.opened by a collaborator enqueues a pull_request job and responds 202", async () => {
	const delivery = "d-propen";
	const payload = {
		action: "opened",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		pull_request: {
			number: 12,
			title: "PR T",
			body: "PR B",
			author_association: "COLLABORATOR",
			labels: [],
			head: { ref: "feat", sha: "abc", repo: { full_name: "octo/repo" } },
			base: { ref: "main" },
		},
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	const req = mockReq({ headers: headersFor("pull_request", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].data.flow, "review");
	assert.equal(calls[0].data.target.type, "pull_request");
	assert.equal(calls[0].data.target.number, 12);
	assert.equal(calls[0].data.target.head.ref, "feat");
	assert.equal(res.statusCode, 202);
});

test("signed pull_request.opened from a fork author (NONE) is dropped 204, nothing enqueued", async () => {
	const delivery = "d-prfork";
	const payload = {
		action: "opened",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		pull_request: {
			number: 13,
			title: "PR T",
			body: "PR B",
			author_association: "NONE",
			labels: [],
			head: { ref: "feat", sha: "abc", repo: { full_name: "attacker/repo" } },
			base: { ref: "main" },
		},
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	const req = mockReq({ headers: headersFor("pull_request", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(calls.length, 0, "a fork PR must not auto-fire a paid job");
	assert.equal(res.statusCode, 204);
});

test("self-comment (sender.id === selfId) is dropped 204, nothing enqueued", async () => {
	const delivery = "d-self";
	const payload = {
		action: "created",
		sender: { id: SELF_ID },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B" },
		comment: { author_association: "OWNER", body: "@pi" },
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	const req = mockReq({ headers: headersFor("issue_comment", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(calls.length, 0);
	assert.equal(res.statusCode, 204);
});

test("a signature over different bytes is rejected 401 before onVerified -- nothing enqueued", async () => {
	const delivery = "d-401";
	const payload = {
		action: "labeled",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	// Signature computed over tampered bytes: D2 rejects before onVerified runs.
	const req = mockReq({ headers: headersFor("issues", delivery, raw, raw + "tampered") });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(res.statusCode, 401);
	assert.equal(calls.length, 0);
});

test("Valkey down: an enqueue that throws maps to 503, no unhandled rejection", async () => {
	const rejections = [];
	const onRej = (e) => rejections.push(e);
	process.on("unhandledRejection", onRej);
	try {
		const delivery = "d-valkey";
		const payload = {
			action: "labeled",
			sender: { id: 1 },
			repository: { full_name: "octo/repo" },
			issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
		};
		const raw = JSON.stringify(payload);

		const queue = {
			add: async () => {
				throw new Error("ECONNREFUSED");
			},
		};
		const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
		const req = mockReq({ headers: headersFor("issues", delivery, raw) });
		const res = mockRes();
		await drive(handler, req, res, raw);

		// Let any stray rejection surface before asserting.
		await new Promise((r) => setImmediate(r));

		assert.equal(res.statusCode, 503);
		assert.equal(rejections.length, 0, "enqueue failure must be handled, not an unhandled rejection");
	} finally {
		process.removeListener("unhandledRejection", onRej);
	}
});

test("malformed JSON with a VALID signature responds 400, nothing enqueued", async () => {
	const delivery = "d-badjson";
	const raw = "{ not valid json";

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	// Sign the exact malformed bytes so verification passes and the parse is what fails.
	const req = mockReq({ headers: headersFor("issues", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(res.statusCode, 400);
	assert.equal(calls.length, 0);
});

test("NONE-author comment is dropped 204, nothing enqueued", async () => {
	const delivery = "d-none";
	const payload = {
		action: "created",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B" },
		comment: { author_association: "NONE", body: "@pi" },
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	const req = mockReq({ headers: headersFor("issue_comment", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(calls.length, 0);
	assert.equal(res.statusCode, 204);
});
