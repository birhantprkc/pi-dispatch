import { existsSync, readFileSync } from "node:fs";
import { DefaultResourceLoader, getAgentDir, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { isUnderAnyRoot } from "./packages.mjs";

/** Where the image bakes the guardrails. Outside agentDir, on purpose -- see buildResourceLoader. */
export const GUARDRAILS_PATH = "/opt/pi-dispatch/HARD_RULES.md";

/** Where the image bakes the outbox protocol. Documentation for the /outbox signal channel. */
export const OUTBOX_PROTOCOL_PATH = "/opt/pi-dispatch/OUTBOX_PROTOCOL.md";

/** Read-write mount a local job receives; its presence is what makes the outbox protocol relevant. */
export const OUTBOX_MOUNT = "/outbox";

/** Read-only mount the worker materialises the project's .pi/ into, from the default-branch SHA. */
export const JOB_PI_DIR = "/job/pi";

/**
 * Read-only mount of the operator's global pi overlay (REQ-GLOBAL-PI-OVERLAY): custom models, global
 * skills, and a global persona from the operator's own ~/.pi/agent, present only when configured. It is
 * operator deploy-time config -- the same trust class as the baked floor -- layered UNDER each repo's .pi/.
 */
export const GLOBAL_PI_DIR = "/opt/pi-global";

export const WORKSPACE = "/workspace";

function readIfExists(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Re-impose protected-root precedence on the skills pi loaded -- REQ-GLOBAL-PI-OVERLAY's "repo wins
 * on conflict", enforced rather than merely documented.
 *
 * The fact this exists for: pi builds skillPaths as `mergePaths(cliEnabledSkills,
 * additionalSkillPaths)`, so the paths a staged package contributes through its `pi` manifest come
 * FIRST regardless of where we listed the package in additionalExtensionPaths, and `loadSkills` is
 * first-path-wins. Left alone, a package's `deploy` is the one pi KEEPS and the repo's is dropped to a
 * `{type:"collision"}` diagnostic. Reordering our own paths cannot change that -- that ordering is
 * pi's.
 *
 * The RESULT, though, is ours. `DefaultResourceLoaderOptions.skillsOverride` is a declared option on
 * the pinned loader, called with `{skills, diagnostics}` the moment loadSkills returns and before the
 * loader stores anything. This is not a workaround for a missing lever; it IS the lever, and using it
 * is what keeps the requirement's promise true instead of leaving the job to be refused for a
 * precedence the SDK was willing to hand over.
 *
 * The substitute comes from pi's own public `loadSkillsFromDir` with `source: "path"` -- the source
 * `loadSkills` itself assigns to an explicit skill path -- so the skill that ends up in force is what
 * pi would have kept had the package never shipped the name. Parsing SKILL.md here instead would be a
 * second, divergent reader of a format we do not own, and it would drift silently.
 *
 * Protected roots are consulted IN ORDER, first name wins, mirroring additionalSkillPaths (repo before
 * overlay) -- so a repo skill still beats an overlay skill of the same name.
 *
 * pi's collision diagnostic is left EXACTLY as pi wrote it. It is a true record of what the raw load
 * produced and it is what packages.mjs findShadowedSkills reads to tell the operator that a staged
 * package tried to take a repo skill's name. The substitution appends its OWN collision diagnostic
 * naming the enforced winner, so both stages are on the record and neither has to be inferred from the
 * other.
 *
 * A job with no staged packages returns untouched, which is also why the protected roots are not read
 * a second time on the overwhelmingly common path. `loadDir` is injected only so the decision is
 * unit-testable without a skills tree on disk.
 */
export function enforceProtectedSkillPrecedence(
	base,
	{ packageRoots = [], protectedRoots = [], loadDir = loadSkillsFromDir } = {},
) {
	const skills = base?.skills ?? [];
	const diagnostics = base?.diagnostics ?? [];
	if (packageRoots.length === 0 || protectedRoots.length === 0) return { skills, diagnostics };

	const protectedByName = new Map();
	for (const dir of protectedRoots) {
		// loadSkillsFromDir returns empty for a directory that is not there, so an unmounted overlay
		// contributes nothing rather than throwing -- the same shape pi's own load takes for it.
		for (const skill of loadDir({ dir, source: "path" })?.skills ?? []) {
			if (!protectedByName.has(skill.name)) protectedByName.set(skill.name, skill);
		}
	}

	const enforced = [];
	const resolved = skills.map((skill) => {
		// Only a skill pi kept FROM A PACKAGE can be displacing a protected one. A protected skill that
		// already won (a future pi that reorders skillPaths) is left alone, so this stays a no-op rather
		// than becoming a second, opposite bug.
		if (!isUnderAnyRoot(skill.filePath, packageRoots)) return skill;
		const winner = protectedByName.get(skill.name);
		if (!winner || winner.filePath === skill.filePath) return skill;
		enforced.push({
			type: "collision",
			message: `name "${skill.name}" collision -- protected root wins (REQ-GLOBAL-PI-OVERLAY)`,
			path: skill.filePath,
			collision: {
				resourceType: "skill",
				name: skill.name,
				winnerPath: winner.filePath,
				loserPath: skill.filePath,
			},
		});
		return winner;
	});

	return { skills: resolved, diagnostics: [...diagnostics, ...enforced] };
}

/**
 * Build the resource loader exactly as a job does.
 *
 * The contract tests import THIS function rather than constructing a loader of their
 * own -- a test that builds its own loader tests the test, not the runner.
 *
 * Every option here is load-bearing; see INT-SDK-SESSION-OPTIONS:
 *
 * - `noContextFiles` is the SDK equivalent of `-nc` and is OFF by default. Omitting the
 *   whole loader makes createAgentSession build its own without it, which loads a cloned
 *   repo's AGENTS.md into the system prompt from every ancestor directory up to `/`.
 *   CONST-NO-CONTEXT-FILES-MANDATORY fails open by omission; this is the omission.
 *
 * - `noSkills`/`noExtensions` suppress cwd/package discovery, which would read the
 *   CHECKED-OUT branch -- a fork's branch on a PR-triggered job. The additional paths are
 *   merged whether or not those flags are set, and are never trust-checked, so they load
 *   exactly what the worker handed over and nothing from the tree. Project trust is
 *   therefore never granted: reload() is called without resolveProjectTrust.
 *
 * - Guardrails are read EXPLICITLY, not discovered. A trusted project's
 *   .pi/APPEND_SYSTEM.md shadows the global path via an early return, so relying on
 *   discovery would let a project silently delete the safety floor. Reading them
 *   ourselves removes the entire class: discovery cannot shadow what it does not supply.
 *
 * - `skillsOverride` is where REQ-GLOBAL-PI-OVERLAY's "repo wins on conflict" is actually
 *   enforced. Path order cannot carry it -- pi puts a staged package's skill paths first --
 *   so precedence is re-imposed on the loaded result instead. See
 *   enforceProtectedSkillPrecedence.
 */
export function buildResourceLoader({
	cwd = WORKSPACE,
	guardrailsPath = GUARDRAILS_PATH,
	jobPiDir = JOB_PI_DIR,
	globalPiDir = GLOBAL_PI_DIR,
	outboxMount = OUTBOX_MOUNT,
	outboxProtocolPath = OUTBOX_PROTOCOL_PATH,
	allowGlobalExtensions = false,
	packagePaths = [],
	settingsManager,
} = {}) {
	const guardrails = readFileSync(guardrailsPath, "utf8");
	const projectPersona = readIfExists(`${jobPiDir}/APPEND_SYSTEM.md`);
	// The operator's global overlay (REQ-GLOBAL-PI-OVERLAY), present only when the /opt/pi-global mount
	// exists. Persona layers BETWEEN the immutable floor and the repo persona; skills layer UNDER the
	// repo's (repo path first => repo wins a name collision, since pi's loadSkills is first-path-wins).
	const globalPersona = readIfExists(`${globalPiDir}/APPEND_SYSTEM.md`);
	const globalSkills = `${globalPiDir}/skills`;
	const globalExtensions = `${globalPiDir}/extensions`;
	// Only a local job carries an /outbox mount; a github job has none, so its prompt never
	// pays for the protocol. Evaluated ONCE here at loader build, not per message, so the
	// assembled prompt is byte-identical across turns (CONST-PERSONA-IN-CACHED-PREFIX).
	const outboxProtocol = existsSync(outboxMount) ? readIfExists(outboxProtocolPath) : undefined;
	// The roots a staged package may never take a skill name from. Both are listed unconditionally: a
	// root that is not mounted contributes no skill to protect, so gating it would only add a way to
	// forget one.
	const protectedSkillRoots = [`${jobPiDir}/skills`, globalSkills];

	return new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noContextFiles: true,
		noSkills: true,
		noExtensions: true,
		// Repo path FIRST so a repo skill overrides a global one of the same name (first-path-wins).
		additionalSkillPaths: [`${jobPiDir}/skills`, ...(existsSync(globalSkills) ? [globalSkills] : [])],
		// Global overlay extensions are fail-closed: loaded ONLY when the operator armed them
		// (PI_GLOBAL_ALLOW_EXTENSIONS=1) AND the dir is present. They run code against adversarial input
		// with open egress, so arming is a second, explicit decision beyond mounting the overlay.
		// Staged pi packages (INT-CONTAINER-JOB-INPUTS) ride this same option, LAST. One staged dir
		// contributes extensions AND skills AND prompts AND themes through its package.json "pi"
		// manifest: resolveExtensionSources reads the manifest and returns all four resource kinds,
		// and reload() keeps cliEnabledExtensions/cliEnabledSkills REGARDLESS of noExtensions/noSkills
		// -- those flags suppress only cwd/package DISCOVERY, never what an explicit path contributes.
		// Listed last so nothing a package ships can shadow a repo or overlay EXTENSION (first-path-
		// wins). That ordering fix does NOT extend to skills: pi puts package skill paths FIRST in
		// skillPaths no matter where the package sat here, so on the raw load a package skill wins a
		// name collision against the repo's. Skill precedence is therefore re-imposed AFTER the load,
		// through skillsOverride below.
		additionalExtensionPaths: [
			`${jobPiDir}/extensions`,
			...(allowGlobalExtensions && existsSync(globalExtensions) ? [globalExtensions] : []),
			...packagePaths,
		],
		// REQ-GLOBAL-PI-OVERLAY's "repo wins on conflict", made true rather than merely asserted. This
		// is the loader's own declared seam, run on loadSkills' result before anything is stored, so the
		// precedence pi's path ordering hands to a staged package is taken back here. Without it the
		// repo's skill is gone by the time anyone can look.
		skillsOverride: (loaded) =>
			enforceProtectedSkillPrecedence(loaded, {
				packageRoots: packagePaths,
				protectedRoots: protectedSkillRoots,
			}),
		appendSystemPromptOverride: () => [guardrails, outboxProtocol, globalPersona, projectPersona].filter(Boolean),
	});
}

/**
 * Build and load. Separate from buildResourceLoader so tests can assert on a
 * half-built loader if they need to, but nothing should skip this.
 *
 * createAgentSession only calls reload() on a loader it constructed ITSELF
 * (`if (!resourceLoader)`). Pass your own and nothing reloads it -- and reload() is
 * what populates the prompt. getAppendSystemPrompt() is a plain getter with no lazy
 * load, so a forgotten reload() yields an empty persona with no error and a job that
 * succeeds. This is why the tests assert the sentinel rather than trusting the wiring.
 *
 * reload() has no early return: it re-runs the entire load every call. Call it once.
 */
export async function buildLoadedResourceLoader(options = {}) {
	const loader = buildResourceLoader(options);
	await loader.reload();
	return loader;
}
