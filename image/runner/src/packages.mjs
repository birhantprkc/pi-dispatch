/**
 * Staged pi packages: the two questions the runner must answer about them (INT-CONTAINER-JOB-INPUTS).
 *
 * Both helpers here are PURE -- they take plain objects (diagnostics, path strings) and touch no
 * filesystem and no pi import, so the decisions they encode are testable without a container.
 */

/** Roots whose skills a staged package must never be able to replace. */
export const PROTECTED_SKILL_ROOTS = ["/job/pi/skills", "/opt/pi-global/skills"];

/**
 * Find staged-package skills that TRIED to shadow a repo or operator-overlay skill
 * (REQ-GLOBAL-PI-OVERLAY).
 *
 * What pi does, stated exactly: skillPaths is `mergePaths(cliEnabledSkills, additionalSkillPaths)`,
 * so the paths a staged package contributes through its `pi` manifest come FIRST and our
 * `/job/pi/skills` and `/opt/pi-global/skills` come after -- whatever order we listed the package in.
 * `loadSkills` is then first-path-wins: the first skill with a given name is kept, every later
 * same-named skill is DROPPED, and the loss survives only as a `{type:"collision"}` diagnostic naming
 * the winner and the loser. Left at that, a package's `deploy` replaces the repo's, which inverts
 * REQ-GLOBAL-PI-OVERLAY's documented "repo wins on conflict".
 *
 * That ordering is not ours to set -- but the RESULT is. `DefaultResourceLoaderOptions.skillsOverride`
 * is a declared option on the pinned loader, invoked on `{skills, diagnostics}` the moment loadSkills
 * returns, and loader.mjs uses it (enforceProtectedSkillPrecedence) to put the protected skill back in
 * force. So the repo does win, and this function is no longer a reason to refuse the job.
 *
 * It is still the VISIBILITY signal, and that is why it survives: the operator has to be told that a
 * staged package shipped a name the repo had already published, because the package's own flow was
 * written against a procedure that is not the one now running. It reads pi's UNMODIFIED diagnostic --
 * the true record of what the raw load produced -- so it keeps reporting the attempt even though the
 * outcome has been reversed. It is also the tripwire on the pin: if a future pi reorders skillPaths so
 * the repo already wins, this goes quiet at the same moment the override becomes a no-op.
 *
 * Returns ONLY the inverted direction. A collision the repo won (winner under a protected root) is
 * the documented, allowed overlay behaviour and yields nothing; so does a collision between two
 * non-package roots (a repo skill shadowing an overlay skill of the same name -- exactly what
 * REQ-GLOBAL-PI-OVERLAY promises).
 */
export function findShadowedSkills(diagnostics, { packageRoots = [], protectedRoots = PROTECTED_SKILL_ROOTS } = {}) {
	const shadowed = [];
	for (const diagnostic of diagnostics ?? []) {
		if (diagnostic?.type !== "collision") continue;
		const collision = diagnostic.collision;
		if (!collision || collision.resourceType !== "skill") continue;
		// winnerPath is the skill pi KEPT, loserPath the one it dropped. Flag only
		// package-beats-protected; every other pairing is the allowed direction.
		if (!isUnderAnyRoot(collision.winnerPath, packageRoots)) continue;
		if (!isUnderAnyRoot(collision.loserPath, protectedRoots)) continue;
		shadowed.push(collision);
	}
	return shadowed;
}

/**
 * Per-root `{extensions, skills}` counts for the `packages_loaded` log line.
 *
 * `extensionPaths` are the loaded extensions' own paths, `skillPaths` the loaded skills' SKILL.md
 * file paths -- both as pi reports them AFTER loading, so a package that shipped a manifest entry
 * pi refused to load is not counted as if it had worked.
 *
 * A root that contributed nothing still appears, reporting 0. That is the whole point of logging
 * per-root rather than a total: a staged package that mounted but resolved to no resources at all
 * (an unbuilt extension, a manifest pointing at files that are not there) is otherwise
 * indistinguishable from one that worked, and the job runs without the tools its flow expects.
 */
export function countPackageResources({ packageRoots = [], extensionPaths = [], skillPaths = [] } = {}) {
	return packageRoots.map((root) => ({
		root,
		extensions: extensionPaths.filter((path) => isUnderRoot(path, root)).length,
		skills: skillPaths.filter((path) => isUnderRoot(path, root)).length,
	}));
}

/**
 * Containment by path SEGMENT, not by string prefix -- `/opt/pi-global/packages/tool` must not
 * claim a path under `/opt/pi-global/packages/tools`. Trailing slashes on a root are tolerated
 * because an operator-supplied PI_PACKAGES entry may carry one.
 */
function isUnderRoot(path, root) {
	if (typeof path !== "string" || typeof root !== "string" || root === "") return false;
	const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
	return path === normalized || path.startsWith(`${normalized}/`);
}

/**
 * Exported because loader.mjs decides skill precedence against the SAME roots. A second containment
 * test written next to the loader would be a second place for the segment-boundary bug to live, and
 * the two would disagree exactly once -- on the collision that matters.
 */
export function isUnderAnyRoot(path, roots) {
	return (roots ?? []).some((root) => isUnderRoot(path, root));
}

/**
 * The first root that CONTAINS the path, or null. Used to name the root that actually won a skill
 * collision in the log line: reporting the winning root is what makes the enforcement observable,
 * and reporting a whole file path would put image layout into shipped run logs.
 */
export function owningRoot(path, roots) {
	return (roots ?? []).find((root) => isUnderRoot(path, root)) ?? null;
}
