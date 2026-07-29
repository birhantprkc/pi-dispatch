import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGitLabAuth } from "../src/gitlab-auth.mjs";

const okUser = async () => ({ ok: true, status: 200, json: async () => ({ id: 4242 }) });
const build = (over = {}) =>
	makeGitLabAuth({ source: "pat", apiUrl: "https://gl.test", ...over.cfg }, { env: { GITLAB_TOKEN: "glpat-x" }, fetchFn: okUser, ...over.deps });

test("returns the SAME { mintToken, selfId, source } shape the github auth returns", async () => {
	const auth = await build();
	assert.deepEqual(Object.keys(auth).sort(), ["mintToken", "selfId", "source"], "identical shape is what keeps the processor from branching on forge");
	assert.equal(auth.selfId, 4242);
	assert.equal(auth.source, "pat");
	assert.equal(await auth.mintToken({ kind: "gitlab", repo: "g/p" }), "glpat-x");
});

test("mintToken NEVER returns empty -- an empty credential is a silent anonymous paid run", async () => {
	// env-allowlist omits the variable entirely when the token is falsy, so the job would run with no
	// credential at all rather than failing.
	for (const raw of ["", "   ", undefined]) {
		await assert.rejects(
			() => build({ deps: { env: { GITLAB_TOKEN: raw } } }),
			(e) => e.piDispatchConfig === true,
			`token ${JSON.stringify(raw)} must refuse at construction`,
		);
	}
});

test("a token is trimmed, so trailing whitespace from a pasted secret does not reach the container", async () => {
	const auth = await build({ deps: { env: { GITLAB_TOKEN: "  glpat-x\n" } } });
	assert.equal(await auth.mintToken({}), "glpat-x");
});

test("any source other than pat refuses -- GitLab has no App equivalent to fall back to", async () => {
	for (const source of ["app", "gh", "oauth", undefined]) {
		await assert.rejects(() => build({ cfg: { source } }), (e) => e.piDispatchConfig === true);
	}
});

test("an unresolvable identity refuses at CONSTRUCTION, so the worker never boots without a selfId", async () => {
	await assert.rejects(
		() => build({ deps: { fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) } }),
		(e) => e.piDispatchConfig === true,
	);
});
