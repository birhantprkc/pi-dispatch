/**
 * branch.mjs -- a job's target reference: the number, validated, and the branch derived from it.
 *
 * Both halves lived in github-prompt.mjs, and while the prompt was the only reader that was right: two
 * small helpers next to the prose explaining them, with gitlab-prompt.mjs importing the number check
 * because refusing a non-positive-integer reference is not a fact about GitHub.
 *
 * The session store changed the shape. It keys on the same `pi/issue-<n>` string the prompt names
 * (REQ-RESUMABLE-SESSION), so the branch now has two readers that must agree -- and it cannot import it
 * from github-prompt.mjs without a cycle, since the prompt would import the branch back. Hence a leaf
 * module with no imports of its own.
 *
 * The drift this forecloses is the silent kind. A second copy of `pi/issue-${n}` would not fail: it would
 * resolve a key for a branch the agent was never told to push to, so every resume would miss and every
 * job would look like an ordinary cold start. Making the two readers call one function is the whole
 * reason this file exists.
 *
 * `dataRegion` deliberately stays in github-prompt.mjs -- it is about placing untrusted text below the
 * isolation delimiter (CONST-ISSUE-TEXT-IS-DATA), which is a prompt concern, not a reference concern.
 */

/** The number must be trustworthy; a positive integer is the only accepted issue/PR/MR reference. */
export function normalizeNumber(number) {
	const n = Number(number);
	if (!Number.isInteger(n) || n <= 0) {
		const error = new Error(`invalid target number (must be a positive integer): ${String(number)}`);
		error.piDispatchConfig = true;
		throw error;
	}
	return n;
}

/**
 * The branch an issue-triggered job commits to, on both forges.
 *
 * Derived solely from the issue number -- a stable, forge-assigned integer -- and never from the mutable
 * title or body, so a re-run of the same issue always converges on the same branch. That convergence is
 * what makes the branch usable as a session key at all: it is the only host-computable join between an
 * issue and the pull/merge request its job opened (DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED).
 *
 * @param {number|string} number - The issue's number/iid. Must normalise to a positive integer.
 * @returns {string} e.g. `pi/issue-7`.
 * @throws {Error} tagged `piDispatchConfig` when the number is not a positive integer.
 */
export function issueBranch(number) {
	return `pi/issue-${normalizeNumber(number)}`;
}
