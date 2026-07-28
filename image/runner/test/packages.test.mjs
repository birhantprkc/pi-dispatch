import assert from "node:assert/strict";
import { test } from "node:test";
import {
	countPackageResources,
	findShadowedSkills,
	isUnderAnyRoot,
	owningRoot,
	PROTECTED_SKILL_ROOTS,
} from "../src/packages.mjs";

/**
 * Pure unit tests for the staged-package decisions (INT-CONTAINER-JOB-INPUTS). These take pi's
 * diagnostic shape as plain objects, so they run everywhere -- the loader contract tests pin the same
 * finding against the REAL pi, and this file pins what we DO about it.
 *
 * What we do about it changed: the shadowing is now REVERSED by loader.mjs through the loader's
 * declared skillsOverride option (REQ-GLOBAL-PI-OVERLAY, "repo wins on conflict"), so findShadowedSkills
 * reports the ATTEMPT rather than justifying a refusal. Its inputs and its answers are unchanged --
 * pi's diagnostic is left exactly as pi wrote it -- which is precisely why the same cases still hold.
 */

const PACKAGE_ROOT = "/opt/pi-global/packages/tools";
const OTHER_PACKAGE_ROOT = "/opt/pi-global/packages/review";

/** pi's own collision diagnostic: winnerPath is the skill it KEPT, loserPath the one it dropped. */
function collision({ name, winnerPath, loserPath }) {
	return {
		type: "collision",
		message: `name "${name}" collision`,
		path: loserPath,
		collision: { resourceType: "skill", name, winnerPath, loserPath },
	};
}

test("a package skill that shadows a repo skill is flagged", () => {
	// The finding: pi puts package skill paths FIRST in skillPaths and loadSkills is first-path-wins,
	// so on the raw load the package's "deploy" wins and the repo's is dropped with only this
	// diagnostic to show for it. loader.mjs puts the repo's back in force through skillsOverride, so
	// this is no longer grounds for refusal -- it is what gets the attempt into the run log, because a
	// package whose flow was written around its own "deploy" is now running against the repo's.
	const diagnostics = [
		collision({
			name: "deploy",
			winnerPath: `${PACKAGE_ROOT}/skills/deploy/SKILL.md`,
			loserPath: "/job/pi/skills/deploy/SKILL.md",
		}),
	];
	const shadowed = findShadowedSkills(diagnostics, { packageRoots: [PACKAGE_ROOT] });
	assert.equal(shadowed.length, 1);
	assert.equal(shadowed[0].name, "deploy");
	assert.equal(shadowed[0].winnerPath, `${PACKAGE_ROOT}/skills/deploy/SKILL.md`);
	assert.equal(shadowed[0].loserPath, "/job/pi/skills/deploy/SKILL.md");
});

test("a package skill that shadows an OPERATOR OVERLAY skill is flagged too", () => {
	// /opt/pi-global/skills is operator deploy-time config, the same trust class as the baked floor.
	// A package silently replacing one of those is the same inversion.
	const diagnostics = [
		collision({
			name: "house-style",
			winnerPath: `${PACKAGE_ROOT}/skills/house-style/SKILL.md`,
			loserPath: "/opt/pi-global/skills/house-style/SKILL.md",
		}),
	];
	assert.equal(findShadowedSkills(diagnostics, { packageRoots: [PACKAGE_ROOT] }).length, 1);
});

test("the ALLOWED direction -- the repo wins -- is not flagged", () => {
	// Two ways to reach this shape, and neither is a problem to report: pi reorders skillPaths so our
	// paths come first, or the enforcement diagnostic loader.mjs appends after a swap. Flagging it
	// would put a line in every packaged job's log claiming a conflict that resolved as documented.
	const diagnostics = [
		collision({
			name: "deploy",
			winnerPath: "/job/pi/skills/deploy/SKILL.md",
			loserPath: `${PACKAGE_ROOT}/skills/deploy/SKILL.md`,
		}),
	];
	assert.deepEqual(findShadowedSkills(diagnostics, { packageRoots: [PACKAGE_ROOT] }), []);
});

test("a repo skill shadowing an overlay skill is not flagged -- that is the documented overlay", () => {
	// REQ-GLOBAL-PI-OVERLAY: the repo's .pi/skills layer OVER the operator overlay's, and a name
	// collision between the two is expected, not a refusal.
	const diagnostics = [
		collision({
			name: "bug-fix",
			winnerPath: "/job/pi/skills/bug-fix/SKILL.md",
			loserPath: "/opt/pi-global/skills/bug-fix/SKILL.md",
		}),
	];
	assert.deepEqual(findShadowedSkills(diagnostics, { packageRoots: [PACKAGE_ROOT] }), []);
	assert.deepEqual(findShadowedSkills(diagnostics, { packageRoots: [] }), []);
});

test("non-collision diagnostics and non-skill collisions are ignored", () => {
	// getSkills().diagnostics also carries plain warnings and errors (a missing skill path, a broken
	// frontmatter). Treating those as shadowing would report skill conflicts that never happened, and
	// a warning that cries wolf is a warning nobody reads when the real one lands.
	const diagnostics = [
		{ type: "error", message: "Skill path does not exist", path: "/job/pi/skills" },
		{ type: "warning", message: "not a directory", path: `${PACKAGE_ROOT}/skills` },
		{
			type: "collision",
			message: 'name "fmt" collision',
			collision: {
				resourceType: "prompt",
				name: "fmt",
				winnerPath: `${PACKAGE_ROOT}/prompts/fmt.md`,
				loserPath: "/job/pi/prompts/fmt.md",
			},
		},
	];
	assert.deepEqual(findShadowedSkills(diagnostics, { packageRoots: [PACKAGE_ROOT] }), []);
	assert.deepEqual(findShadowedSkills(undefined, { packageRoots: [PACKAGE_ROOT] }), []);
});

test("root matching is by path segment, so a sibling root cannot claim another's skill", () => {
	// "/opt/pi-global/packages/tool" must not match a path under ".../tools". A prefix test would flag
	// -- or miss -- the wrong package, and the log line would name the wrong dir. loader.mjs decides
	// skill PRECEDENCE with this same containment test, so a boundary bug here does not merely
	// misreport: it swaps the wrong skill, or fails to swap the right one.
	const diagnostics = [
		collision({
			name: "deploy",
			winnerPath: `${PACKAGE_ROOT}/skills/deploy/SKILL.md`,
			loserPath: "/job/pi/skills/deploy/SKILL.md",
		}),
	];
	assert.deepEqual(findShadowedSkills(diagnostics, { packageRoots: ["/opt/pi-global/packages/tool"] }), []);
	assert.equal(findShadowedSkills(diagnostics, { packageRoots: [`${PACKAGE_ROOT}/`] }).length, 1, "a trailing slash still matches");
	assert.deepEqual(PROTECTED_SKILL_ROOTS, ["/job/pi/skills", "/opt/pi-global/skills"]);
});

test("isUnderAnyRoot and owningRoot share the segment boundary, and owningRoot names the FIRST match", () => {
	// Exported because loader.mjs decides precedence against the same roots and run-job.mjs names the
	// winning root in the log. Asserted directly so the boundary is pinned once, where it lives.
	assert.equal(isUnderAnyRoot(`${PACKAGE_ROOT}/skills/deploy/SKILL.md`, [PACKAGE_ROOT]), true);
	assert.equal(isUnderAnyRoot(`${PACKAGE_ROOT}/skills/deploy/SKILL.md`, ["/opt/pi-global/packages/tool"]), false);
	assert.equal(isUnderAnyRoot(PACKAGE_ROOT, [PACKAGE_ROOT]), true, "the root itself is under itself");
	assert.equal(isUnderAnyRoot(undefined, [PACKAGE_ROOT]), false, "an unloaded skill has no path to place");
	assert.equal(isUnderAnyRoot(`${PACKAGE_ROOT}/x`, undefined), false);

	assert.equal(owningRoot("/job/pi/skills/deploy/SKILL.md", ["/job/pi/skills", PACKAGE_ROOT]), "/job/pi/skills");
	assert.equal(
		owningRoot(`${PACKAGE_ROOT}/skills/deploy/SKILL.md`, ["/job/pi/skills", PACKAGE_ROOT]),
		PACKAGE_ROOT,
	);
	// null rather than a guess: a log line that invents a root is worse than one that admits it has none.
	assert.equal(owningRoot("/somewhere/else/SKILL.md", ["/job/pi/skills"]), null);
	assert.equal(owningRoot(undefined, ["/job/pi/skills"]), null);
});

test("countPackageResources attributes each loaded path to the root that shipped it", () => {
	const counts = countPackageResources({
		packageRoots: [PACKAGE_ROOT, OTHER_PACKAGE_ROOT],
		extensionPaths: [
			"/job/pi/extensions/repo-ext.js", // not a package -- counted for nobody
			`${PACKAGE_ROOT}/ext/one.js`,
			`${PACKAGE_ROOT}/ext/two.js`,
			`${OTHER_PACKAGE_ROOT}/index.js`,
		],
		skillPaths: [
			"/job/pi/skills/bug-fix/SKILL.md",
			`${PACKAGE_ROOT}/skills/pkg-skill/SKILL.md`,
		],
	});

	assert.deepEqual(counts, [
		{ root: PACKAGE_ROOT, extensions: 2, skills: 1 },
		{ root: OTHER_PACKAGE_ROOT, extensions: 1, skills: 0 },
	]);
});

test("a root that contributed nothing still reports 0 rather than vanishing", () => {
	// The whole reason the log line is per-root: a package that mounted but resolved to no resources
	// at all (unbuilt extension, manifest pointing at files that are not there) is otherwise
	// indistinguishable from one that worked.
	assert.deepEqual(
		countPackageResources({
			packageRoots: [PACKAGE_ROOT],
			extensionPaths: ["/job/pi/extensions/repo-ext.js"],
			skillPaths: ["/opt/pi-global/skills/house-style/SKILL.md"],
		}),
		[{ root: PACKAGE_ROOT, extensions: 0, skills: 0 }],
	);

	assert.deepEqual(countPackageResources({}), []);
});
