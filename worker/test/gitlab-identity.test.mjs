import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGitLabSelfId } from "../src/gitlab-identity.mjs";

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("resolves the acting bot user's integer id from GET /user", async () => {
	let seen = null;
	const id = await resolveGitLabSelfId({
		apiUrl: "https://gl.internal/",
		token: "glpat-x",
		fetchFn: async (url, init) => ((seen = { url, init }), ok({ id: 4242, username: "pi-bot" })),
	});
	assert.equal(id, 4242);
	assert.equal(seen.url, "https://gl.internal/api/v4/user", "a trailing slash on the instance URL must not double up");
	assert.equal(seen.init.headers["PRIVATE-TOKEN"], "glpat-x");
});

test("EVERY failure throws -- an unresolved id would disarm the bot-loop guard", async () => {
	// The guard's only job is to refuse events that came from us. Returning null here would let the
	// receiver boot with the guard silently off, and one status comment becomes an unbounded paid loop.
	const cases = [
		["empty token", { token: "" }],
		["http error", { fetchFn: async () => ok({}, 401) }],
		["unparseable body", { fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }) }],
		["no integer id", { fetchFn: async () => ok({ id: "4242" }) }],
		["network fault", { fetchFn: async () => { throw new Error("ECONNREFUSED"); } }],
	];
	for (const [name, over] of cases) {
		await assert.rejects(
			() => resolveGitLabSelfId({ apiUrl: "https://gl", token: "glpat-x", fetchFn: async () => ok({ id: 1 }), ...over }),
			(e) => e.piDispatchConfig === true,
			`${name} must fail closed with a configError`,
		);
	}
});

test("an error body is never echoed -- only the status reaches the message", async () => {
	// A GitLab error body can quote the request, and the request carried the token.
	await assert.rejects(
		() => resolveGitLabSelfId({ apiUrl: "https://gl", token: "glpat-SECRET", fetchFn: async () => ok({ message: "401 Unauthorized for glpat-SECRET" }, 401) }),
		(e) => e.piDispatchConfig === true && !e.message.includes("glpat-SECRET"),
	);
});
