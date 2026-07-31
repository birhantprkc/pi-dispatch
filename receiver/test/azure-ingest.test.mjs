import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { makeReceiver } from "../src/receiver.mjs";
import { credentialOk, secretEquals } from "../src/verify-azure.mjs";

const SELF = { id: "self-guid", email: "pi-bot@example.com" };
const BASIC = Buffer.from("hooks:s3cret", "utf8").toString("base64");

function forgeTriggers({ knownFlows, ...group }) {
	const empty = { label: [], comment: null, pullRequest: [] };
	return { github: empty, gitlab: empty, forgejo: empty, azure: group, knownFlows };
}

const cfg = {
	webhookSecret: "gh-secret",
	triggers: forgeTriggers({
		label: [{ index: 0, predicate: { any: ["pi:go"] }, flow: "fix", repository: "widgets" }],
		comment: null,
		pullRequest: [],
		knownFlows: new Set(["fix"]),
	}),
};

const LABELLED = JSON.stringify({
	id: "delivery-guid-1",
	eventType: "workitem.updated",
	resourceContainers: { project: { id: "proj-guid" } },
	resource: {
		id: 7,
		fields: { "System.ChangedBy": { newValue: "Dev <dev@example.com>" }, "System.Tags": { oldValue: "", newValue: "pi:go" } },
		revision: { fields: { "System.Title": "T", "System.Tags": "pi:go", "System.TeamProject": "Fabrikam" } },
	},
});

function mockReq({ url = "/azure", method = "POST", headers = {} } = {}) {
	const req = new EventEmitter();
	req.url = url;
	req.method = method;
	req.headers = { "content-type": "application/json", authorization: `Basic ${BASIC}`, ...headers };
	req.destroy = () => {};
	return req;
}

function mockRes() {
	return {
		statusCode: 0,
		headersSent: false,
		body: undefined,
		writeHead(s) {
			this.statusCode = s;
			this.headersSent = true;
		},
		end(b) {
			this.body = b;
		},
	};
}

async function drive(handler, req, res, raw) {
	const p = handler(req, res);
	req.emit("data", Buffer.from(raw, "utf8"));
	req.emit("end");
	await p;
}

function recordingQueue() {
	const calls = [];
	return { calls, queue: { add: async (name, data, opts) => (calls.push({ name, data, opts }), { id: opts?.jobId }) } };
}

function build({ authorized = true, resolve, azure = { mode: "basic", secret: BASIC }, logs = [] } = {}) {
	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({
		queue,
		selfId: 1,
		cfg,
		log: (o) => logs.push(o),
		azure: azure ? { ...azure, selfId: SELF, resolveAuthority: resolve ?? (async () => ({ authorized })) } : null,
	});
	return { handler, calls, logs };
}

test("a member-tagged work item enqueues exactly one azure job, keyed on the BODY's id", async () => {
	// Azure sends no delivery-id header at all, so REQ-DEDUP-BY-DELIVERY-GUID's key comes from the verified
	// payload. The `az-` prefix keeps this forge's id space disjoint from the other three.
	const { handler, calls } = build();
	const res = mockRes();
	await drive(handler, mockReq(), res, LABELLED);

	assert.equal(res.statusCode, 202);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "azure");
	assert.equal(calls[0].data.repo, "Fabrikam/widgets");
	assert.equal(calls[0].opts.jobId, "az-delivery-guid-1");
	assert.equal(calls[0].opts.deduplication.id, "Fabrikam/widgets#7:fix", "a work item is # -- ! is reserved for pull requests, which are a separate id sequence");
});

test("a wrong Basic credential is 401 and never reaches the gate", async () => {
	const { handler, calls } = build();
	const res = mockRes();
	await drive(handler, mockReq({ headers: { authorization: `Basic ${Buffer.from("hooks:wrong", "utf8").toString("base64")}` } }), res, LABELLED);
	assert.equal(res.statusCode, 401);
	assert.equal(calls.length, 0);
});

test("the mechanism is NOT negotiated: a header-mode credential does not open a basic-mode endpoint", async () => {
	// A sender able to choose which gate it faces chooses the weakest available one.
	const { handler, calls } = build();
	const res = mockRes();
	await drive(handler, mockReq({ headers: { authorization: undefined, "x-pi-secret": BASIC } }), res, LABELLED);
	assert.equal(res.statusCode, 401);
	assert.equal(calls.length, 0);
});

test("header mode accepts its configured header and nothing else", async () => {
	const { handler, calls } = build({ azure: { mode: "header", secret: "s3cret", headerName: "X-Pi-Secret" } });
	const ok = mockRes();
	await drive(handler, mockReq({ headers: { authorization: undefined, "x-pi-secret": "s3cret" } }), ok, LABELLED);
	assert.equal(ok.statusCode, 202);
	assert.equal(calls.length, 1);

	const bad = mockRes();
	await drive(handler, mockReq({ headers: { authorization: undefined, "x-other": "s3cret" } }), bad, LABELLED);
	assert.equal(bad.statusCode, 401);
});

test("a delivery with no body id is 400 -- never run undeduplicated", async () => {
	// A synthesised key would dedup some redeliveries and bill for the rest: a weaker guarantee wearing
	// REQ-DEDUP-BY-DELIVERY-GUID's name, which is worse than a clear refusal.
	const { handler, calls } = build();
	const res = mockRes();
	const noId = JSON.stringify({ ...JSON.parse(LABELLED), id: undefined });
	await drive(handler, mockReq(), res, noId);
	assert.equal(res.statusCode, 400);
	assert.equal(calls.length, 0);
});

test("an indeterminate membership lookup is 503, and never names the actor", async () => {
	const logs = [];
	const { handler, calls } = build({ resolve: async () => ({ indeterminate: "azure lookup returned 500" }), logs });
	const res = mockRes();
	await drive(handler, mockReq(), res, LABELLED);
	assert.equal(res.statusCode, 503);
	assert.equal(calls.length, 0);
	assert.equal(logs.at(-1).event, "azure_membership_lookup_failed");
	assert.equal(JSON.stringify(logs).includes("dev@example.com"), false, "an address is personal data and exists only to have been asked about");
});

test("an unconfigured azure endpoint is 404, never 401", async () => {
	const { handler } = build({ azure: null });
	const res = mockRes();
	await drive(handler, mockReq(), res, LABELLED);
	assert.equal(res.statusCode, 404);
});

test("non-POST is 405 and a non-JSON content type is 415, before any credential check", async () => {
	const { handler } = build();
	const get = mockRes();
	await drive(handler, mockReq({ method: "GET" }), get, "");
	assert.equal(get.statusCode, 405);

	const form = mockRes();
	await drive(handler, mockReq({ headers: { "content-type": "application/x-www-form-urlencoded" } }), form, LABELLED);
	assert.equal(form.statusCode, 415);
});

test("an oversized declared body is 413 without reading it", async () => {
	const { handler } = build();
	const res = mockRes();
	await drive(handler, mockReq({ headers: { "content-length": String(3 * 1024 * 1024) } }), res, LABELLED);
	assert.equal(res.statusCode, 413);
});

// --- the credential compare itself ---

test("secretEquals is length-safe and value-correct", () => {
	assert.equal(secretEquals("abc", "abc"), true);
	assert.equal(secretEquals("abc", "abd"), false);
	assert.equal(secretEquals("abc", "abcd"), false, "different lengths must not throw -- timingSafeEqual requires equal buffers");
	assert.equal(secretEquals(undefined, ""), true, "both coerce to empty; the caller is responsible for refusing an empty secret");
	assert.equal(secretEquals("abc", undefined), false);
});

test("credentialOk reads only the mechanism its mode names", () => {
	const basic = { mode: "basic", secret: BASIC };
	assert.equal(credentialOk(basic, { authorization: `Basic ${BASIC}` }), true);
	assert.equal(credentialOk(basic, { authorization: `Bearer ${BASIC}` }), false, "a Bearer token is not Basic auth");
	assert.equal(credentialOk(basic, {}), false);

	const header = { mode: "header", secret: "s", headerName: "X-Pi" };
	assert.equal(credentialOk(header, { "x-pi": "s" }), true, "header names are matched case-insensitively, as node lowercases them");
	assert.equal(credentialOk(header, { authorization: "Basic s" }), false);

	assert.equal(credentialOk({ mode: "nonsense", secret: "s" }, { authorization: "Basic s" }), false, "an unknown mode admits nothing");
});

test("the credential compare is CONSTANT-TIME, asserted on the source because timing cannot be", async () => {
	// A `===` on a secret is a timing oracle, and it is behaviourally identical to a constant-time compare
	// for every input a unit test can supply -- so no assertion on RESULTS can tell them apart. This is the
	// same technique forges.test.mjs uses to pin "imports nothing": read the source and assert the property
	// that matters, because the alternative is a security control with no tripwire at all.
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../src/verify-azure.mjs", import.meta.url), "utf8");
	assert.match(source, /timingSafeEqual\(/, "the compare must go through node:crypto's constant-time primitive");
	assert.equal(
		/secretEquals[\s\S]{0,400}?===\s*String\(/.test(source),
		false,
		"a direct string comparison inside secretEquals leaks the secret one byte at a time",
	);
});
