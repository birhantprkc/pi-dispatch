/**
 * INT-GITLAB-PAYLOAD-SUBSET: the exact set of GitLab webhook fields this project reads, and nothing else.
 *
 * Naming the subset IS the contract, for the same reason `parseSubset` does it on the GitHub side: because
 * everything unlisted is ignored by construction, an upstream schema addition cannot change our behaviour,
 * and a reviewer sees the whole attack surface as one list rather than inferring it from destructuring
 * scattered across a handler. Every field here is attacker-controlled except the headers, and the headers
 * are only trustworthy after verify-gitlab.mjs has run.
 *
 * Three fields have no GitHub counterpart and are the reason this is a separate projection rather than a
 * rename of the other one:
 *
 *   - `changes.labels` -- on GitLab, adding a label is not an action. It arrives as `action: "update"`
 *     with a before/after diff, so the DIFF is the trigger and the current label set is not. Carrying only
 *     the set would make every later edit of an already-labelled issue re-fire (filter-gitlab.mjs).
 *   - `noteable_type` -- how a comment says whether it is on an issue or a merge request. GitHub uses the
 *     presence of `issue.pull_request`; GitLab states it.
 *   - `user.username` -- carried, where GitHub's `sender.login` is deliberately dropped, because GitLab
 *     puts no access level in the payload and the member lookup needs an identity. It is PERSONAL DATA: it
 *     exists to be handed to the resolver, and must never enter a log line, the job, or the run record.
 *
 * `iid` and not `id`: `iid` is the per-project number a human sees and an API path takes. `id` is a global
 * database key that would produce a valid-looking URL to somebody else's issue.
 */

/** Map one label array (`[{ title }]`) to `[{ name }]`, so the shared predicate helpers read one shape. */
function labelNames(labels) {
	return Array.isArray(labels) ? labels.map((l) => ({ name: l?.title })) : [];
}

/**
 * Project a verified GitLab payload down to the subset above. Total: a malformed or partial payload yields
 * a record with missing fields, never a throw -- the gate is what refuses it, and it does so by finding
 * nothing to match rather than by crashing the endpoint.
 */
export function parseGitLabSubset(payload) {
	const oa = payload?.object_attributes ?? {};
	const changes = payload?.changes ?? {};
	return {
		objectKind: payload?.object_kind,
		action: oa.action,
		user: { id: payload?.user?.id, username: payload?.user?.username },
		project: {
			id: payload?.project?.id,
			path: payload?.project?.path_with_namespace,
			defaultBranch: payload?.project?.default_branch,
		},
		// The issue or merge request the event is about. A note event carries the noteable under its own
		// key (`issue` / `merge_request`) instead of in object_attributes, which holds the note itself.
		target: targetOf(payload, oa),
		note: oa.note,
		noteableType: oa.noteable_type,
		labels: labelNames(oa.labels),
		// Present ONLY when this event changed the labels. Absent is meaningful: it says no label moved,
		// which is what stops an unrelated `update` from re-firing a label rule.
		labelChanges: changes.labels
			? { previous: labelNames(changes.labels.previous), current: labelNames(changes.labels.current) }
			: undefined,
		// A merge-request `update` carrying `oldrev` is a push to the source branch -- GitLab's analogue of
		// GitHub's `synchronize`, which it has no distinct action for.
		oldrev: oa.oldrev,
	};
}

function targetOf(payload, oa) {
	if (payload?.object_kind === "note") {
		const noteable = oa.noteable_type === "MergeRequest" ? payload?.merge_request : payload?.issue;
		return {
			iid: noteable?.iid,
			title: noteable?.title,
			description: noteable?.description,
			labels: labelNames(noteable?.labels),
		};
	}
	return { iid: oa.iid, title: oa.title, description: oa.description, labels: labelNames(oa.labels) };
}
