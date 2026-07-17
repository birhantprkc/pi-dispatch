import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Webhooks } from "@octokit/webhooks";
import { makeVerifiedHandler, verifySignature } from "../src/verify.mjs";

const SECRET = "test-webhook-secret";

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

test("verifySignature: a signature over the exact bytes verifies true", async () => {
	const raw = '{"action":"labeled"}';
	const ok = await verifySignature(new Webhooks({ secret: SECRET }), raw, sign(SECRET, raw));
	assert.equal(ok, true);
});

test("verifySignature: the same signature over tampered bytes verifies false", async () => {
	const raw = '{"action":"labeled"}';
	const sig = sign(SECRET, raw);
	const ok = await verifySignature(new Webhooks({ secret: SECRET }), raw + "x", sig);
	assert.equal(ok, false);
});

test("verifySignature: a garbage signature verifies false", async () => {
	const raw = '{"action":"labeled"}';
	const ok = await verifySignature(new Webhooks({ secret: SECRET }), raw, "sha256=deadbeef");
	assert.equal(ok, false);
});

test("handler 401 on a signature over DIFFERENT bytes -- onVerified is never called", async () => {
	// The must-never-regress case: a valid-looking signature that does not match the sent body.
	const sent = '{"action":"labeled","issue":{"number":7}}';
	const sigOverOther = sign(SECRET, sent + "tampered");

	let calls = 0;
	const handler = makeVerifiedHandler({ secret: SECRET }, async () => {
		calls++;
	});
	const req = mockReq({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": sigOverOther,
			"x-github-event": "issues",
			"x-github-delivery": "d-401",
		},
	});
	const res = mockRes();
	await drive(handler, req, res, sent);

	assert.equal(res.statusCode, 401);
	assert.equal(calls, 0, "a bad signature must not reach onVerified");
});

test("handler success: signature over the actual bytes hands off to onVerified once", async () => {
	const sent = '{"action":"opened","issue":{"number":42}}';
	let received;
	let calls = 0;
	const handler = makeVerifiedHandler({ secret: SECRET }, async (payload, res) => {
		calls++;
		received = payload;
		res.writeHead(204, {});
		res.end();
	});
	const req = mockReq({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": sign(SECRET, sent),
			"x-github-event": "issues",
			"x-github-delivery": "d-ok",
		},
	});
	const res = mockRes();
	await drive(handler, req, res, sent);

	assert.equal(calls, 1);
	assert.equal(received.rawBody, sent, "onVerified sees the exact bytes that were verified");
	assert.equal(received.event, "issues");
	assert.equal(received.delivery, "d-ok");
	assert.equal(received.headers["x-hub-signature-256"], sign(SECRET, sent));
});

test("handler 413 when the body exceeds bodyLimit -- bounded, onVerified not called", async () => {
	const big = "x".repeat(1000);
	let calls = 0;
	const handler = makeVerifiedHandler({ secret: SECRET, bodyLimit: 16 }, async () => {
		calls++;
	});
	const req = mockReq({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": sign(SECRET, big),
			"x-github-event": "issues",
			"x-github-delivery": "d-413",
		},
	});
	const res = mockRes();
	await drive(handler, req, res, big);

	assert.equal(res.statusCode, 413);
	assert.equal(calls, 0);
	assert.equal(req.destroyed, true, "an oversize request is destroyed, not buffered");
});

test("handler 401 when the signature header is missing -- cannot verify", async () => {
	let calls = 0;
	const handler = makeVerifiedHandler({ secret: SECRET }, async () => {
		calls++;
	});
	const req = mockReq({
		headers: {
			"content-type": "application/json",
			"x-github-event": "issues",
			"x-github-delivery": "d-nosig",
		},
	});
	const res = mockRes();
	await drive(handler, req, res, "{}");

	assert.equal(res.statusCode, 401);
	assert.equal(calls, 0);
});

test("handler 415 on a non-JSON content type", async () => {
	let calls = 0;
	const handler = makeVerifiedHandler({ secret: SECRET }, async () => {
		calls++;
	});
	const req = mockReq({
		headers: {
			"content-type": "text/plain",
			"x-hub-signature-256": sign(SECRET, "{}"),
			"x-github-event": "issues",
			"x-github-delivery": "d-415",
		},
	});
	const res = mockRes();
	await drive(handler, req, res, "{}");

	assert.equal(res.statusCode, 415);
	assert.equal(calls, 0);
});

test("handler 400 when GitHub event/delivery headers are missing", async () => {
	let calls = 0;
	const handler = makeVerifiedHandler({ secret: SECRET }, async () => {
		calls++;
	});
	const req = mockReq({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": sign(SECRET, "{}"),
		},
	});
	const res = mockRes();
	await drive(handler, req, res, "{}");

	assert.equal(res.statusCode, 400);
	assert.equal(calls, 0);
});

test("handler 405 on a non-POST method", async () => {
	let calls = 0;
	const handler = makeVerifiedHandler({ secret: SECRET }, async () => {
		calls++;
	});
	const req = mockReq({ method: "GET", headers: {} });
	const res = mockRes();
	await drive(handler, req, res);

	assert.equal(res.statusCode, 405);
	assert.equal(calls, 0);
});
