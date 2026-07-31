/**
 * Azure DevOps authentication for the worker, yielding the identical `{ mintToken, selfId, source }` shape
 * every other forge does.
 *
 * CONST-TOKEN-SCOPED-PER-JOB, and the interesting thing here is the SYMMETRY with Forgejo: the two new
 * forges fail OPPOSITE halves of this constraint.
 *
 *   - short-lived         YES, and better than Forgejo's or GitLab's: an Azure PAT carries a real expiry
 *                         the operator chooses, up to a year, and the organization can cap it by policy.
 *   - repo-scoped         NO, not by the token. PAT scopes are ORGANIZATION-wide -- `vso.code_write` grants
 *                         write to every repository in the org, and there is no per-repository scope to
 *                         select. The bound has to come from somewhere else.
 *   - host-held           YES; it lives in the worker's env and reaches a container only as an env value.
 *   - env-injected        YES; never written to /workspace, .git/config, argv, or a log.
 *   - not merge-capable   YES in practice; branch policies are the barrier and no completion API is called.
 *   - minimally-permissioned  Partly. The scopes are coarse, but they ARE separable: `vso.code_write` does
 *                         not imply `vso.work_write`, unlike GitLab's all-or-nothing `api`.
 *
 * SO THE OPERATOR OBLIGATION IS DIFFERENT IN KIND, and the docs have to say which. On GitLab and Forgejo it
 * is "rotate it, because nothing expires it". On Azure the expiry is fine and the SCOPE is the gap: the
 * token must belong to a dedicated identity whose per-repository permissions are set in Project Settings,
 * because that identity's own access -- not the token's scopes -- is what bounds the blast radius.
 *
 * All side-effecting collaborators are INJECTED, so the module is testable offline with no Azure.
 */

import { configError } from "./config.mjs";
import { resolveAzureSelfId } from "./azure-identity.mjs";

/** Build the auth surface for `cfg = { source, orgUrl, tokenVar }`. Fails CLOSED at construction. */
export async function makeAzureAuth(cfg, deps = {}) {
	const { env = process.env, fetchFn = fetch } = deps;
	const source = cfg?.source;
	if (source !== "pat") {
		throw configError(`makeAzureAuth: unknown or missing source: ${JSON.stringify(source)} (only "pat" is supported -- Azure DevOps has no App or installation-token equivalent)`);
	}

	const tokenVar = cfg.tokenVar ?? "AZURE_TOKEN";
	const token = requireToken(env[tokenVar], tokenVar);
	const selfId = await resolveAzureSelfId({ orgUrl: cfg.orgUrl, token, fetchFn });

	// Ignores the job by design: one operator-supplied token serves every project this deployment services,
	// exactly as the other forges' pat sources do. The parameter exists so the shape matches.
	const mintToken = async () => requireToken(token, tokenVar);
	return { mintToken, selfId, source };
}

/**
 * The money-hole invariant, mirrored from get-token.mjs: return a trimmed non-empty token, or throw.
 *
 * An empty credential would reach env-allowlist's truthiness check as falsy, the token would be OMITTED
 * from the container env entirely, and the job would run anonymously -- a silent, paid, useless run rather
 * than an error.
 */
function requireToken(raw, what) {
	const token = typeof raw === "string" ? raw.trim() : "";
	if (token === "") {
		throw configError(`${what} is empty or unset; refusing to hand a job an empty Azure DevOps credential`);
	}
	return token;
}
