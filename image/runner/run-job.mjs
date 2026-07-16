import { readFileSync } from "node:fs";
import {
	AuthStorage,
	createAgentSession,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildLoadedResourceLoader, WORKSPACE } from "./src/loader.mjs";
import { classifyStopReason, classifyThrow, EXIT_INFRA, EXIT_POLICY } from "./src/outcome.mjs";
import { attachTurnBudget } from "./src/turn-budget.mjs";

const PROMPT_PATH = "/job/prompt.md";

/** Log a stable identifier, never task content. Issue bodies are user-authored personal data. */
function log(event, fields = {}) {
	process.stdout.write(`${JSON.stringify({ event, jobId: process.env.PI_JOB_ID, ...fields })}\n`);
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`missing required env: ${name}`);
	return value;
}

async function main() {
	const provider = requireEnv("PI_PROVIDER");
	const modelId = requireEnv("PI_MODEL");
	const maxTurns = Number.parseInt(requireEnv("PI_MAX_TURNS"), 10);

	const agentDir = getAgentDir();

	// AuthStorage + ModelRegistry, NOT ModelRuntime.
	//
	// pi's [Unreleased] changelog says these two are replaced by an async `modelRuntime`.
	// That is true of its main branch and NOT of 0.80.7, which is what we pin -- the source
	// at HEAD and the artifact on npm are different things, and conflating them cost a build.
	// When the migration ships, REQ-UPSTREAM-CONTRACT-TESTS fires on the pin bump and this
	// is the code that changes. See OQ-005.
	const authStorage = AuthStorage.create(`${agentDir}/auth.json`);
	const modelRegistry = ModelRegistry.create(authStorage, `${agentDir}/models.json`);

	// Pin the model explicitly. With `model` omitted, pi picks from settings and provider
	// defaults -- nondeterministic across images, and it silently changes cost per job. A
	// missing model surfaces as a fallback message on the RESULT rather than a throw, so
	// validate here and fail loudly instead of discovering it on a bill.
	const model = modelRegistry.find(provider, modelId);
	if (!model) {
		log("model_unknown", { provider, modelId });
		return EXIT_POLICY; // config error: retrying cannot fix it
	}
	if (!modelRegistry.hasConfiguredAuth(model)) {
		// Catch this before the container spends anything. Preflight would throw on it
		// anyway, but a clear signal beats parsing a message out of an exception.
		log("model_no_auth", { provider, modelId });
		return EXIT_POLICY;
	}

	// Pin pi's own retry settings rather than inherit `maxRetries ?? 3`. An upstream default
	// change would silently move our spend -- CONST-PI-VERSION-PINNED's reasoning, applied to
	// a default instead of a version. inMemory() is also what keeps a serviced project's
	// .pi/settings.json from overriding these: it writes to the GLOBAL scope of a storage
	// with no project file, so the project layer is empty by construction.
	const settingsManager = SettingsManager.inMemory({
		retry: {
			enabled: true,
			maxRetries: Number.parseInt(process.env.PI_RETRY_MAX ?? "2", 10),
			baseDelayMs: Number.parseInt(process.env.PI_RETRY_BASE_MS ?? "2000", 10),
		},
	});

	const resourceLoader = await buildLoadedResourceLoader({ settingsManager });

	const { session } = await createAgentSession({
		cwd: WORKSPACE,
		agentDir,
		authStorage,
		modelRegistry,
		model,
		settingsManager,
		sessionManager: SessionManager.inMemory(WORKSPACE),
		resourceLoader,
	});

	// Capture the terminal message. prompt() returns Promise<void>, so this subscription is
	// the ONLY channel through which the outcome arrives.
	let terminal;
	const unsubscribeTerminal = session.subscribe((event) => {
		if (event.type === "turn_end" || event.type === "agent_end") {
			terminal = event.message ?? event.messages?.at(-1) ?? terminal;
		}
		if (event.type === "auto_retry_start") {
			// pi retries internally. Surface it: our daily cap counts jobs, not provider calls.
			log("pi_auto_retry", { attempt: event.attempt, maxAttempts: event.maxAttempts });
		}
	});

	const budget = attachTurnBudget(session, maxTurns, {
		onAbort: (turns) => log("turn_budget_exceeded", { turns, maxTurns }),
	});

	try {
		await session.prompt(readFileSync(PROMPT_PATH, "utf8"));
	} finally {
		budget.unsubscribe();
		unsubscribeTerminal();
	}

	// The budget firing is authoritative. An abort surfaces as stopReason "aborted", but
	// checking our own state first means a future upstream change to that mapping cannot
	// silently turn a blown budget into exit 0.
	if (budget.state.aborted) {
		log("exit", { code: EXIT_POLICY, reason: "turn_budget", turns: budget.state.turns });
		return EXIT_POLICY;
	}

	const outcome = classifyStopReason(terminal);
	log("exit", { ...outcome, turns: budget.state.turns });
	return outcome.code;
}

// Preflight throws; the agent loop swallows. Both paths are real and they cover disjoint
// failure sets -- see INT-RUNNER-EXIT-CODE-PROTOCOL. Without this catch, a missing API key
// is an unhandled rejection exiting Node's default 1, which the protocol defines as
// RETRYABLE, so the queue would pay to retry a job that can never succeed.
main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		const outcome = classifyThrow(error);
		log("exit", { code: outcome.code, reason: outcome.reason, message: outcome.message });
		process.exitCode = outcome.code ?? EXIT_INFRA;
	});
