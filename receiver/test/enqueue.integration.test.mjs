import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { makeReceiver } from "../src/receiver.mjs";

// Integration against a real Valkey: the receiver's verify->filter->enqueue path must land a real job
// in Valkey under its exact-per-delivery GUID jobId (REQ-DEDUP-BY-DELIVERY-GUID). The fake-queue tests
// in receiver.test.mjs prove the routing; this proves the wire -- a real BullMQ add against a real
// Redis-protocol server, so a regression in the shared enqueue contract cannot pass unnoticed.
//
// Runs when VALKEY_TEST_URL is set (CI provides a service). PI_DISPATCH_REQUIRE_RECEIVER_TESTS=1 turns
// a skip into a hard failure: a skipped assertion is an UNVERIFIED assertion, so where the flag is set
// a missing Valkey is a red build, never a silent green.
const url = process.env.VALKEY_TEST_URL;
const required = process.env.PI_DISPATCH_REQUIRE_RECEIVER_TESTS === "1";
if (!url && required) {
	throw new Error("receiver enqueue integration test is REQUIRED here (PI_DISPATCH_REQUIRE_RECEIVER_TESTS=1) but VALKEY_TEST_URL is not set");
}
const skip = url ? false : "VALKEY_TEST_URL not set; receiver enqueue integration test skipped (CI sets it)";

const SECRET = "test-webhook-secret";
const SELF_ID = 999;
const cfg = {
	webhookSecret: SECRET,
	triggers: {
		label: [{ index: 0, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }],
		comment: { index: 1, phrase: "@pi", defaultFlow: null },
		pullRequest: [],
		knownFlows: new Set(["frontend-fix"]),
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

test("verify->filter->enqueue lands a github job in a real Valkey under the GUID jobId", { skip }, async () => {
	const { Queue } = await import("bullmq");
	const { parseConnection } = await import("@pi-dispatch/worker/connection");

	// A uniquely-named queue per run so parallel/repeated Valkey tests cannot see each other's jobs.
	// `parseConnection` returns connection OPTIONS (not a shared ioredis instance), so this Queue owns
	// the client it builds from them and `queue.close()` closes it -- no separate connection to quit.
	const connection = parseConnection(url);
	const queue = new Queue(`recv-it-${crypto.randomUUID()}`, { connection });
	try {
		await queue.obliterate({ force: true }).catch(() => {});

		const delivery = crypto.randomUUID();
		const payload = {
			action: "labeled",
			sender: { id: 1 },
			repository: { full_name: "octo/repo" },
			issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
		};
		const raw = JSON.stringify(payload);

		const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
		const req = mockReq({
			headers: {
				"content-type": "application/json",
				"x-hub-signature-256": sign(SECRET, raw),
				"x-github-event": "issues",
				"x-github-delivery": delivery,
			},
		});
		const res = mockRes();
		await drive(handler, req, res, raw);

		assert.equal(res.statusCode, 202);

		// The job is really in Valkey, under the exact-per-delivery GUID jobId, with the github shape.
		const job = await queue.getJob("gh-" + delivery);
		assert.ok(job, "the enqueued job must be readable back from Valkey under gh-<delivery>");
		assert.equal(job.id, "gh-" + delivery);
		assert.equal(job.data.kind, "github");
		assert.equal(job.data.flow, "frontend-fix");
	} finally {
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.close();
	}
});
