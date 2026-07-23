/**
 * Host-side GitHub reads and writes the worker performs AROUND a job, distinct from anything the
 * agent does inside its container: resolve the default-branch tip, decide whether that branch is
 * protected, and post an outcome comment back to the triggering issue.
 *
 * REQ-BRANCH-PROTECTION-PRECONDITION / CONST-MERGE-NEVER-AUTOMATIC: `isDefaultBranchProtected` is
 * the free gate the processor consults before spending. The agent's scoped token carries
 * contents:write, which covers push AND merge, so branch protection is the only technical barrier
 * to a self-merge. A transient read failure must therefore NOT collapse to "unprotected" and let
 * the job run: only a real 404 (the repo has no protection object) is the determinate unprotected
 * state that drives the policy refusal; any other error is retryable and never a silent `false`.
 *
 * REQ-JOB-STATUS-COMMENTS: `postStatusComment` reports outcome to the issue or PR. It is content-
 * agnostic -- the no-trigger-phrase guard belongs to the caller -- and never logs the comment body or
 * any issue/PR-derived content (no-pii-in-logs); a job is identified by `repo#number` alone.
 *
 * CONST-TOKEN-SCOPED-PER-JOB: the token is minted per job and passed to every method. Each method
 * constructs a FRESH Octokit through the injected `octokitFor(token)`; no client is cached or reused
 * across calls, so one job's short-lived credential never bleeds into another job's request.
 *
 * `octokitFor` is injected -- defaulting to the real `@octokit/rest` -- so the module is testable
 * offline against a fake `request(route, params)`, matching the identity.mjs / get-token.mjs
 * convention. This module calls NO merge API of any kind.
 */

import { Octokit } from "@octokit/rest";
import { configError } from "./config.mjs";
import { InfraRetry } from "./processor.mjs";

/**
 * Build the host surface. `octokitFor` is `(token) => new Octokit({ auth: token })`; inject a fake
 * to test offline. Returns `{ resolveDefaultBranchSha, isDefaultBranchProtected, postStatusComment }`.
 */
export function makeGitHubHost({ octokitFor = (token) => new Octokit({ auth: token }) } = {}) {
	/**
	 * Resolve the default branch and its tip SHA with FRESH API calls only -- never a webhook field.
	 * `GET /repos/{owner}/{repo}` yields `default_branch`; `GET .../branches/{branch}` yields the tip.
	 * Returns `{ branch, sha }` so the caller has both the name and the commit to clone at.
	 */
	async function resolveDefaultBranchSha(repo, token) {
		const [owner, name] = splitRepo(repo);
		const octokit = octokitFor(token);
		const { data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", {
			owner,
			repo: name,
		});
		const branch = repoData.default_branch;
		const { data: branchData } = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
			owner,
			repo: name,
			branch,
		});
		return { branch, sha: branchData.commit.sha };
	}

	/**
	 * True when the default branch has a protection object, false when it provably does not (404).
	 * A non-404 error is retryable, NOT `false`: a transient blip must not read as "unprotected" and
	 * bypass the never-merge backstop.
	 */
	async function isDefaultBranchProtected(repo, token) {
		const [owner, name] = splitRepo(repo);
		const octokit = octokitFor(token);
		const { data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", {
			owner,
			repo: name,
		});
		const branch = repoData.default_branch;
		try {
			await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
				owner,
				repo: name,
				branch,
			});
			return true;
		} catch (error) {
			// A missing protection object is a real, determinate state -- the repo is unprotected.
			if (error?.status === 404) return false;
			// Any other status is retryable rather than resolved. A 403 (the token lacks the scope to
			// read protection) is treated as InfraRetry here too: acceptable for v1, though it could be
			// a permanent config error. Collapsing non-404 to false would silently bypass never-merge.
			throw new InfraRetry(
				`github-host: branch-protection read failed for ${owner}/${name} (status ${error?.status ?? "unknown"})`,
			);
		}
	}

	/**
	 * Post `text` as an issue comment. `number` is an issue OR a pull request number -- a PR shares the
	 * `/issues/{n}/comments` endpoint, so posting to a PR number comments on the PR conversation.
	 * Content-agnostic: `text` is passed through as `body` verbatim, never inspected, filtered, or logged.
	 */
	async function postStatusComment(repo, number, text, token) {
		const [owner, name] = splitRepo(repo);
		const octokit = octokitFor(token);
		await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
			owner,
			repo: name,
			issue_number: number,
			body: text,
		});
	}

	return { resolveDefaultBranchSha, isDefaultBranchProtected, postStatusComment };
}

/** Split `"owner/name"` into `[owner, name]`, throwing configError unless both parts are non-empty. */
function splitRepo(repo) {
	const [owner, name] = String(repo ?? "").split("/");
	if (!owner || !name) {
		throw configError(`github-host: malformed repo: ${JSON.stringify(repo)} (expected "owner/name")`);
	}
	return [owner, name];
}
