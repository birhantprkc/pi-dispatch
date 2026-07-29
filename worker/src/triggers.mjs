/**
 * Shared trigger-file schema + validator (issue #20). One `triggers.json` of `{ on, run }` entries is
 * the single reviewed source of standing triggers for BOTH services: the worker owns `on.type:"cron"`
 * (local jobs), the receiver owns the webhook types (`label|comment|pull_request` -> a forge job). Each
 * service validates the WHOLE file, then selects the `on.type` it owns, so a malformed file fails both
 * identically and the two cannot drift.
 *
 * The on x run MATRIX is the trust boundary (DES-TRIGGERS-UNIFIED-FILE): a cron trigger carries no
 * webhook delivery id, issue/PR number, title, or body, so it can only produce a `local` run; a webhook
 * trigger is adversarial input and always produces a FORGE run, never a local one. Off-matrix is
 * rejected fail-loud at load, exactly as the old schedules loader refused a `kind:"github"` schedule.
 *
 * Which forge is `run.kind` (issue #42): the `on.type` vocabulary is shared, because a label is a label
 * and a comment is a comment on every forge, while the ACTION vocabulary is not -- GitHub says
 * `opened`/`synchronize`, GitLab says `open`/`update`. So actions are validated against the vocabulary of
 * whichever forge the entry names. That refusal matters more than it looks: an action word from the wrong
 * forge does not crash anything downstream, it simply never matches an event, and the trigger silently
 * never fires. Refusing it at load is what turns a silent no-op into a message.
 *
 * Pure and fs-free (mirrors job-id.mjs): takes the file TEXT, returns a normalized array, throws
 * `configError` on any problem. Folder existence (fs-dependent) is layered on by the worker, not here.
 *
 * Custom: triggers validated inline per config.mjs/schedules.mjs precedent; zod not in deps
 */

import { configError } from "./config.mjs";

const ON_TYPES = new Set(["cron", "label", "comment", "pull_request"]);
const RUN_KINDS = new Set(["local", "github", "gitlab"]);
// The kinds a webhook trigger may produce. `local` is deliberately absent -- that is the matrix.
const FORGE_KINDS = new Set(["github", "gitlab"]);

/**
 * The `pull_request` action vocabulary, per forge, in each forge's OWN words -- so an operator writes
 * what their forge's documentation says and can grep for it there.
 *
 * GitLab has no `labeled`: adding a label to a merge request arrives as `update` carrying a
 * `changes.labels` diff, and `open`/`reopen` are its spellings of `opened`/`reopened`. `approved` has no
 * GitHub counterpart at all and is a genuinely useful gate (a member approved the MR). `merge` and
 * `close` are omitted on purpose: a job started by a merge or a close has nothing left to act on.
 */
const PR_ACTIONS = {
	github: new Set(["labeled", "opened", "synchronize", "reopened"]),
	gitlab: new Set(["open", "update", "reopen", "approved"]),
};

// A cron id flows into BullMQ's deterministic `repeat:<id>:<nextMillis>` jobId, so a `:` corrupts that
// parse; the charset also excludes `:` and the dedicated check names the reason.
const ID_CHARSET = /^[A-Za-z0-9._-]+$/;

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * Parse, validate, and normalize the unified triggers file text. Returns an array of normalized
 * `{ on, run }` entries (unknown fields dropped, so consumers only ever read validated fields). Throws
 * `configError` (fail-loud) on any malformed entry. The `path` is for error messages only.
 */
export function parseTriggers(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw configError(`triggers file is not valid JSON: ${path} (${error.message})`);
	}

	const entries = parsed?.triggers;
	if (!Array.isArray(entries)) {
		throw configError(`triggers file must have a "triggers" array: ${path}`);
	}

	const state = { seenCronIds: new Set(), commentCounts: {} };
	return entries.map((entry, index) => normalizeTrigger(entry, index, path, state));
}

function normalizeTrigger(entry, index, path, state) {
	const at = `trigger at index ${index}`;

	if (entry === null || typeof entry !== "object") {
		throw configError(`${at}: must be an object: ${path}`);
	}
	const { on, run } = entry;
	if (on === null || typeof on !== "object") {
		throw configError(`${at}: "on" must be an object: ${path}`);
	}
	if (run === null || typeof run !== "object") {
		throw configError(`${at}: "run" must be an object: ${path}`);
	}
	if (!ON_TYPES.has(on.type)) {
		throw configError(`${at}: on.type must be one of cron|label|comment|pull_request (got ${JSON.stringify(on.type)}): ${path}`);
	}
	if (!RUN_KINDS.has(run.kind)) {
		throw configError(`${at}: run.kind must be one of local|github|gitlab (got ${JSON.stringify(run.kind)}): ${path}`);
	}

	// The on x run matrix -- the trust boundary, fail-loud (mirrors the old schedules kind:github refusal).
	if (on.type === "cron") {
		if (run.kind !== "local") {
			throw configError(`${at}: a cron trigger has no webhook delivery, issue/PR number, title, or body; run.kind must be "local" (got ${JSON.stringify(run.kind)}): ${path}`);
		}
		return normalizeCron(on, run, index, path, state);
	}
	if (!FORGE_KINDS.has(run.kind)) {
		throw configError(`${at}: a ${on.type} trigger is webhook-driven and produces a forge job; run.kind must be one of github|gitlab (got ${JSON.stringify(run.kind)}): ${path}`);
	}
	if (on.type === "label") return normalizeLabel(on, run, index, path);
	if (on.type === "comment") return normalizeComment(on, run, index, path, state);
	return normalizePullRequest(on, run, index, path);
}

function normalizeCron(on, run, index, path, state) {
	const at = `trigger at index ${index}`;

	const id = on.id;
	if (!isNonEmptyString(id)) {
		throw configError(`${at}: cron on.id must be a non-empty string: ${path}`);
	}
	if (id.includes(":")) {
		throw configError(`cron trigger "${id}": on.id must not contain ":" -- it corrupts the repeat:<id>:<millis> jobId parsing in the stall guard: ${path}`);
	}
	if (!ID_CHARSET.test(id)) {
		throw configError(`cron trigger "${id}": on.id must match [A-Za-z0-9._-]+: ${path}`);
	}
	if (state.seenCronIds.has(id)) {
		throw configError(`cron trigger "${id}": duplicate on.id (cron ids must be unique): ${path}`);
	}
	state.seenCronIds.add(id);

	const pattern = on.pattern;
	if (!isNonEmptyString(pattern)) {
		throw configError(`cron trigger "${id}": on.pattern must be a non-empty string: ${path}`);
	}
	const fieldCount = pattern.trim().split(/\s+/).length;
	if (fieldCount !== 5 && fieldCount !== 6) {
		throw configError(`cron trigger "${id}": on.pattern must have 5 or 6 space-separated fields, got ${fieldCount}: ${path}`);
	}

	if (!isNonEmptyString(run.folder)) {
		throw configError(`cron trigger "${id}": run.folder must be a non-empty string: ${path}`);
	}
	if (!isNonEmptyString(run.flow)) {
		throw configError(`cron trigger "${id}": run.flow must be a non-empty string: ${path}`);
	}
	if (!isNonEmptyString(run.task)) {
		throw configError(`cron trigger "${id}": run.task must be a non-empty string: ${path}`);
	}

	// Cron jobs are the zero-GitHub path by default; `run.github: true` is the per-trigger opt-in that
	// makes the worker mint the same scoped per-job token the github path mints, so the container can use
	// the gh CLI (INT-TRIGGERS-FILE-CONTRACT). Strictly boolean, fail-loud: a truthy string like "true"
	// silently opting a trigger into a credential is exactly the drift this validator exists to refuse.
	if (run.github !== undefined && typeof run.github !== "boolean") {
		throw configError(`cron trigger "${id}": run.github must be true or false when present: ${path}`);
	}

	const packages = validatePackagesFlag(run, `cron trigger "${id}"`, path);
	const image = validateImageRef(run, `cron trigger "${id}"`, path);

	// provider/model/maxTurns stay absent when omitted so the value resolves at job start against the
	// settings overlay/env, not a default frozen here (INT-CONFIG-OVERLAY-CONTRACT). github/packages/image stay
	// absent the same way -- and that matters more for `packages` now that absent means LOAD: writing a
	// `true` in here would make the schedule payload claim an opt-in the operator never wrote, and would
	// freeze today's default into every stored repeatable.
	return {
		on: { type: "cron", id, pattern },
		run: { kind: "local", folder: run.folder, flow: run.flow, task: run.task, provider: run.provider, model: run.model, maxTurns: run.maxTurns, github: run.github, packages, image },
	};
}

/**
 * Validate the per-trigger `run.packages` flag, shared by all four normalizers. It is an opt-OUT: the pi
 * packages an operator pinned into the global overlay load for every job, and `run.packages: false` is how a
 * single trigger withholds them (INT-TRIGGERS-FILE-CONTRACT, REQ-GLOBAL-PI-OVERLAY). Absent and `true` both
 * mean load; the default is resolved by the worker (run-container.mjs), never frozen into the file here.
 *
 * Still strictly boolean and still fail-loud, because the failure mode a loose parse produces has flipped
 * rather than gone away: `"false"` as a string is a trigger whose operator believes it runs no third-party
 * code while it loads all of it. A validator that accepted the string would make that belief undetectable.
 *
 * `at` is the caller's message prefix -- cron names its id, the webhook normalizers name their file index --
 * so every rejection still points at the entry the operator actually wrote. Returns the flag, undefined
 * when absent, so an unflagged trigger normalizes byte-identically to today's.
 */
function validatePackagesFlag(run, at, path) {
	if (run.packages !== undefined && typeof run.packages !== "boolean") {
		throw configError(`${at}: run.packages must be true or false when present: ${path}`);
	}
	return run.packages;
}

/**
 * Validate the per-trigger `run.image` reference, shared by all four normalizers. It selects the Docker image
 * this trigger's job containers run in, overriding the deployment-wide `PI_JOB_IMAGE` for this trigger only;
 * absent means the deployment default, resolved by the worker (image-preflight.mjs) and never frozen into the
 * file here. Carried on all four kinds rather than cron only, for the same reason `run.packages` is: a
 * toolchain is a capability of the FLOW, and a label/comment/PR trigger runs the flows a cron trigger runs.
 *
 * Deliberately NOT a shape check. `run.folder` -- also an operator-authored host reference -- is validated
 * here as a non-empty string only, with existence deferred to the one place that can actually know; run.image
 * gets exactly that split: type here, reality at job start via a pre-spend `docker image inspect`. A regex
 * over the OCI reference grammar would refuse the rarer half of the problem (a malformed name) while missing
 * the common half (a well-formed name for an image nobody built), and an over-strict one would refuse a
 * legitimate `registry.internal:5000/team/img:1.2@sha256:...` and take the whole worker down at boot for a
 * valid deployment. Docker validates its own grammar; we do not.
 *
 * A floating tag is likewise accepted, not warned. CONST-PI-VERSION-PINNED fears UNATTENDED drift, and that
 * mechanism does not exist here: with `--pull=never` a local tag can only move when a human runs `docker
 * pull` or `docker build` on this host, which is the explicit act the constraint asks for. Refusing `:latest`
 * would also make `run.image: "pi-job:latest"` illegal while `PI_JOB_IMAGE=pi-job:latest` is the shipped
 * default -- an incoherence an operator would rightly file as a bug.
 *
 * The three refusals below are not grammar. Each names a value that would corrupt something on OUR side: a
 * non-string reaches `args.push(image)` and becomes a garbage argv token; an empty string is falsy and throws
 * inside buildDockerRunArgs AFTER the budget slot is reserved; and a leading `-` lands in the image positional
 * where docker's flag parser reads it as a flag, which is the one value that stops docker-run.mjs's
 * explicit-array argv from being injection-free by inspection. Whitespace is refused rather than trimmed
 * because the file is the reviewed artifact: it must not disagree with what runs.
 *
 * `at` is the caller's message prefix, exactly as validatePackagesFlag's is. Returns the reference, undefined
 * when absent, so an unflagged trigger normalizes byte-identically to today's.
 */
function validateImageRef(run, at, path) {
	const image = run.image;
	if (image === undefined) return undefined;
	if (typeof image !== "string" || image.trim() === "") {
		throw configError(`${at}: run.image must be a non-empty string when present: ${path}`);
	}
	if (image !== image.trim()) {
		throw configError(`${at}: run.image must not have leading or trailing whitespace (got ${JSON.stringify(image)}): ${path}`);
	}
	if (image.startsWith("-")) {
		throw configError(`${at}: run.image must not start with "-" -- it is passed as the image positional in the docker argv, where a leading dash parses as a flag (got ${JSON.stringify(image)}): ${path}`);
	}
	return image;
}

/**
 * Validate an `{any, all, none}` label predicate. Selectors are validated as arrays of non-empty strings
 * BEFORE the positive-selector count, because `.length` is truthy on a string too -- a string selector
 * that reached the pure `matchesRule` in the receiver would throw there, breaking the gate's never-throw
 * invariant. Returns the normalized `{any, all, none}`.
 */
function validatePredicate(on, index, path, requirePositive) {
	const at = `trigger at index ${index}`;
	for (const key of ["any", "all", "none"]) {
		const selector = on[key];
		if (selector === undefined) continue;
		if (!Array.isArray(selector) || selector.some((s) => typeof s !== "string" || s.trim() === "")) {
			throw configError(`${at}: on.${key} must be an array of non-empty strings: ${path}`);
		}
	}
	// A `none`-only rule matches every event lacking the excluded labels -- wider than a single-label
	// allowlist, which would weaken CONST-TRIGGER-AUTHOR-GATE. Require a positive selector where the
	// predicate IS the approval gate (label triggers, and `labeled` PR triggers).
	if (requirePositive && (on.any?.length ?? 0) + (on.all?.length ?? 0) === 0) {
		throw configError(`${at}: needs at least one positive selector (on.any or on.all): ${path}`);
	}
	return { any: on.any, all: on.all, none: on.none };
}

function normalizeLabel(on, run, index, path) {
	const at = `trigger at index ${index}`;
	const predicate = validatePredicate(on, index, path, true);
	if (!isNonEmptyString(run.flow)) {
		throw configError(`${at}: label trigger run.flow must be a non-empty string: ${path}`);
	}
	const packages = validatePackagesFlag(run, at, path);
	const image = validateImageRef(run, at, path);
	return { on: { type: "label", any: predicate.any, all: predicate.all, none: predicate.none }, run: { kind: run.kind, flow: run.flow, packages, image } };
}

function normalizeComment(on, run, index, path, state) {
	const at = `trigger at index ${index}`;
	if (!isNonEmptyString(on.phrase)) {
		throw configError(`${at}: comment trigger on.phrase must be a non-empty string: ${path}`);
	}
	if (!isNonEmptyString(run.flow)) {
		throw configError(`${at}: comment trigger run.flow (the default flow) must be a non-empty string: ${path}`);
	}
	// At most one comment trigger PER FORGE. The cap exists because the receiver holds one comment rule
	// per forge and a second would be silently unreachable -- so it is a cap on ambiguity, not on count,
	// and a deployment serving GitHub and GitLab is entitled to the same `@pi` phrase on each.
	state.commentCounts[run.kind] = (state.commentCounts[run.kind] ?? 0) + 1;
	if (state.commentCounts[run.kind] > 1) {
		throw configError(`${at}: at most one ${run.kind} comment trigger is allowed: ${path}`);
	}
	const packages = validatePackagesFlag(run, at, path);
	const image = validateImageRef(run, at, path);
	return { on: { type: "comment", phrase: on.phrase }, run: { kind: run.kind, flow: run.flow, packages, image } };
}

function normalizePullRequest(on, run, index, path) {
	const at = `trigger at index ${index}`;

	const actions = on.action;
	if (!Array.isArray(actions) || actions.length === 0) {
		throw configError(`${at}: pull_request on.action must be a non-empty array: ${path}`);
	}
	// Validated against THIS entry's forge, in that forge's own words. A GitHub word on a GitLab trigger
	// (or the reverse) is refused here rather than left to never match at run time.
	const allowed = PR_ACTIONS[run.kind];
	const expected = [...allowed].join("|");
	for (const a of actions) {
		if (!allowed.has(a)) {
			throw configError(`${at}: pull_request on.action has an unsupported ${run.kind} action ${JSON.stringify(a)} (expected ${expected}): ${path}`);
		}
	}

	// A `labeled` PR trigger is gated by its label predicate (the collaborator-applied label is the
	// approval), so it MUST carry a positive selector -- exactly as a label trigger does. Auto actions
	// (opened/synchronize/reopened) are gated by author_association in the filter, so a predicate is
	// optional there and only narrows scope when present.
	//
	// GitLab has no `labeled` action and therefore no rule to attach this to: a label added to a merge
	// request arrives as `update`. It needs none, because EVERY gitlab trigger is gated on the actor's
	// resolved access level (CONST-TRIGGER-AUTHOR-GATE) rather than on the label alone -- so an
	// unpredicated gitlab MR rule is gated, where an unpredicated `labeled` github rule would not be.
	const requirePositive = run.kind === "github" && actions.includes("labeled");
	const predicate = validatePredicate(on, index, path, requirePositive);
	if (!isNonEmptyString(run.flow)) {
		throw configError(`${at}: pull_request trigger run.flow must be a non-empty string: ${path}`);
	}
	const packages = validatePackagesFlag(run, at, path);
	const image = validateImageRef(run, at, path);
	return {
		on: { type: "pull_request", action: [...actions], any: predicate.any, all: predicate.all, none: predicate.none },
		run: { kind: run.kind, flow: run.flow, packages, image },
	};
}
