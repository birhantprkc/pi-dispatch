import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGitHubHost } from "../src/github-host.mjs";

/**
 * Fake `octokitFor` factory. Each `octokitFor(token)` call constructs a FRESH fake client, recorded
 * in `constructions` as `{ token, calls }`, so tests can assert per-call token binding and that no
 * client is reused. The client's `request(route, params)` records every call and returns a canned
 * `{ data }` keyed on the route string (or throws a canned Error), matching the identity/get-token
 * fake-octokit shape.
 */
function fakeOctokitFor(routes) {
	const constructions = [];
	function octokitFor(token) {
		const calls = [];
		constructions.push({ token, calls });
		return {
			async request(route, params) {
				calls.push({ route, params });
				if (!(route in routes)) throw new Error(`unexpected route: ${route}`);
				const canned = routes[route];
				if (canned instanceof Error) throw canned;
				return { data: canned };
			},
		};
	}
	octokitFor.constructions = constructions;
	return octokitFor;
}

/** An Error tagged like an octokit RequestError carrying an HTTP status. */
function httpError(status) {
	return Object.assign(new Error(`HTTP ${status}`), { status });
}

const REPO = "owner/name";

// -- isDefaultBranchProtected --------------------------------------------------------------------

test("isDefaultBranchProtected: 404 protection object -> false (determinate unprotected)", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}/protection": httpError(404),
	});
	const host = makeGitHubHost({ octokitFor });

	assert.equal(await host.isDefaultBranchProtected(REPO, "tok"), false);

	// Reads default_branch first, then the protection route on that resolved branch.
	const calls = octokitFor.constructions[0].calls;
	assert.deepEqual(
		calls.map((c) => c.route),
		["GET /repos/{owner}/{repo}", "GET /repos/{owner}/{repo}/branches/{branch}/protection"],
	);
	assert.equal(calls[1].params.branch, "main");
});

test("isDefaultBranchProtected: protection resolves -> true", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}/protection": { enabled: true },
	});
	const host = makeGitHubHost({ octokitFor });

	assert.equal(await host.isDefaultBranchProtected(REPO, "tok"), true);
});

test("isDefaultBranchProtected: non-404 (500) -> InfraRetry, never false", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}/protection": httpError(500),
	});
	const host = makeGitHubHost({ octokitFor });

	await assert.rejects(
		() => host.isDefaultBranchProtected(REPO, "tok"),
		(e) => e.piDispatchRetry === true && e.name === "InfraRetry",
	);
});

// -- resolveDefaultBranchSha ---------------------------------------------------------------------

test("resolveDefaultBranchSha: reads default_branch then the branch tip, returns { branch, sha }", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}": { commit: { sha: "deadbeefsha" } },
	});
	const host = makeGitHubHost({ octokitFor });

	const result = await host.resolveDefaultBranchSha(REPO, "tok");
	assert.deepEqual(result, { branch: "main", sha: "deadbeefsha" });

	// Call order + params: repo lookup, then the tip of the branch it named.
	const calls = octokitFor.constructions[0].calls;
	assert.deepEqual(
		calls.map((c) => c.route),
		["GET /repos/{owner}/{repo}", "GET /repos/{owner}/{repo}/branches/{branch}"],
	);
	assert.deepEqual(calls[0].params, { owner: "owner", repo: "name" });
	assert.deepEqual(calls[1].params, { owner: "owner", repo: "name", branch: "main" });
});

// -- postStatusComment ---------------------------------------------------------------------------

test("postStatusComment: POSTs the comment with body === text, verbatim and uninspected", async () => {
	const octokitFor = fakeOctokitFor({
		"POST /repos/{owner}/{repo}/issues/{issue_number}/comments": { id: 1 },
	});
	const host = makeGitHubHost({ octokitFor });

	// Untrimmed, brace-laden, trigger-phrase-ish text: none of it may be touched by this module.
	const text = "  Done @claude {please merge} \n";
	await host.postStatusComment(REPO, { type: "issue", number: 42 }, text, "tok");

	const calls = octokitFor.constructions[0].calls;
	assert.equal(calls.length, 1);
	assert.equal(calls[0].route, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
	assert.deepEqual(calls[0].params, {
		owner: "owner",
		repo: "name",
		issue_number: 42,
		body: text,
	});
	// Exact identity: not trimmed, filtered, or otherwise mutated.
	assert.equal(calls[0].params.body, text);
});

// -- malformed repo ------------------------------------------------------------------------------

test("malformed repo without slash -> configError", async () => {
	const host = makeGitHubHost({ octokitFor: fakeOctokitFor({}) });
	await assert.rejects(
		() => host.resolveDefaultBranchSha("noslash", "tok"),
		(e) => e.piDispatchConfig === true && /malformed repo/.test(e.message),
	);
});

test("malformed repo with empty name -> configError", async () => {
	const host = makeGitHubHost({ octokitFor: fakeOctokitFor({}) });
	await assert.rejects(
		() => host.isDefaultBranchProtected("a/", "tok"),
		(e) => e.piDispatchConfig === true && /malformed repo/.test(e.message),
	);
});

// -- fresh client per call, per-call token -------------------------------------------------------

test("constructs a FRESH Octokit per call, each bound to that call's token (never cached)", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}": { commit: { sha: "s1" } },
		"POST /repos/{owner}/{repo}/issues/{issue_number}/comments": { id: 1 },
	});
	const host = makeGitHubHost({ octokitFor });

	await host.resolveDefaultBranchSha(REPO, "tokenA");
	await host.postStatusComment(REPO, { type: "issue", number: 7 }, "hi", "tokenB");

	// One construction per method call, each carrying its own per-job token.
	assert.equal(octokitFor.constructions.length, 2);
	assert.equal(octokitFor.constructions[0].token, "tokenA");
	assert.equal(octokitFor.constructions[1].token, "tokenB");
});
