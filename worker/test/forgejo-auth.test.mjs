import assert from "node:assert/strict";
import { test } from "node:test";
import { makeForgejoAuth } from "../src/forgejo-auth.mjs";

const CFG = { source: "pat", apiUrl: "https://fj", tokenVar: "FORGEJO_TOKEN", botId: "42" };
const never = () => {
	throw new Error("fetch must not be called");
};

test("the pat source mints the operator token and resolves an identity", async () => {
	const auth = await makeForgejoAuth(CFG, { env: { FORGEJO_TOKEN: "  fj-tok  " }, fetchFn: never });
	assert.equal(await auth.mintToken({ kind: "forgejo" }), "fj-tok", "trimmed, so a stray newline in .env cannot become part of the credential");
	assert.equal(auth.selfId, 42);
	assert.equal(auth.source, "pat");
});

test("`app` is refused BY NAME -- an App does not exist on Forgejo, it is not merely unconfigured", async () => {
	// It is the value most likely to arrive here, from an operator copying the GitHub block. A worker that
	// quietly fell back to `pat` would hide that the stronger path they thought they had chosen is fiction.
	for (const source of ["app", "gh", undefined, ""]) {
		await assert.rejects(
			() => makeForgejoAuth({ ...CFG, source }, { env: { FORGEJO_TOKEN: "t" }, fetchFn: never }),
			(e) => e.piDispatchConfig === true,
			`source ${JSON.stringify(source)} must refuse`,
		);
	}
});

test("an empty token refuses rather than handing a job an anonymous run", async () => {
	// An empty credential reaches env-allowlist's truthiness check as falsy, the variable is omitted from
	// the container env entirely, and the job runs anonymously: a silent, paid, useless run.
	for (const FORGEJO_TOKEN of ["", "   ", undefined]) {
		await assert.rejects(
			() => makeForgejoAuth(CFG, { env: { FORGEJO_TOKEN }, fetchFn: never }),
			(e) => e.piDispatchConfig === true,
			`token ${JSON.stringify(FORGEJO_TOKEN)} must refuse`,
		);
	}
});

test("an unresolvable identity refuses at construction -- the worker must not boot without one", async () => {
	await assert.rejects(
		() =>
			makeForgejoAuth(
				{ ...CFG, botId: null },
				{ env: { FORGEJO_TOKEN: "t" }, fetchFn: async () => ({ ok: false, status: 403, json: async () => ({}) }) },
			),
		(e) => e.piDispatchConfig === true && e.message.includes("FORGEJO_BOT_ID"),
		"a repo-scoped token cannot call GET /user, and the message has to say so",
	);
});

test("the shape matches every other forge's, so nothing downstream branches on the forge", async () => {
	const auth = await makeForgejoAuth(CFG, { env: { FORGEJO_TOKEN: "t" }, fetchFn: never });
	assert.deepEqual(Object.keys(auth).sort(), ["mintToken", "selfId", "source"]);
});
