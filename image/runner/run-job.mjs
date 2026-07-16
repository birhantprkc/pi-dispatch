import { existsSync, readFileSync } from "node:fs";
import {
	AuthStorage,
	createAgentSession,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { parseRunnerEnv } from "./src/config.mjs";
import { buildLoadedResourceLoader, WORKSPACE } from "./src/loader.mjs";
import {
	captureTerminal,
	classifyThrow,
	configError,
	decideExit,
	EXIT_INFRA,
} from "./src/outcome.mjs";
import { attachTurnBudget } from "./src/turn-budget.mjs";

const PROMPT_PATH = "/job/prompt.md";

/** Log a stable identifier, never task content. Issue bodies are user-authored personal data. */
function log(event, fields = {}) {
	process.stdout.write(`${JSON.stringify({ event, jobId: process.env.PI_JOB_ID, ...fields })}\n`);
}

function readPrompt(path) {
	// A missing prompt file is a worker bug (it failed to write /job inputs), not infra -- the
	// same job would fail identically on retry. Classify it as config, exit 2.
	if (!existsSync(path)) throw configError(`missing job input: ${path}`);
	return readFileSync(path, "utf8");
}

async function main() {
	const cfg = parseRunnerEnv(process.env);
	const prompt = readPrompt(PROMPT_PATH);

	const agentDir = getAgentDir();

	// AuthStorage + ModelRegistry, NOT ModelRuntime.
	//
	// pi's [Unreleased] changelog says these two are replaced by an async `modelRuntime`. That is
	// true of its main branch and NOT of 0.80.7, which is what we pin -- the source at HEAD and the
	// artifact on npm are different things, and conflating them cost a build. When the migration
	// ships, REQ-UPSTREAM-CONTRACT-TESTS fires on the pin bump and this is the code that changes.
	// See OQ-005.
	const authStorage = AuthStorage.create(`${agentDir}/auth.json`);
	const modelRegistry = ModelRegistry.create(authStorage, `${agentDir}/models.json`);

	// Pin the model explicitly. With `model` omitted, pi picks from settings and provider defaults
	// -- nondeterministic across images, and it silently changes cost per job.
	const model = modelRegistry.find(cfg.provider, cfg.model);
	if (!model) throw configError(`unknown model: ${cfg.provider}/${cfg.model}`);
	if (!modelRegistry.hasConfiguredAuth(model)) throw configError(`no configured auth for ${cfg.provider}`);

	// Pin pi's own retry settings rather than inherit `maxRetries ?? 3`. An upstream default change
	// would silently move our spend (CONST-PI-VERSION-PINNED's reasoning, applied to a default). And
	// inMemory() writes to the GLOBAL scope of a storage with no project file, so a serviced
	// project's .pi/settings.json cannot override our spend controls.
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, ...cfg.retry } });

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

	// prompt() returns Promise<void>, so this subscription is the ONLY channel through which the
	// outcome arrives. captureTerminal handles both event shapes (agent_end carries messages[],
	// turn_end carries message).
	let terminal;
	const unsubscribeTerminal = session.subscribe((event) => {
		terminal = captureTerminal(terminal, event);
		if (event.type === "auto_retry_start") {
			// pi retries internally. Surface it: our daily cap counts jobs, not provider calls.
			log("pi_auto_retry", { attempt: event.attempt, maxAttempts: event.maxAttempts });
		}
	});

	const budget = attachTurnBudget(session, cfg.maxTurns, {
		onAbort: (turns) => log("turn_budget_exceeded", { turns, maxTurns: cfg.maxTurns }),
	});

	try {
		await session.prompt(prompt);
	} finally {
		budget.unsubscribe();
		unsubscribeTerminal();
		// Runs the cleanup callbacks providers register via registerSessionResourceCleanup. Every
		// official SDK example disposes; skipping it can leak a provider transport and hang the
		// container until the 30-minute timeout -- a completed job turned into a timeout failure.
		session.dispose();
	}

	const outcome = decideExit({
		budgetAborted: budget.state.aborted,
		budgetTurns: budget.state.turns,
		terminal,
	});
	log("exit", { ...outcome, turns: budget.state.turns });
	return outcome.code;
}

// Preflight throws; the agent loop swallows. Both paths are real and cover disjoint failure sets
// -- see INT-RUNNER-EXIT-CODE-PROTOCOL. Without this catch, a missing API key is an unhandled
// rejection exiting Node's default 1, which the protocol defines as RETRYABLE, so the queue would
// pay to retry a job that can never succeed.
main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		const outcome = classifyThrow(error);
		log("exit", { code: outcome.code, reason: outcome.reason, message: outcome.message });
		process.exitCode = outcome.code ?? EXIT_INFRA;
	});
