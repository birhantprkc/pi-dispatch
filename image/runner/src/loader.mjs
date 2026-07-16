import { existsSync, readFileSync } from "node:fs";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Where the image bakes the guardrails. Outside agentDir, on purpose -- see buildResourceLoader. */
export const GUARDRAILS_PATH = "/opt/pi-dispatch/HARD_RULES.md";

/** Read-only mount the worker materialises the project's .pi/ into, from the default-branch SHA. */
export const JOB_PI_DIR = "/job/pi";

export const WORKSPACE = "/workspace";

function readIfExists(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
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
 */
export function buildResourceLoader({
	cwd = WORKSPACE,
	guardrailsPath = GUARDRAILS_PATH,
	jobPiDir = JOB_PI_DIR,
	settingsManager,
} = {}) {
	const guardrails = readFileSync(guardrailsPath, "utf8");
	const projectPersona = readIfExists(`${jobPiDir}/APPEND_SYSTEM.md`);

	return new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noContextFiles: true,
		noSkills: true,
		noExtensions: true,
		additionalSkillPaths: [`${jobPiDir}/skills`],
		additionalExtensionPaths: [`${jobPiDir}/extensions`],
		appendSystemPromptOverride: () => [guardrails, projectPersona].filter(Boolean),
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
