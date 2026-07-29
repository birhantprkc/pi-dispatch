/**
 * GitLab authentication for the worker: the counterpart of get-token.mjs, yielding the identical
 * `{ mintToken, selfId, source }` shape so nothing downstream branches on which forge a job belongs to.
 *
 * CONST-TOKEN-SCOPED-PER-JOB, stated honestly rather than implied. GitLab has no GitHub App and no
 * per-job installation token: `POST /projects/:id/access_tokens` exists, but it must itself be called with
 * a PERSONAL access token, and its `expires_at` is date-granular. So the shipped source is `pat` -- an
 * operator-supplied project or group access token -- and it satisfies the constraint's properties like
 * this:
 *
 *   - repo-scoped         YES for a project access token; it reaches exactly one project.
 *   - host-held           YES; it lives in the worker's env and reaches a container only as an env value.
 *   - env-injected        YES; never written to /workspace, .git/config, argv, or a log.
 *   - not merge-capable   YES in practice; branch protection is the barrier, as on GitHub, and this
 *                         module calls no merge API of any kind.
 *   - minimally-permissioned  NO. `api` is the narrowest scope that can post a note, and it grants full
 *                         read/write to the project's API. GitLab offers no contents-vs-issues split.
 *   - short-lived         NO. The operator mints it by hand with a date expiry, up to a year out.
 *
 * The last two are a real gap, not a rounding error -- and they are the SAME gap the shipped GitHub `gh`
 * and `pat` sources already carry, which get-token.mjs states in its own header: per-job scoping is the
 * App path's property alone. So this introduces no new exception class; it inherits an accepted one. Where
 * it differs is that GitHub has a stronger path available and GitLab does not.
 *
 * All side-effecting collaborators are INJECTED, so the module is testable offline with no GitLab.
 */

import { configError } from "./config.mjs";
import { resolveGitLabSelfId } from "./gitlab-identity.mjs";

/**
 * Build the auth surface for `cfg = { source, apiUrl, tokenVar }`.
 *
 * Returns `{ mintToken, selfId, source }`:
 *   - `mintToken(job)` -> a non-empty token string (rejects, never returns empty).
 *   - `selfId` -> the acting bot user's integer id, resolved once here for the bot-loop guard.
 *   - `source` -> the configured source, echoed back.
 *
 * Fails CLOSED at construction: an empty token or an unresolvable identity throws before returning, so a
 * misconfigured worker refuses to boot rather than running jobs it cannot report on.
 */
export async function makeGitLabAuth(cfg, deps = {}) {
	const { env = process.env, fetchFn = fetch } = deps;
	const source = cfg?.source;
	if (source !== "pat") {
		throw configError(`makeGitLabAuth: unknown or missing source: ${JSON.stringify(source)} (only "pat" is supported -- GitLab has no App equivalent)`);
	}

	const tokenVar = cfg.tokenVar ?? "GITLAB_TOKEN";
	const token = requireToken(env[tokenVar], tokenVar);
	const selfId = await resolveGitLabSelfId({ apiUrl: cfg.apiUrl, token, fetchFn });

	// Ignores the job by design: one operator-supplied token serves every project this deployment
	// services, exactly as the github `pat` source does. The parameter exists so the shape matches.
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
		throw configError(`${what} is empty or unset; refusing to hand a job an empty GitLab credential`);
	}
	return token;
}
