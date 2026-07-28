import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Process-wide usage meter (issue #58; REQ-TOKEN-ACCOUNTING-AND-CAPS, CONST-BUDGET-BEFORE-TOKENS).
 *
 * WHY THIS EXISTS -- the negative fact that forces it:
 *
 * token-budget.mjs meters by subscribing to ONE AgentSession's event bus. That bus is PER INSTANCE:
 * `AgentSession._eventListeners` is an array on the instance and `Agent.listeners` a Set on the
 * instance, and no event carries a sessionId. A subagent session an extension spawns through
 * `createAgentSession` therefore emits NOTHING on the parent's bus. A 16-wide fanout shows up on our
 * bus as roughly ONE turn, so both the token cap and the run record understate spend precisely on
 * the most expensive jobs -- the opposite of what a spend control is for.
 *
 * The one choke point every in-process session shares is pi-ai's MODULE-LEVEL api-provider registry:
 * pi-coding-agent's agent-session.js calls compat's `streamSimple`, compat resolves the provider for
 * `model.api` out of that registry, and every session -- root or subagent -- goes through it. Metering
 * there counts calls, not turns, and `options.sessionId` (a declared field on pi-ai's StreamOptions)
 * reaches the provider, so per-session attribution comes free.
 *
 * Three traps this module is shaped around, all verified by runtime probe, none by reading source:
 *
 * 1. A BARE pi-ai SPECIFIER IS NEVER THE COPY pi USES -- and what it IS depends on the install. Where
 *    the WORKER's deps are installed too (a dev checkout, the contract-tests job) pi-ai is on disk
 *    TWICE, with SEPARATE module-level registries: the hoisted `node_modules/@earendil-works/pi-ai`,
 *    which is the WORKER's declared dependency, and the nested
 *    `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`. pi-coding-agent
 *    uses the NESTED one, so a plain `import "@earendil-works/pi-ai"` from runner code binds the
 *    HOISTED copy and is a SILENT NO-OP: it registers, reports success, and meters nothing, while
 *    `import.meta.resolve` reports a path that looks right and is wrong. The JOB IMAGE installs the
 *    RUNNER's deps only, and the runner does not declare pi-ai (see resolvePiAiCompat below for why it
 *    must not), so there the nested copy is the ONLY copy and that specifier does not resolve at all.
 *    Hence: no static pi import anywhere in this file, an ordered candidate list built with tryResolve
 *    around BOTH lookups so an unresolvable candidate is SKIPPED rather than thrown, and acceptance
 *    decided ONLY by a runtime mutation probe (register an inert provider through the ModelRegistry,
 *    then ask the candidate module whether it can see it).
 *
 * 2. `resetApiProviders()` -- what `AgentSession.reload()` calls -- WIPES the registry. So the meter
 *    cannot be install-once; it must be RE-ARMABLE, hence the unref'd re-arm interval.
 *
 * 3. Overriding a BUILTIN api id changes compat's own dispatch: `shouldUseBuiltinModels` returns false
 *    once `getApiProvider(api)` is no longer the builtin instance, so compat stops calling its own
 *    model catalog and calls US instead. Our wrapper must therefore REPRODUCE the catalog path
 *    (fallbackModels) rather than blindly delegate to the registry entry -- 2 of the 35 builtin
 *    providers (cloudflare-ai-gateway, cloudflare-workers-ai) substitute baseUrl placeholders and
 *    inject headers in their auth layer, and bypassing the catalog would break exactly those.
 *
 * The cap here is still structurally LAGGING for the same reason token-budget.mjs's is: usage is known
 * only after a call completes. The hard stop is a runaway backstop, not a before-the-spend cap.
 */

/** Provider-name prefix for our per-api wrappers. One registration per api id, upserted on re-arm. */
export const METER_PROVIDER_PREFIX = "pi-dispatch-usage-meter";
/** Provider name of the inert candidate probe. */
export const PROBE_PROVIDER = "pi-dispatch-usage-probe";
/** Api id of the inert candidate probe. Never wrapped, never dispatched to. */
export const PROBE_API = "pi-dispatch-usage-probe";

/** Coerce a possibly-absent numeric usage field. Never propagates NaN into the totals. */
function finite(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The accumulator. Pure: no pi contact, no I/O, no timers -- everything pi-shaped is injected by
 * installProcessUsageMeter, so this is the part that is fully testable and always exercised.
 *
 * `maxTokens` is validated with attachTokenBudget's exact semantics and error text, because both read
 * the same PI_MAX_TOKENS env knob and an operator must not get two different verdicts on one value.
 * null/undefined means uncapped -- the meter is ALWAYS on so totals land in run history either way.
 */
export function createUsageMeter({ maxTokens, rootSessionId, onBreach } = {}) {
	if (maxTokens !== null && maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
		throw new Error(`invalid PI_MAX_TOKENS: ${maxTokens}`);
	}
	const cap = maxTokens ?? null;
	// Only a non-empty string can be the root. An undefined rootSessionId must NOT match an undefined
	// options.sessionId -- that would file every unattributed call as root and hide the fanout.
	const root = typeof rootSessionId === "string" && rootSessionId.length > 0 ? rootSessionId : null;

	const state = {
		input: 0,
		output: 0,
		// totalTokens is the BILLED total (input + output + cache read/write), so total >= input + output
		// -- deliberately, exactly as in token-budget.mjs. The cap keys on billed tokens; do not "fix".
		total: 0,
		cost: 0,
		// The attribution split. INVARIANT: rootTotal + otherTotal + looseTotal === total, because every
		// record() adds its billed tokens to exactly one of the three. otherTotal > 0 is the direct
		// evidence of subagent spend that the per-session bus could not see.
		rootTotal: 0,
		otherTotal: 0,
		looseTotal: 0,
		calls: 0,
		// Streams observed but not yet settled when the job ends. A non-zero value on the exit line means
		// the totals are a floor, not a total -- better surfaced than silently rounded down.
		unresolved: 0,
		// Calls whose usage carried no finite cost.total. Counted, never guessed: a silent 0 would read
		// as "this call was free", which is the one thing a spend control must never claim.
		unpriced: 0,
		breached: false,
		sessionIds: new Set(),
	};

	// Streams already accounted for. ModelRegistry.refresh() re-applies our stored provider configs as
	// FRESH entry objects, which arm() cannot tell apart from a third party's override, so a wrapper
	// chain can form across a reload. Every link in such a chain hands us the SAME stream object; this
	// makes the double count impossible instead of merely unlikely.
	const observed = new WeakSet();

	/**
	 * SYNCHRONOUS by design, like attachTokenBudget's listener: the breach flag must be set before the
	 * caller's next line runs, or the next provider call slips through under the cap.
	 */
	function record(usage, { sessionId } = {}) {
		const u = usage ?? {};
		state.input += finite(u.input);
		state.output += finite(u.output);
		const billed = finite(u.totalTokens);
		state.total += billed;

		const price = u.cost?.total;
		if (typeof price === "number" && Number.isFinite(price)) state.cost += price;
		else state.unpriced += 1;

		const id = typeof sessionId === "string" ? sessionId : "";
		if (id.length > 0) state.sessionIds.add(id);
		if (root !== null && id === root) state.rootTotal += billed;
		else if (id.length > 0) state.otherTotal += billed;
		else state.looseTotal += billed;

		if (cap !== null && state.total > cap && !state.breached) {
			state.breached = true;
			onBreach?.(state.total);
		}
		// Accumulation continues past the breach on purpose: the overshoot is the interesting number
		// (it is what the lag actually cost), and hiding it would make the cap look tighter than it is.
		return state;
	}

	/**
	 * Attach accounting to a provider stream WITHOUT consuming it.
	 *
	 * `EventStream.result()` is a memoised promise resolved from push()/end() on the terminal event,
	 * completely independent of the async iterator. Awaiting it observes; it does not steal events from
	 * pi. The stream object is returned untouched -- no proxy, no wrapper -- so identity comparisons and
	 * `instanceof` checks downstream in pi keep working.
	 */
	function observe(stream, ctx = {}) {
		if (!stream || typeof stream.result !== "function") return stream;
		if (observed.has(stream)) return stream;
		observed.add(stream);
		state.calls += 1;
		state.unresolved += 1;
		stream.result().then(
			(message) => {
				state.unresolved -= 1;
				record(message?.usage, ctx);
			},
			() => {
				// A rejected result() is pi's problem to report; swallow it here so we never turn an
				// accounting hook into an unhandled rejection that kills the container.
				state.unresolved -= 1;
			},
		);
		return stream;
	}

	/** The exit-line shape. `metered: true` marks totals that came from here, not from the session bus. */
	function snapshot() {
		return {
			input: state.input,
			output: state.output,
			total: state.total,
			cost: state.cost,
			metered: true,
			rootTotal: state.rootTotal,
			otherTotal: state.otherTotal,
			looseTotal: state.looseTotal,
			sessions: state.sessionIds.size,
			calls: state.calls,
			unresolved: state.unresolved,
			unpriced: state.unpriced,
		};
	}

	return { state, cap, record, observe, snapshot };
}

/**
 * A ProviderStreams-shaped `{ streamSimple }` that mirrors compat's OWN dispatch and meters the result.
 *
 * Once we override an api id, compat's `shouldUseBuiltinModels` goes false and compat routes catalog
 * models to us instead of to its `compatModels` collection. Reproducing that branch here is not
 * belt-and-braces: skipping it drops the catalog's per-provider auth layer, which for
 * cloudflare-ai-gateway and cloudflare-workers-ai is where baseUrl placeholders get substituted and
 * headers injected. Those two providers would break outright.
 *
 * There is deliberately NO try/catch. A throw in here is OUR bug; swallowing it would turn a metering
 * defect into a silent provider outage that looks like a model error.
 */
export function wrapProviderStreams({ inner, fallbackModels, meter, hardStop }) {
	return {
		streamSimple(model, context, options) {
			// Checked before dispatch, so the breach stops the NEXT call rather than merely recording it.
			if (hardStop && meter.state.breached) return hardStop(model);
			const builtin = fallbackModels?.getModel?.(model.provider, model.id);
			const stream = builtin?.api === model.api
				? fallbackModels.streamSimple(model, context, options)
				: inner.streamSimple(model, context, options);
			meter.observe(stream, { sessionId: options?.sessionId });
			return stream;
		},
	};
}

/**
 * A terminal stream that ends a call before it reaches a provider.
 *
 * Shape mirrors pi-ai's `createSetupErrorMessage` (dist/api/lazy.js) so pi's consumers see something
 * they already understand, with two deliberate differences: zero usage (nothing was spent, and
 * inventing usage here would corrupt the very totals this module exists to get right) and
 * `stopReason: "aborted"` rather than `"error"`. That second one matters: pi's
 * `isRetryableAssistantError` returns false whenever stopReason !== "error", so an aborted terminal
 * message will NOT spin pi's auto-retry. An "error" here would make the cap trigger paid retries.
 *
 * `createStream` is injected -- that is what keeps this function pure and this file free of any static
 * pi import. installProcessUsageMeter passes the real `createAssistantMessageEventStream` it pulled off
 * the accepted compat module; tests pass a fake.
 */
export function makeHardStopStream({ createStream, message = "pi-dispatch: token cap exceeded" }) {
	if (typeof createStream !== "function") throw new Error("makeHardStopStream requires createStream");
	return (model) => {
		const stream = createStream();
		const aborted = {
			role: "assistant",
			content: [],
			api: model?.api,
			provider: model?.provider,
			model: model?.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: message,
			timestamp: Date.now(),
		};
		// push() resolves result() via the terminal-event predicate; end() covers a stream implementation
		// that does not. Both are idempotent on pi's EventStream (`done` short-circuits push).
		stream.push({ type: "error", reason: "aborted", error: aborted });
		stream.end(aborted);
		return stream;
	};
}

/** Resolve a specifier to a URL string, or null when the package is not installed. */
function tryResolve(resolve, specifier) {
	try {
		const url = resolve(specifier);
		return typeof url === "string" && url.length > 0 ? url : null;
	} catch {
		return null;
	}
}

/**
 * The ORDERED candidate list, most-likely-correct first.
 *
 * WHY pi-ai IS NOT IN THE RUNNER'S package.json, even though this module depends on it. What the
 * meter needs is not "a pi-ai" but pi-coding-agent's OWN pi-ai -- the copy whose module-level registry
 * a running session dispatches through (trap #1 above). No dependency declaration can express that:
 * a declared `@earendil-works/pi-ai` is a request for a copy at the runner's own tree position, which
 * npm may satisfy by hoisting a THIRD one, and the meter would then have more wrong answers to choose
 * between, not fewer. Version-matching it to the transitive pin is worse still -- it would look
 * authoritative while binding the copy nobody dispatches through. So the dependency stays deliberately
 * undeclared and the binding is settled where it can actually be settled: at runtime, by the mutation
 * probe in installProcessUsageMeter, which accepts a copy only after the ModelRegistry has been proven
 * to write to it. (package.json admits no comment, which is why this note lives here.)
 *
 * NESTED first because pi-coding-agent's own imports resolve there, and it is the registry whose
 * mutation actually affects a running session. HOISTED second only as a degraded fallback for a
 * flattened install tree where the nested copy does not exist. This ordering is a hypothesis, not a
 * conclusion -- installProcessUsageMeter proves each candidate by probe before trusting it, because
 * `import.meta.resolve` is exactly the thing that lies here.
 *
 * `resolve` and `exists` are injected so this stays pure and testable.
 */
export function resolvePiAiCompat({ resolve = (spec) => import.meta.resolve(spec), exists = defaultExists } = {}) {
	const candidates = [];

	const agentEntry = tryResolve(resolve, "@earendil-works/pi-coding-agent");
	if (agentEntry) {
		// dist/index.js -> dist -> package root.
		const packageDir = dirname(dirname(fileURLToPath(agentEntry)));
		const nested = pathToFileURL(
			join(packageDir, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"),
		).href;
		if (exists(nested)) candidates.push({ tag: "nested", url: nested });
	}

	const hoisted = tryResolve(resolve, "@earendil-works/pi-ai/compat");
	if (hoisted) candidates.push({ tag: "hoisted", url: hoisted });

	return candidates;
}

function defaultExists(url) {
	try {
		return existsSync(fileURLToPath(url));
	} catch {
		return false;
	}
}

/**
 * Linux-only child-process sampler.
 *
 * A subagent fanout that shells out shows up as child processes long before it shows up as settled
 * usage, so this is the cheapest early signal that a job went wide. Purely diagnostic: it degrades to
 * null off Linux (macOS has no /proc) and its sample() swallows everything, because a metering
 * accessory must never be able to fail a job.
 */
function createChildSampler(platform) {
	if (platform !== "linux") return null;
	const seen = new Set();
	const children = { distinct: 0, peak: 0, ticks: 0, sample };
	function sample() {
		try {
			children.ticks += 1;
			let live = 0;
			for (const tid of readdirSync("/proc/self/task")) {
				let raw;
				try {
					raw = readFileSync(`/proc/self/task/${tid}/children`, "utf8");
				} catch {
					continue; // A thread can exit between readdir and read. Expected, not an error.
				}
				for (const pid of raw.split(/\s+/)) {
					if (!pid) continue;
					live += 1;
					seen.add(pid);
				}
			}
			children.distinct = seen.size;
			if (live > children.peak) children.peak = live;
		} catch {
			// Diagnostics only.
		}
		return children;
	}
	return children;
}

/**
 * Install the meter into whichever pi-ai module-level registry pi is ACTUALLY using.
 *
 * The acceptance test is a mutation probe and nothing else: register an inert provider through the
 * ModelRegistry, then ask the candidate module `getApiProvider(PROBE_API)`. Only the copy the
 * ModelRegistry writes to can answer yes. Path inspection cannot decide this -- both copies sit at
 * plausible paths and `import.meta.resolve` names the wrong one.
 *
 * The probe is never unregistered: `ModelRegistry.unregisterProvider` calls `refresh()`, which calls
 * `resetApiProviders()`, which would wipe every wrapper we just installed. An inert api id nobody
 * dispatches to is far cheaper than that.
 *
 * Registration goes through `modelRegistry.registerProvider` rather than compat's `registerApiProvider`
 * so that `refresh()` re-applies our wrappers instead of dropping them; the unref'd interval covers the
 * bare `resetApiProviders()` path, which re-applies nothing.
 */
export async function installProcessUsageMeter({
	modelRegistry,
	meter,
	log = () => {},
	rearmMs = 1000,
	resolve,
	load = (url) => import(url),
	exists,
	platform = process.platform,
}) {
	const candidates = resolvePiAiCompat({ resolve, exists });
	const tried = [];
	let accepted = null;

	for (const candidate of candidates) {
		tried.push(candidate.tag);
		let mod;
		try {
			mod = await load(candidate.url);
		} catch {
			continue;
		}
		if (typeof mod?.getApiProvider !== "function" || typeof mod?.getApiProviders !== "function") continue;
		try {
			modelRegistry.registerProvider(PROBE_PROVIDER, {
				api: PROBE_API,
				streamSimple: () => {
					throw new Error("pi-dispatch usage probe is inert and must never be dispatched to");
				},
			});
		} catch {
			continue;
		}
		if (!mod.getApiProvider(PROBE_API)) continue; // This copy is not the one pi mutates. Next.
		accepted = { candidate, mod };
		break;
	}

	if (!accepted) {
		// Never log a filesystem path: run logs are shipped, and the image layout is not public data.
		log("usage_meter_unavailable", { tried, candidates: candidates.length });
		return { ok: false, arm: () => {}, uninstall: () => {} };
	}

	const module = accepted.mod;

	// The catalog path compat would have taken for builtin models, loaded as a SIBLING of the accepted
	// compat url so it comes from the same copy. Resolving it by specifier would reopen trap #1.
	let fallbackModels = null;
	let fallbackError = null;
	try {
		const all = await load(new URL("./providers/all.js", accepted.candidate.url).href);
		fallbackModels = all?.builtinModels?.() ?? null;
		// A module that loaded but exposes no builtinModels() is the same loss as a module that did not
		// load, and it is the shape a pin bump would produce -- so it gets its own reason, not silence.
		if (!fallbackModels) fallbackError = "no-builtin-models";
	} catch (error) {
		// Degraded but still metering: without the catalog every call goes to the registry entry, which
		// is correct for 33 of 35 builtin providers -- and WRONG for cloudflare-ai-gateway and
		// cloudflare-workers-ai, whose auth layer is where baseUrl placeholders are substituted and
		// headers injected. A code/name, never `error.message`: a module-resolution message carries the
		// full path and run logs ship.
		fallbackModels = null;
		fallbackError = error?.code ?? error?.name ?? "unknown";
	}

	// Only armed when a cap exists -- an uncapped job must never have a call stopped.
	const createStream = typeof module.createAssistantMessageEventStream === "function"
		? module.createAssistantMessageEventStream
		: typeof module.AssistantMessageEventStream === "function"
			? () => new module.AssistantMessageEventStream()
			: null;
	const hardStop = meter.cap !== null && createStream
		? makeHardStopStream({ createStream, message: "pi-dispatch: token cap exceeded" })
		: null;

	// Object identity, not api id: the registry hands back a FRESH provider object on every
	// registration, so "did we install this one?" is answerable only by identity.
	const wrapped = new Set();
	const armedApis = new Set();
	const children = createChildSampler(platform);

	const handle = { ok: true, module, tag: accepted.candidate.tag, apis: [], arm, rearms: 0, children, uninstall };

	function arm() {
		let entries;
		try {
			entries = module.getApiProviders();
		} catch {
			return handle;
		}
		for (const entry of entries ?? []) {
			const api = entry?.api;
			if (typeof api !== "string" || api === PROBE_API) continue;
			if (wrapped.has(entry)) continue;
			const { streamSimple } = wrapProviderStreams({ inner: entry, fallbackModels, meter, hardStop });
			// One provider name per api id, so re-arming upserts the stored config instead of piling up
			// registrations that refresh() would replay.
			modelRegistry.registerProvider(`${METER_PROVIDER_PREFIX}:${api}`, { api, streamSimple });
			const installed = module.getApiProvider(api);
			if (installed) wrapped.add(installed);
			if (armedApis.has(api)) handle.rearms += 1;
			else armedApis.add(api);
		}
		handle.apis = [...armedApis].sort();
		return handle;
	}

	let toreDown = false;
	function uninstall() {
		clearInterval(timer);
		if (toreDown) return;
		toreDown = true;
		// THE RE-ARM GAP, made inferable (REQ-TOKEN-ACCOUNTING-AND-CAPS).
		//
		// `resetApiProviders()` wipes our wrappers and replays nothing, and the only thing that puts them
		// back is the unref'd `rearmMs` poll. A provider call landing between the wipe and the next arm()
		// is therefore UNMETERED, and nothing else in the run record shows it: the totals just come out
		// low, which reads exactly like a cheap job. `rearms` counts the api IDS arm() found displaced,
		// not the wipes -- one wipe displaces every armed api at once, which is why `apis` is on the same
		// line, and `rearmMs` with it because the window's width is the other half of any estimate. A
		// non-zero `rearms` is the only evidence such a window existed at all. Reported at teardown
		// rather than left in a handle field nobody reads. No second timer, no extra work.
		log("usage_meter_teardown", { rearms: handle.rearms, apis: handle.apis.length, rearmMs });
	}

	arm();
	// Once, on success. A tag ("nested"/"hoisted") -- never a path.
	//
	// `fallback` and `brake` are on this line because BOTH degrade silently and BOTH change what the
	// meter is: without the catalog (`fallback:false`) the two cloudflare providers lose the auth layer
	// that substitutes their baseUrl placeholders and injects their headers, and without a hard-stop
	// stream (`brake:false`) the cap can still fire through session.abort() but the pre-dispatch brake
	// on the NEXT call is gone. Reporting a plain `ok:true` over either would be a degraded meter
	// calling itself healthy.
	//
	// `capped` rides along because it is what makes `brake` readable: an uncapped job has no brake BY
	// DESIGN, so `brake:false` alone would mean two entirely different things. `capped:true` with
	// `brake:false` is the alarm -- a cap that can only be enforced after the fact.
	log("usage_meter", {
		ok: true,
		tag: handle.tag,
		apis: handle.apis,
		fallback: fallbackModels !== null,
		...(fallbackError ? { fallbackError } : {}),
		capped: meter.cap !== null,
		brake: hardStop !== null,
	});

	const timer = setInterval(() => {
		arm();
		children?.sample();
	}, rearmMs);
	// Unref'd: this must never be the reason the container stays alive after the job finishes.
	timer.unref?.();

	return handle;
}
