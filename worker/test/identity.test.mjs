import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSelfId } from "../src/identity.mjs";

/**
 * Hand-rolled fake @octokit/rest: `request(route, params)` returns a canned `{ data }` keyed on the
 * route string. `calls` records every (route, params) so tests can assert the two-step app path.
 */
function fakeOctokit(routes) {
	const calls = [];
	return {
		calls,
		async request(route, params) {
			calls.push({ route, params });
			if (!(route in routes)) throw new Error(`unexpected route: ${route}`);
			const canned = routes[route];
			if (canned instanceof Error) throw canned;
			return { data: canned };
		},
	};
}

test("pat: GET /user id is returned", async () => {
	const octokit = fakeOctokit({ "GET /user": { id: 4242, login: "octo" } });
	const id = await resolveSelfId({ source: "pat", octokit });
	assert.equal(id, 4242);
	assert.deepEqual(
		octokit.calls.map((c) => c.route),
		["GET /user"],
	);
});

test("gh: GET /user id is returned", async () => {
	const octokit = fakeOctokit({ "GET /user": { id: 77, login: "runner" } });
	assert.equal(await resolveSelfId({ source: "gh", octokit }), 77);
});

test("app: resolves slug[bot] user id via GET /app then GET /users/{username}", async () => {
	const octokit = fakeOctokit({
		"GET /app": { slug: "pi-dispatch", id: 9001 },
		"GET /users/{username}": { id: 555123, login: "pi-dispatch[bot]" },
	});
	const id = await resolveSelfId({ source: "app", octokit });
	// The BOT USER id (sender.id), not the App id.
	assert.equal(id, 555123);
	assert.deepEqual(
		octokit.calls.map((c) => c.route),
		["GET /app", "GET /users/{username}"],
	);
	assert.equal(octokit.calls[1].params.username, "pi-dispatch[bot]");
});

test("octokit rejection (401) is rethrown as a tagged config error", async () => {
	const octokit = fakeOctokit({ "GET /user": new Error("HttpError: Bad credentials (401)") });
	await assert.rejects(
		() => resolveSelfId({ source: "pat", octokit }),
		(e) => {
			assert.equal(e.piDispatchConfig, true);
			assert.match(e.message, /could not resolve self identity/);
			return true;
		},
	);
});

test("unknown source is a config error", async () => {
	const octokit = fakeOctokit({});
	await assert.rejects(
		() => resolveSelfId({ source: "oauth", octokit }),
		(e) => e.piDispatchConfig === true && /unknown auth source/.test(e.message),
	);
});

test("missing source is a config error", async () => {
	const octokit = fakeOctokit({});
	await assert.rejects(
		() => resolveSelfId({ octokit }),
		(e) => e.piDispatchConfig === true && /unknown auth source/.test(e.message),
	);
});

test("non-integer id is a config error", async () => {
	const octokit = fakeOctokit({ "GET /user": { id: "4242", login: "octo" } });
	await assert.rejects(
		() => resolveSelfId({ source: "pat", octokit }),
		(e) => e.piDispatchConfig === true && /not an integer/.test(e.message),
	);
});

test("undefined id is a config error", async () => {
	const octokit = fakeOctokit({ "GET /user": { login: "octo" } });
	await assert.rejects(
		() => resolveSelfId({ source: "pat", octokit }),
		(e) => e.piDispatchConfig === true && /not an integer/.test(e.message),
	);
});

test("missing octokit is a config error", async () => {
	await assert.rejects(
		() => resolveSelfId({ source: "pat" }),
		(e) => e.piDispatchConfig === true && /missing octokit/.test(e.message),
	);
});
