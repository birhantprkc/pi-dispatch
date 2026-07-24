import { existsSync, readFileSync } from "node:fs";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";

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
	globalPiDir = GLOBAL_PI_DIR,
	outboxMount = OUTBOX_MOUNT,
	outboxProtocolPath = OUTBOX_PROTOCOL_PATH,
	allowGlobalExtensions = false,
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
		additionalExtensionPaths: [
			`${jobPiDir}/extensions`,
			...(allowGlobalExtensions && existsSync(globalExtensions) ? [globalExtensions] : []),
		],
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
