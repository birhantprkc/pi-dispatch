/**
 * Project ONLY the fields the Azure DevOps gate and job are allowed to see (`INT-AZURE-PAYLOAD-SUBSET`).
 *
 * The third sibling of `parseSubset` and `parseGitLabSubset`, and the least like either. Where Forgejo's
 * payload is GitHub's with three differences, Azure's shares almost nothing:
 *
 *   1. NO DELIVERY-ID HEADER. Azure sends none at all. The only per-delivery unique value is the body's
 *      top-level `id`, a GUID. (Issue #43 proposes `notificationId`, which is WRONG: it is a
 *      per-subscription integer sequence -- 1, 2, 3 -- so two subscriptions collide on delivery 1.)
 *   2. TWO ACTOR REPRESENTATIONS, inside one forge. A pull-request event carries
 *      `resource.createdBy.id`, a GUID. A work-item event carries the actor only as the string
 *      `"Display Name <email>"` in `System.CreatedBy`/`System.ChangedBy`, with no id anywhere. So both the
 *      author gate and the bot-loop guard need two extractions on one forge -- see `actorOf`.
 *   3. TAGS ARE A SEMICOLON STRING, not `[{name}]`, and on an update they arrive as a DIFF. The diff is
 *      the trigger; see `tagChange`.
 *   4. THE SCOPE IS A TRIPLE. `org/project/repo`, not `owner/repo`.
 *
 * Everything else in the delivery is ignored -- including `message`/`detailedMessage`, which are
 * pre-rendered prose containing the work item's title and are exactly the kind of field that looks
 * convenient and drags untrusted text into places it was never classified for.
 */

/** The Service Hook event ids this project consumes. Anything else is an unhandled event. */
export const WORK_ITEM_EVENTS = new Set(["workitem.created", "workitem.updated", "workitem.commented"]);
export const PR_EVENTS = new Set(["git.pullrequest.created", "git.pullrequest.updated"]);
export const PR_COMMENT_EVENT = "ms.vss-code.git-pullrequest-comment-event";

/**
 * Split Azure's `System.Tags` into the `[{ name }]` shape `predicate.mjs` reads.
 *
 * Azure renders tags as one string. Which SEPARATOR spacing it uses has varied (`"a;b"` and `"a; b"` both
 * occur across versions and resource versions), so every part is trimmed and empties dropped -- a tag list
 * that silently matched nothing because of a space would look exactly like a trigger nobody armed.
 */
export function parseTags(raw) {
	if (typeof raw !== "string") return [];
	return raw
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.map((name) => ({ name }));
}

/**
 * The tag change on a work-item update, as `{ previous, current }`, or `undefined` when this event carries
 * no tag change at all.
 *
 * THE DIFF IS THE TRIGGER, and this is the single most expensive thing to get wrong on this forge. Azure
 * has no `labeled` event: a tag change arrives as `workitem.updated` with a `fields` map of
 * `{ oldValue, newValue }` pairs. Matching the CURRENT tag set instead of the change would fire the
 * trigger again on every later edit of any field on that work item -- a paid run per typo fix, forever.
 *
 * `filter-gitlab.mjs` documents this exact trap for GitLab's `changes.labels`, and its `no-label-change`
 * drop is the existing machinery. Azure is its second customer.
 */
export function tagChange(fields) {
	const entry = fields?.["System.Tags"];
	if (entry === null || typeof entry !== "object") return undefined;
	// `oldValue` is absent when the field had no previous value -- a first tag on an untagged work item --
	// which is a real change and must read as "previously empty", not as "no change".
	return { previous: parseTags(entry.oldValue), current: parseTags(entry.newValue) };
}

/**
 * The actor, in whichever form this event carries one: `{ id }` for a GUID, `{ email }` for a work item's
 * `"Display Name <email>"` string, or `{}` when neither is present.
 *
 * The address is extracted with an ANCHORED trailing `<...>` match and lowercased. The display-name half is
 * attacker-settable -- a user can call themselves anything -- so a substring test would let
 * `"pi-bot@example.com is not me <mallory@evil.test>"` read as the harness and defeat the bot-loop guard,
 * or read as a member and defeat the author gate. Neither is a theoretical concern: both gates compare
 * against this value.
 */
export function actorOf(payload) {
	const resource = payload?.resource;
	const guid = resource?.createdBy?.id ?? resource?.comment?.author?.id ?? resource?.pullRequest?.createdBy?.id;
	if (typeof guid === "string" && guid !== "") return { id: guid };

	const fields = resource?.fields;
	// On an update, `System.ChangedBy` is a `{ oldValue, newValue }` pair like every other changed field;
	// on a create it is a bare string. The person who acted is the NEW value.
	const changedBy = fields?.["System.ChangedBy"];
	const raw = typeof changedBy === "object" && changedBy !== null ? changedBy.newValue : (changedBy ?? fields?.["System.CreatedBy"]);
	const email = extractEmail(raw);
	return email === null ? {} : { email };
}

/** The address inside a trailing `<...>`, lowercased, or `null`. Anchored -- see `actorOf`. */
export function extractEmail(raw) {
	if (typeof raw !== "string") return null;
	const match = raw.trim().match(/<([^<>]+)>$/);
	if (match) return match[1].trim().toLowerCase();
	// A bare address with no display name is also legal, and is accepted only when the WHOLE string is one.
	const bare = raw.trim();
	return /^[^\s<>@]+@[^\s<>@]+$/.test(bare) ? bare.toLowerCase() : null;
}

/**
 * The field value for a work item, unwrapping the `{ oldValue, newValue }` shape an update uses. A create
 * carries bare values; an update carries pairs for the fields that changed and nothing for the rest.
 */
function fieldValue(fields, name) {
	const v = fields?.[name];
	return typeof v === "object" && v !== null ? v.newValue : v;
}

export function parseAzureSubset(payload) {
	const eventType = payload?.eventType;
	const resource = payload?.resource ?? {};
	const containers = payload?.resourceContainers ?? {};

	if (WORK_ITEM_EVENTS.has(eventType)) {
		const fields = resource.fields ?? {};
		// `resource.revision.fields` carries the full post-change state on an update, where `resource.fields`
		// carries only the diff. Read the full state for the CURRENT tag set, and the diff separately for
		// whether tags changed at all -- conflating the two is how the diff-not-set trap gets reintroduced.
		const full = resource.revision?.fields ?? fields;
		return {
			eventType,
			id: payload?.id,
			actor: actorOf(payload),
			project: { id: containers.project?.id, name: fieldValue(fields, "System.TeamProject") ?? fieldValue(full, "System.TeamProject") },
			// `resource.workItemId` on a comment event, `resource.id` on create/update. Work item ids are
			// ORGANIZATION-scoped on Azure DevOps, which is why the dedup key namespaces them on the org
			// rather than on the repository.
			target: {
				number: resource.workItemId ?? resource.id,
				title: fieldValue(full, "System.Title"),
				// System.Description is a rich-text (HTML) field on most work item types. It stays DATA either
				// way -- it is fenced below the delimiter like every other payload string -- but a reader of
				// the envelope should not be surprised to find markup there.
				body: fieldValue(full, "System.Description"),
			},
			tags: parseTags(fieldValue(full, "System.Tags")),
			tagChanges: tagChange(fields),
			// `System.History` is where a work-item comment's text arrives.
			comment: eventType === "workitem.commented" ? fieldValue(fields, "System.History") : undefined,
		};
	}

	const isPrComment = eventType === PR_COMMENT_EVENT;
	const pr = isPrComment ? (resource.pullRequest ?? {}) : resource;
	const repository = pr.repository ?? resource.repository ?? {};
	return {
		eventType,
		id: payload?.id,
		actor: actorOf(payload),
		project: { id: containers.project?.id ?? repository.project?.id, name: repository.project?.name },
		repository: { id: repository.id, name: repository.name },
		target: {
			number: pr.pullRequestId,
			title: pr.title,
			body: pr.description,
			// Azure refs are fully qualified (`refs/heads/main`). They are attacker-controlled DATA,
			// projected for the flow's event.json and NEVER used as a clone ref.
			head: { ref: stripRefsHeads(pr.sourceRefName) },
			base: { ref: stripRefsHeads(pr.targetRefName) },
		},
		comment: isPrComment ? resource.comment?.content : undefined,
	};
}

/** `refs/heads/main` -> `main`. Azure qualifies its refs; the rest of this codebase does not. */
export function stripRefsHeads(ref) {
	return typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : undefined;
}
