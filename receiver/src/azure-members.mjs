/**
 * Resolve an Azure DevOps actor's project membership -- the enforcement half of
 * `CONST-TRIGGER-AUTHOR-GATE` on the Azure side.
 *
 * Azure has no `author_association` and no numeric access level. What it has is a graph of subjects and
 * groups, and "is this person a member of this project" is answered by walking it. That is TWO calls, not
 * one, which is a real cost this arm carries and the other three do not:
 *
 *   1. the actor -> a subject DESCRIPTOR. A pull-request payload gives a GUID, a work-item payload gives
 *      only an email address, so there are two lookups depending on which the event carried.
 *   2. the descriptor -> membership of the project's own group.
 *
 * Both can go indeterminate, so the indeterminate surface here is wider than GitLab's, not merely equal to
 * it. `OQ-013` is amended to say so rather than leaving it implied.
 *
 * The verdict shape is every other forge's: `{ authorized }` | `{ indeterminate }`. A determinate "not a
 * member" refuses; anything that could not be answered is a 503 so Azure redelivers.
 *
 * WHY MEMBERSHIP AND NOT A PERMISSION EVALUATION. Azure's Security namespace API can answer "may this
 * subject contribute to this repository" exactly, which is closer to the property the constitution wants.
 * It is not used, for one reason worth stating: it requires the caller to construct a security-namespace
 * token by hand, and a token constructed slightly wrong returns a confident answer about a DIFFERENT
 * object. Project membership is coarser and readable, and coarser-but-right beats exact-but-fragile on a
 * gate that decides whether a stranger can spend money.
 *
 * The email is never logged or returned; it is personal data with exactly one consumer, like Forgejo's
 * login and GitLab's username.
 */

import { fetchFailureReason } from "@pi-dispatch/worker/gitlab-identity";

/**
 * Build the resolver.
 *
 * `orgUrl` is `https://dev.azure.com/<org>`; the Graph API lives on a DIFFERENT host
 * (`https://vssps.dev.azure.com/<org>`), which is derived here rather than asked for, so an operator
 * configures one URL and cannot get the pair inconsistent.
 *
 * Returns `resolveAuthority(projectId, actor)` where `actor` is `{ id }` or `{ email }`.
 */
export function makeResolveAzureAuthority({ orgUrl, token, fetchFn = fetch }) {
	const root = String(orgUrl ?? "").replace(/\/+$/, "");
	const vssps = root.replace("https://dev.azure.com", "https://vssps.dev.azure.com");
	// Azure authenticates a PAT as HTTP Basic with an empty username.
	const auth = `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`;

	async function get(url) {
		let res;
		try {
			res = await fetchFn(url, { headers: { Authorization: auth, accept: "application/json" }, redirect: "error" });
		} catch (err) {
			return { indeterminate: fetchFailureReason(err) };
		}
		if (!res.ok) {
			// Status only. An Azure error body can echo the request, and the request carried the token.
			return { indeterminate: `azure lookup returned ${res.status}` };
		}
		try {
			return { body: await res.json() };
		} catch (err) {
			return { indeterminate: `azure lookup returned unparseable JSON: ${err?.message ?? "unknown"}` };
		}
	}

	return async function resolveAuthority(projectId, actor) {
		if (typeof projectId !== "string" || projectId === "") {
			// The payload named no project, so there is nothing to ask about. Determinate, and refused.
			return { authorized: false };
		}

		const descriptor = await resolveDescriptor(actor);
		if (descriptor.indeterminate) return descriptor;
		if (descriptor.value === null) return { authorized: false };

		// The project's own scope descriptor -- the container every project member belongs to.
		const scope = await get(`${vssps}/_apis/graph/descriptors/${encodeURIComponent(projectId)}?api-version=7.1-preview.1`);
		if (scope.indeterminate) return scope;
		const container = scope.body?.value;
		if (typeof container !== "string" || container === "") {
			// A 200 whose shape we do not recognise is not a refusal: answering `false` here would turn an
			// upstream schema change into a silent, permanent refusal of every trigger.
			return { indeterminate: "azure project descriptor lookup returned no descriptor" };
		}

		// Membership is TRANSITIVE via `direction=up`: a member of a team inside the project is a member of
		// the project, and asking only for direct membership would refuse most real organisations -- the same
		// mistake `members/all` avoids on GitLab.
		const memberships = await get(`${vssps}/_apis/graph/memberships/${encodeURIComponent(descriptor.value)}?direction=up&api-version=7.1-preview.1`);
		if (memberships.indeterminate) return memberships;
		const list = memberships.body?.value;
		if (!Array.isArray(list)) {
			return { indeterminate: "azure memberships lookup returned no array" };
		}
		return { authorized: list.some((m) => m?.containerDescriptor === container) };
	};

	/** The actor's subject descriptor: by GUID for a pull request, by email for a work item. */
	async function resolveDescriptor(actor) {
		if (typeof actor?.id === "string" && actor.id !== "") {
			const res = await get(`${vssps}/_apis/graph/descriptors/${encodeURIComponent(actor.id)}?api-version=7.1-preview.1`);
			if (res.indeterminate) return res;
			const value = res.body?.value;
			return { value: typeof value === "string" && value !== "" ? value : null };
		}
		if (typeof actor?.email === "string" && actor.email !== "") {
			// There is no lookup-by-email endpoint, so the users list is filtered. `subjectTypes=aad,msa`
			// excludes groups and service principals, which cannot be the human this gate is about.
			const res = await get(`${vssps}/_apis/graph/users?subjectTypes=aad,msa&api-version=7.1-preview.1`);
			if (res.indeterminate) return res;
			const users = res.body?.value;
			if (!Array.isArray(users)) return { indeterminate: "azure users lookup returned no array" };
			const wanted = actor.email.toLowerCase();
			const hit = users.find((u) => String(u?.principalName ?? "").toLowerCase() === wanted || String(u?.mailAddress ?? "").toLowerCase() === wanted);
			return { value: typeof hit?.descriptor === "string" ? hit.descriptor : null };
		}
		// Neither a GUID nor a parseable address: the delivery named nobody this gate can ask about.
		return { value: null };
	}
}
