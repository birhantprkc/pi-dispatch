import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startReceiver } from "../src/start.mjs";

// The committed unified triggers file, addressed absolutely so loadReceiverConfig's real fs reads
// succeed regardless of the test runner's cwd. Every side-effecting collaborator (gh, Valkey, socket) is
// injected, so this suite touches none of them.
const TRIGGERS_PATH = fileURLToPath(new URL("../../deploy/triggers.json", import.meta.url));
const SECRET = "shh";

function baseEnv(overrides = {}) {
	return { WEBHOOK_SECRET: SECRET, PI_TRIGGERS_FILE: TRIGGERS_PATH, ...overrides };
}

const okAuth = async () => ({ selfId: 12345, source: "gh" });
const throwingAuth = async () => {
	throw Object.assign(new Error("no identity"), { piDispatchConfig: true });
};
const stubQueue = () => ({ add: async () => {}, close: async () => {} });

/** A createServer fake that records the handler and the listen args and never opens a socket. */
function capturingServer() {
	const captured = {};
	const server = {
		listen: (port, bind, cb) => {
			captured.listen = { port, bind };
			cb?.();
			return server;
		},
		close: (cb) => cb?.(),
	};
	const createServer = (handler) => {
		captured.handler = handler;
		return server;
	};
	return { captured, createServer };
}

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
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers;
			return this;
		},
		end(body) {
			this.body = body;
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

function headersFor(event, delivery, raw) {
	return {
		"content-type": "application/json",
		"x-hub-signature-256": sign(SECRET, raw),
		"x-github-event": event,
		"x-github-delivery": delivery,
	};
}

test("HARD-FAIL: an unresolvable identity rejects and NO server is ever created", async () => {
	const { captured, createServer } = capturingServer();
	await assert.rejects(
		startReceiver(baseEnv(), { makeAuth: throwingAuth, makeQueueFn: stubQueue, createServer }),
		(e) => e.piDispatchConfig === true,
	);
	// The guard did not boot disarmed: without selfId neither the handler nor the listen happened.
	assert.equal(captured.handler, undefined, "the handler must never be built without selfId");
	assert.equal(captured.listen, undefined, "the receiver must never listen without the bot-loop guard");
});

test("happy path binds the configured host and port (defaults) and returns the server", async () => {
	const { captured, createServer } = capturingServer();
	const server = await startReceiver(baseEnv(), { makeAuth: okAuth, makeQueueFn: stubQueue, createServer });
	assert.equal(captured.listen.bind, "0.0.0.0");
	assert.equal(captured.listen.port, 3000);
	assert.ok(server, "startReceiver returns the server for tests and keep-alive");
});

test("RECEIVER_PORT/RECEIVER_BIND overrides reach listen", async () => {
	const { captured, createServer } = capturingServer();
	await startReceiver(baseEnv({ RECEIVER_PORT: "8080", RECEIVER_BIND: "127.0.0.1" }), {
		makeAuth: okAuth,
		makeQueueFn: stubQueue,
		createServer,
	});
	assert.equal(captured.listen.port, 8080);
	assert.equal(captured.listen.bind, "127.0.0.1");
});

test("the makeReceiver handler is wired to createServer and a signed delivery enqueues onto the stub queue", async () => {
	const { captured, createServer } = capturingServer();
	const adds = [];
	const queue = {
		add: async (name, data, opts) => {
			adds.push({ name, data, opts });
			return { id: opts?.jobId };
		},
		close: async () => {},
	};
	await startReceiver(baseEnv(), { makeAuth: okAuth, makeQueueFn: () => queue, createServer });
	assert.equal(typeof captured.handler, "function", "the makeReceiver handler was passed to createServer");

	// Drive a real signed issues.labeled through the wired handler; the triggers file maps pi:frontend.
	const payload = {
		action: "labeled",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
	};
	const raw = JSON.stringify(payload);
	const req = mockReq({ headers: headersFor("issues", "d-wired", raw) });
	const res = mockRes();
	await drive(captured.handler, req, res, raw);

	assert.equal(res.statusCode, 202);
	assert.equal(adds.length, 1);
	assert.equal(adds[0].data.kind, "github");
	assert.equal(adds[0].data.flow, "frontend-fix");
});
