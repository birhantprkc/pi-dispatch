import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareGithubWorkspace } from "../src/prepare-github.mjs";

const TOKEN = "ghs_SUPERSECRETTOKENvalue1234567890";
const SHA = "a".repeat(40);

const JOB = {
	kind: "github",
	repo: "owner/name",
	issueNumber: 7,
	flow: "frontend-fix",
	title: "Fix the header spacing",
	body: "The header is cramped. Please @owner fix it.",
	trigger: { event: "issues", action: "labeled", deliveryId: "guid-123", sender: { id: 42, login: "octocat" } },
};

/**
 * A fake git transport recording every `(cwd, args, opts)` call. `failOn` names a subcommand whose
 * invocation throws `error` (an octokit/execFile-style Error carrying `.stderr`), so a test can drive
 * the fetch to a gone-SHA or a network failure without any real git.
 */
function fakeGit({ failOn, error } = {}) {
	const calls = [];
	async function git(cwd, args, opts) {
		calls.push({ cwd, args, opts });
		if (failOn && args.includes(failOn)) throw error;
		return "";
	}
	git.calls = calls;
	return git;
}

/** A fake materialize capturing its args; returns a canned written-paths list. */
function fakeMaterialize(record) {
	return async (args) => {
		record.push(args);
		return ["pi/APPEND_SYSTEM.md", "pi/skills/tidy/SKILL.md"];
	};
}

/** Set up a real jobDir under tmp plus the standard fakes; return everything a test may assert on. */
function harness({ git, materializeRecord = [] } = {}) {
	const jobDir = mkdtempSync(join(tmpdir(), "pi-ghjob-"));
	const shaCalls = [];
	return {
		jobDir,
		shaCalls,
		materializeRecord,
		deps: {
			jobDir,
			git,
			resolveDefaultBranchSha: async (repo, token) => {
				shaCalls.push({ repo, token });
				return { branch: "main", sha: SHA };
			},
			materialize: fakeMaterialize(materializeRecord),
		},
	};
}

/** The git subcommand name for a hardened arg array (first element that is not a -c flag/value). */
function subcommandOf(args) {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-c") {
			i++; // skip the -c value
			continue;
		}
		if (args[i] === "--no-pager") continue;
		return args[i];
	}
	return undefined;
}

function callFor(git, sub) {
	return git.calls.find((c) => subcommandOf(c.args) === sub);
}

const HARDEN_EXPECTED = [
	"core.hooksPath=/dev/null",
	"core.fsmonitor=false",
	"protocol.ext.allow=never",
	"credential.helper=",
];

// -- 1 + 3: token never in argv, hardening flags present on init/fetch/checkout ------------------

test("token never appears in any git argv; init/fetch/checkout carry every hardening flag", async () => {
	const git = fakeGit();
	const h = harness({ git });
	await prepareGithubWorkspace(JOB, TOKEN, h.deps);

	for (const c of git.calls) {
		for (const a of c.args) {
			assert.ok(!String(a).includes(TOKEN), `token leaked into argv: ${a}`);
		}
	}

	for (const sub of ["init", "fetch", "checkout"]) {
		const c = callFor(git, sub);
		assert.ok(c, `expected a ${sub} call`);
		for (const flag of HARDEN_EXPECTED) {
			assert.ok(c.args.includes(flag), `${sub} missing hardening flag ${flag}`);
		}
		assert.ok(c.args.includes("--no-pager"), `${sub} missing --no-pager`);
	}
});

// -- 2: token reaches git only through the askpass env on the fetch call -------------------------

test("token is passed only via GIT_ASKPASS_TOKEN on the fetch; fetch env sets GIT_ASKPASS + prompt=0", async () => {
	const git = fakeGit();
	const h = harness({ git });
	await prepareGithubWorkspace(JOB, TOKEN, h.deps);

	const fetch = callFor(git, "fetch");
	assert.ok(fetch.opts?.env, "fetch must receive a network env");
	assert.equal(fetch.opts.env.GIT_ASKPASS_TOKEN, TOKEN, "token flows through the askpass env var");
	assert.equal(fetch.opts.env.GIT_TERMINAL_PROMPT, "0", "terminal prompt disabled");
	assert.ok(fetch.opts.env.GIT_ASKPASS, "GIT_ASKPASS points at the helper script");

	// The token is nowhere except that env var: not in init/checkout envs, not in any argv.
	for (const sub of ["init", "checkout"]) {
		const c = callFor(git, sub);
		assert.ok(!(c.opts?.env?.GIT_ASKPASS_TOKEN), `${sub} must not carry the token env`);
	}
});

// -- 4: the persisted remote is tokenless --------------------------------------------------------

test("remote add origin uses a tokenless https URL (no token, no x-access-token@)", async () => {
	const git = fakeGit();
	const h = harness({ git });
	await prepareGithubWorkspace(JOB, TOKEN, h.deps);

	const remote = git.calls.find((c) => c.args.includes("remote") && c.args.includes("add"));
	assert.ok(remote, "expected a remote add call");
	const url = remote.args[remote.args.length - 1];
	assert.equal(url, "https://github.com/owner/name.git");
	assert.ok(!url.includes(TOKEN), "no token in the remote URL");
	assert.ok(!url.includes("x-access-token"), "no x-access-token@ in the remote URL");
	assert.ok(!url.includes("@"), "no credential userinfo in the remote URL");
});

// -- 5: token never lands in any written job input ------------------------------------------------

test("token never appears in prompt.md or event.json, and the captured remote is tokenless", async () => {
	const git = fakeGit();
	const h = harness({ git });
	await prepareGithubWorkspace(JOB, TOKEN, h.deps);

	const prompt = readFileSync(join(h.jobDir, "prompt.md"), "utf8");
	const event = readFileSync(join(h.jobDir, "event.json"), "utf8");
	assert.ok(!prompt.includes(TOKEN), "token must not reach prompt.md");
	assert.ok(!event.includes(TOKEN), "token must not reach event.json");

	// With a fake git there is no real .git/config; the tokenless remote is proven via the argv.
	const remote = git.calls.find((c) => c.args.includes("remote") && c.args.includes("add"));
	assert.ok(!remote.args.some((a) => String(a).includes(TOKEN)), "no token in the remote-add argv");
});

// -- 6: gone-SHA is a policy return, NOT a throw --------------------------------------------------

test("a gone-SHA fetch (couldn't find remote ref) returns policy sha-gone, not thrown", async () => {
	const error = Object.assign(new Error("git fetch failed"), {
		stderr: `fatal: couldn't find remote ref ${SHA}\n`,
	});
	const git = fakeGit({ failOn: "fetch", error });
	const h = harness({ git });

	const result = await prepareGithubWorkspace(JOB, TOKEN, h.deps);
	assert.deepEqual(result, { outcome: "policy", reason: "sha-gone" });
});

test("each gone-SHA marker classifies as policy, never a retry", async () => {
	const markers = [
		"fatal: remote error: upload-pack: not our ref " + SHA,
		"fatal: bad object: unadvertised object " + SHA,
		"fatal: protocol error: bad pack header: did not send all necessary objects",
		`error: Object ${SHA} is a commit, but the tag reference is not a tree`,
	];
	for (const stderr of markers) {
		const git = fakeGit({ failOn: "fetch", error: Object.assign(new Error("x"), { stderr }) });
		const h = harness({ git });
		const result = await prepareGithubWorkspace(JOB, TOKEN, h.deps);
		assert.deepEqual(result, { outcome: "policy", reason: "sha-gone" }, `should be policy for: ${stderr}`);
	}
});

// -- 7: any other fetch failure throws InfraRetry (retryable) ------------------------------------

test("a network fetch failure (could not resolve host) throws InfraRetry", async () => {
	const error = Object.assign(new Error("git fetch failed"), {
		stderr: "fatal: unable to access 'https://github.com/owner/name.git/': Could not resolve host: github.com\n",
	});
	const git = fakeGit({ failOn: "fetch", error });
	const h = harness({ git });

	await assert.rejects(
		() => prepareGithubWorkspace(JOB, TOKEN, h.deps),
		(e) => e.piDispatchRetry === true && e.name === "InfraRetry",
	);
});

// -- 8: materializePiDir invoked with the workspace clone at the pinned SHA ----------------------

test("materialize is invoked with { gitDir: workspace, sha, destDir: jobDir }", async () => {
	const git = fakeGit();
	const record = [];
	const h = harness({ git, materializeRecord: record });
	await prepareGithubWorkspace(JOB, TOKEN, h.deps);

	assert.equal(record.length, 1);
	assert.equal(record[0].gitDir, join(h.jobDir, "workspace"));
	assert.equal(record[0].sha, SHA);
	assert.equal(record[0].destDir, h.jobDir);
});

// -- 9: event.json is the subset only, no header/signature/token ---------------------------------

test("event.json holds exactly the payload subset -- no header, signature, or token key", async () => {
	const git = fakeGit();
	const h = harness({ git });
	await prepareGithubWorkspace(JOB, TOKEN, h.deps);

	const event = JSON.parse(readFileSync(join(h.jobDir, "event.json"), "utf8"));
	assert.deepEqual(event, {
		event: "issues",
		action: "labeled",
		delivery: "guid-123",
		repository: { full_name: "owner/name" },
		issue: { number: 7, title: JOB.title, body: JOB.body },
		sender: { id: 42, login: "octocat" },
	});

	const serialized = JSON.stringify(event).toLowerCase();
	assert.ok(!serialized.includes("signature"), "no signature field");
	assert.ok(!serialized.includes("x-hub"), "no webhook header field");
	assert.ok(!serialized.includes("token"), "no token field");
	assert.ok(!serialized.includes(TOKEN.toLowerCase()), "no token value");
});

// -- 10: happy path return shape -----------------------------------------------------------------

test("happy path returns { workspace, jobDir, sha, materialised }", async () => {
	const git = fakeGit();
	const h = harness({ git });
	const result = await prepareGithubWorkspace(JOB, TOKEN, h.deps);

	assert.equal(result.workspace, join(h.jobDir, "workspace"));
	assert.equal(result.jobDir, h.jobDir);
	assert.equal(result.sha, SHA);
	assert.deepEqual(result.materialised, ["pi/APPEND_SYSTEM.md", "pi/skills/tidy/SKILL.md"]);

	// The SHA came from a fresh API resolve bound to this job's repo + token.
	assert.deepEqual(h.shaCalls, [{ repo: "owner/name", token: TOKEN }]);

	// prompt.md is the user prompt; it names the flow and quotes the issue body as data.
	const prompt = readFileSync(join(h.jobDir, "prompt.md"), "utf8");
	assert.ok(prompt.includes('Use the "frontend-fix" skill'));
	assert.ok(prompt.includes(JOB.body));
});
