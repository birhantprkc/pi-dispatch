/**
 * Resolve a GitLab actor's project access level -- the enforcement half of `CONST-TRIGGER-AUTHOR-GATE` on
 * the GitLab side.
 *
 * GitHub puts `author_association` in the payload, so its gate is decidable from the delivery alone.
 * GitLab puts nothing equivalent anywhere in a webhook body, so the level has to be ASKED FOR. That single
 * fact shapes everything here:
 *
 *   - It runs in the receiver, between verification and `filterGitLab`, and the answer is passed into the
 *     gate as a plain number. The gate stays pure, total and offline-testable; a fetch inside it would
 *     make the security-critical decision untestable without a server.
 *   - It runs AFTER verification, never before, so an unauthenticated flood cannot make this project issue
 *     API calls on an attacker's behalf.
 *   - It distinguishes "not a member" from "could not tell", and those are different answers. A 404 is
 *     determinate and yields level 0, which the gate refuses. Anything else -- a 5xx, a dead socket, a
 *     revoked token -- is INDETERMINATE, and the receiver answers 503 so GitLab redelivers. Collapsing
 *     indeterminate to "deny" would silently drop legitimate work during an outage, with a 204 that reads
 *     exactly like a correctly-refused stranger.
 *
 * `members/all` and not `members`: the `all` variant includes membership inherited from a parent group,
 * which is how most real GitLab organisations grant access. The plain endpoint reports only direct members
 * and would refuse a maintainer who holds their role at the group level -- a denial that looks like a
 * policy decision and is really a wrong question.
 *
 * The username is never sent, logged or returned; the lookup is by numeric user id.
 */

/** GitLab's API path prefix. `apiUrl` is the instance root, e.g. `https://gitlab.com`. */
const API_PREFIX = "/api/v4";

/**
 * Build the resolver. `token` is the same operator-supplied access token the worker uses; `fetchFn` is
 * injected so the whole module is testable offline.
 *
 * Returns `resolveAccessLevel(projectId, userId)` -> `{ level: number }` | `{ indeterminate: string }`.
 */
export function makeResolveAccessLevel({ apiUrl, token, fetchFn = fetch }) {
	return async function resolveAccessLevel(projectId, userId) {
		if (!Number.isInteger(projectId) || !Number.isInteger(userId)) {
			// Not a lookup failure -- the payload never named a project or an actor, so there is nothing to
			// ask about. Determinate, and the gate refuses it.
			return { level: 0 };
		}
		const url = `${String(apiUrl).replace(/\/+$/, "")}${API_PREFIX}/projects/${projectId}/members/all/${userId}`;
		let res;
		try {
			res = await fetchFn(url, { headers: { "PRIVATE-TOKEN": token }, redirect: "error" });
		} catch (err) {
			return { indeterminate: err?.message ?? "network error" };
		}
		if (res.status === 404) {
			// GitLab's documented answer for "this user is not a member of this project", including via any
			// ancestor group. The one status this may read as a refusal rather than a failure.
			return { level: 0 };
		}
		if (!res.ok) {
			return { indeterminate: `members lookup returned ${res.status}` };
		}
		let body;
		try {
			body = await res.json();
		} catch (err) {
			return { indeterminate: `members lookup returned unparseable JSON: ${err?.message ?? "unknown"}` };
		}
		const level = body?.access_level;
		if (!Number.isInteger(level)) {
			// A 200 whose shape we do not recognise is not a zero. Reporting level 0 here would turn an
			// upstream schema change into a silent, permanent refusal of every trigger.
			return { indeterminate: "members lookup returned no integer access_level" };
		}
		return { level };
	};
}
