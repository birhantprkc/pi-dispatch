import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createUsageMeter,
	installProcessUsageMeter,
	makeHardStopStream,
	METER_PROVIDER_PREFIX,
	PROBE_API,
	resolvePiAiCompat,
	wrapProviderStreams,
} from "../src/usage-meter.mjs";

/**
 * These tests are PURE: no pi import, no skip gate, no filesystem. Every pi-shaped dependency of
 * usage-meter.mjs is injected, which is the whole point of splitting it that way -- the module that
 * decides how much a job is allowed to spend must be verifiable without a provider, a network, or a
 * particular node_modules layout on the machine running CI.
 */

/**
 * Stands in for pi-ai's EventStream with the two properties the meter depends on: `result()` is a
 * MEMOISED promise resolved on the terminal event, and it is independent of the async iterator, so
 * observing the result does not consume the stream. Mirrors dist/utils/event-stream.js.
 */
class FakeStream {
	constructor() {
		this.events = [];
		this.ended = false;
		this.resultCalls = 0;
		this.settled = new Promise((resolve, reject) => {
			this.settle = resolve;
			this.fail = reject;
		});
		this.settled.catch(() => {}); // keep an intentionally rejected fixture from tripping node:test
	}
	push(event) {
		this.events.push(event);
	}
	end(message) {
		this.ended = true;
		this.settle(message);
	}
	result() {
		this.resultCalls += 1;
		return this.settled;
	}
	async *[Symbol.asyncIterator]() {
		for (const event of this.events) yield event;
	}
}

/** Same shape as token-budget.test.mjs's helper -- one usage object per billed provider call. */
const usage = ({ input = 0, output = 0, total = input + output, cost = 0 }) => ({
	input,
	output,
	totalTokens: total,
	cost: { total: cost },
});

/** The assistant message a settled provider stream resolves to. */
const settledWith = (u) => ({ role: "assistant", usage: u });

const MODEL = { api: "anthropic-messages", provider: "anthropic", id: "claude-x" };

/** A settled stream that carries the given usage, ready for observe(). */
function streamOf(u) {
	const stream = new FakeStream();
	stream.end(settledWith(u));
	return stream;
}

/** Drain a stream so "observe did not consume it" is checked against real iteration. */
async function drain(stream) {
	const out = [];
	for await (const event of stream) out.push(event);
	return out;
}

/** Let the observe() result-handler microtasks run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------------------
// createUsageMeter
// ---------------------------------------------------------------------------------------------

test("accumulates input/output/billed total/cost across records", () => {
	const meter = createUsageMeter({ maxTokens: null });

	meter.record(usage({ input: 100, output: 20, total: 500, cost: 0.01 }));
	meter.record(usage({ input: 200, output: 30, total: 700, cost: 0.02 }));

	assert.equal(meter.state.input, 300);
	assert.equal(meter.state.output, 50);
	// totalTokens is the BILLED total (input + output + cache), so it exceeds input + output. Same
	// deliberate asymmetry as token-budget.mjs.
	assert.equal(meter.state.total, 1200);
	assert.equal(Math.round(meter.state.cost * 100) / 100, 0.03);
	assert.equal(meter.state.unpriced, 0);
	assert.equal(meter.snapshot().metered, true);
});

test("splits tokens across root / other / loose and keeps the sum invariant", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root-1" });

	meter.record(usage({ total: 100 }), { sessionId: "root-1" });
	meter.record(usage({ total: 200 }), { sessionId: "child-a" });
	meter.record(usage({ total: 300 }), { sessionId: "child-b" });
	meter.record(usage({ total: 400 }), { sessionId: "child-a" }); // repeat id, still one session
	meter.record(usage({ total: 50 })); // no ctx at all
	meter.record(usage({ total: 25 }), { sessionId: "" }); // empty id is not a session

	assert.equal(meter.state.rootTotal, 100);
	assert.equal(meter.state.otherTotal, 900, "subagent spend the per-session bus cannot see");
	assert.equal(meter.state.looseTotal, 75);
	assert.equal(
		meter.state.rootTotal + meter.state.otherTotal + meter.state.looseTotal,
		meter.state.total,
		"the split must partition the billed total exactly",
	);
	assert.equal(meter.snapshot().sessions, 3, "root-1, child-a, child-b -- distinct non-empty ids");
});

test("with no rootSessionId every attributed call is other, never root", () => {
	const meter = createUsageMeter({ maxTokens: null });
	meter.record(usage({ total: 10 }), { sessionId: "s1" });
	meter.record(usage({ total: 5 }));
	assert.equal(meter.state.rootTotal, 0, "an absent root must not swallow unattributed calls");
	assert.equal(meter.state.otherTotal, 10);
	assert.equal(meter.state.looseTotal, 5);
});

test("onBreach fires exactly once, synchronously, on the first crossing record", () => {
	const fired = [];
	const meter = createUsageMeter({ maxTokens: 1000, onBreach: (total) => fired.push(total) });

	meter.record(usage({ total: 500 }));
	assert.deepEqual(fired, [], "must not fire at or below the cap");
	assert.equal(meter.state.breached, false);

	meter.record(usage({ total: 600 })); // 1100 cumulative -> over
	assert.deepEqual(fired, [1100], "fires inside record(), before it returns");
	assert.equal(meter.state.breached, true);

	meter.record(usage({ total: 900 }));
	meter.record(usage({ total: 900 }));
	assert.deepEqual(fired, [1100], "exactly once, however much more arrives");
	assert.equal(meter.state.total, 2900, "accumulation continues so the overshoot stays visible");
});

test("a null or absent cap is a pure meter, not an error", () => {
	assert.doesNotThrow(() => createUsageMeter({ maxTokens: null }));
	assert.doesNotThrow(() => createUsageMeter({}));
	const meter = createUsageMeter({ maxTokens: null, onBreach: () => assert.fail("no cap, no breach") });
	meter.record(usage({ total: 10_000_000 }));
	assert.equal(meter.state.breached, false);
});

test("rejects a nonsensical cap with attachTokenBudget's exact verdict", () => {
	// Both read the same PI_MAX_TOKENS knob; two different verdicts on one value would be a trap.
	for (const bad of [0, -1, 1.5, Number.NaN]) {
		assert.throws(() => createUsageMeter({ maxTokens: bad }), /invalid PI_MAX_TOKENS/);
	}
});

test("observe returns the same stream object and does not consume it", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	const stream = new FakeStream();
	stream.push({ type: "text_delta", delta: "a" });
	stream.push({ type: "text_delta", delta: "b" });
	stream.end(settledWith(usage({ input: 7, output: 3, total: 10 })));

	const returned = meter.observe(stream, { sessionId: "s1" });

	assert.equal(returned, stream, "no proxy, no wrapper -- pi compares stream identity downstream");
	const events = await drain(stream);
	assert.equal(events.length, 2, "result() must not steal events from the iterator");
	await flush();
	assert.equal(meter.state.total, 10);
});

test("unresolved rises on observe and falls on settle; a hung stream stays counted", async () => {
	const meter = createUsageMeter({ maxTokens: null });

	const settledStream = new FakeStream();
	meter.observe(settledStream);
	assert.equal(meter.state.unresolved, 1);
	assert.equal(meter.state.calls, 1);
	settledStream.end(settledWith(usage({ total: 42 })));
	await flush();
	assert.equal(meter.state.unresolved, 0);
	assert.equal(meter.state.total, 42);

	const hung = new FakeStream(); // never ends
	meter.observe(hung);
	await flush();
	assert.equal(meter.state.unresolved, 1, "an unsettled call means the totals are a floor");
	assert.equal(meter.state.calls, 2);
});

test("a rejected result() is swallowed and still clears unresolved", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	const stream = new FakeStream();
	meter.observe(stream);
	stream.fail(new Error("transport died"));
	await flush();
	assert.equal(meter.state.unresolved, 0);
	assert.equal(meter.state.total, 0);
});

test("observing the same stream twice counts it once", async () => {
	// ModelRegistry.refresh() re-applies our stored configs as fresh entry objects, so a wrapper chain
	// can form across a reload and hand the identical stream to every link.
	const meter = createUsageMeter({ maxTokens: null });
	const stream = streamOf(usage({ total: 60 }));
	meter.observe(stream);
	meter.observe(stream);
	await flush();
	assert.equal(meter.state.calls, 1);
	assert.equal(meter.state.total, 60);
});

test("counts unpriced calls instead of pricing them at zero", async () => {
	const meter = createUsageMeter({ maxTokens: null });

	meter.record({ input: 1, output: 1, totalTokens: 2 }); // no cost object at all
	meter.record({ input: 1, output: 1, totalTokens: 2, cost: {} }); // cost, no total
	meter.record({ input: 1, output: 1, totalTokens: 2, cost: { total: "1.5" } }); // not a number
	meter.record({ input: 1, output: 1, totalTokens: 2, cost: { total: Number.NaN } });

	assert.equal(meter.state.unpriced, 4);
	assert.equal(meter.state.cost, 0);
	assert.equal(Number.isNaN(meter.state.cost), false, "a NaN cost would poison the whole run record");
	assert.equal(meter.state.total, 8, "unpriced calls still count their tokens");

	meter.record(usage({ total: 5, cost: 0.25 }));
	assert.equal(meter.state.cost, 0.25);
	assert.equal(meter.state.unpriced, 4);
});

// ---------------------------------------------------------------------------------------------
// wrapProviderStreams
// ---------------------------------------------------------------------------------------------

/** A `Models`-shaped stand-in for pi-ai's builtinModels() catalog. */
function fakeCatalog(models) {
	const calls = [];
	return {
		calls,
		getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
		streamSimple(model, context, options) {
			calls.push({ model, context, options });
			return streamOf(usage({ input: 10, output: 5, total: 15, cost: 0.5 }));
		},
	};
}

/** A registry-entry-shaped stand-in for a registered api provider. */
function fakeInner() {
	const calls = [];
	return {
		api: MODEL.api,
		calls,
		streamSimple(model, context, options) {
			calls.push({ model, context, options });
			return streamOf(usage({ input: 1, output: 2, total: 3, cost: 0.1 }));
		},
	};
}

test("routes a catalog model to the builtin catalog, not to the registry entry", async () => {
	// Overriding a builtin api flips compat's shouldUseBuiltinModels to false, so compat hands us
	// catalog models it would otherwise have served itself. Two providers' auth layers live only on
	// that catalog path, so the wrapper has to take it.
	const meter = createUsageMeter({ maxTokens: null });
	const fallbackModels = fakeCatalog([MODEL]);
	const inner = fakeInner();
	const wrapper = wrapProviderStreams({ inner, fallbackModels, meter });

	const stream = wrapper.streamSimple(MODEL, [], { sessionId: "child-9" });
	await flush();

	assert.equal(fallbackModels.calls.length, 1);
	assert.equal(inner.calls.length, 0);
	assert.equal(fallbackModels.calls[0].options.sessionId, "child-9", "options must pass through intact");
	assert.equal(meter.state.total, 15);
	assert.equal(meter.state.otherTotal, 15, "sessionId from StreamOptions is what makes attribution work");
	assert.equal(typeof stream.result, "function");
});

test("routes a non-catalog model to the registry entry", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	const custom = { api: "openai-completions", provider: "acme", id: "acme-1" };
	const fallbackModels = fakeCatalog([MODEL]);
	const inner = fakeInner();
	const wrapper = wrapProviderStreams({ inner, fallbackModels, meter });

	wrapper.streamSimple(custom, [], {});
	await flush();

	assert.equal(inner.calls.length, 1);
	assert.equal(fallbackModels.calls.length, 0);
	assert.equal(meter.state.total, 3);
	assert.equal(meter.state.looseTotal, 3);
});

test("a catalog hit on a DIFFERENT api still goes to the registry entry", async () => {
	// An operator override can repoint a catalog model at another api; compat compares apis, not ids.
	const meter = createUsageMeter({ maxTokens: null });
	const fallbackModels = fakeCatalog([{ ...MODEL, api: "openai-completions" }]);
	const inner = fakeInner();
	wrapProviderStreams({ inner, fallbackModels, meter }).streamSimple(MODEL, [], {});
	await flush();
	assert.equal(inner.calls.length, 1);
	assert.equal(fallbackModels.calls.length, 0);
});

test("with no catalog loaded everything falls back to the registry entry", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	const inner = fakeInner();
	wrapProviderStreams({ inner, fallbackModels: null, meter }).streamSimple(MODEL, [], {});
	await flush();
	assert.equal(inner.calls.length, 1);
});

test("after a breach the hard stop replaces the call entirely", async () => {
	const meter = createUsageMeter({ maxTokens: 10 });
	const fallbackModels = fakeCatalog([MODEL]);
	const inner = fakeInner();
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream(), message: "cap" });
	const wrapper = wrapProviderStreams({ inner, fallbackModels, meter, hardStop });

	meter.record(usage({ total: 99 })); // breach
	assert.equal(meter.state.breached, true);

	const stream = wrapper.streamSimple(MODEL, [], { sessionId: "child-1" });
	const message = await stream.result();

	assert.equal(inner.calls.length, 0, "no provider may be reached once the cap is blown");
	assert.equal(fallbackModels.calls.length, 0);
	// "aborted", not "error": pi's isRetryableAssistantError returns false unless stopReason is
	// "error", so this terminal message cannot spin pi's auto-retry into paid retries.
	assert.equal(message.stopReason, "aborted");
	assert.equal(message.usage.totalTokens, 0);
	assert.equal(message.usage.cost.total, 0);
	assert.equal(message.role, "assistant");
	assert.equal(message.api, MODEL.api);
	assert.equal(message.provider, MODEL.provider);
	assert.equal(message.model, MODEL.id);
	assert.equal(stream.events[0].type, "error");
	assert.equal(stream.events[0].reason, "aborted");
	assert.equal(meter.state.total, 99, "a stopped call must not add usage of its own");
});

test("an unarmed hard stop never blocks, even after a breach", async () => {
	const meter = createUsageMeter({ maxTokens: 10 });
	const inner = fakeInner();
	meter.record(usage({ total: 99 }));
	wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop: null }).streamSimple(MODEL, [], {});
	assert.equal(inner.calls.length, 1, "uncapped jobs must never have a call stopped");
});

test("makeHardStopStream refuses to run without an injected stream factory", () => {
	// Defaulting it would mean importing pi statically, which is the bug this module exists to avoid.
	assert.throws(() => makeHardStopStream({}), /createStream/);
});

// ---------------------------------------------------------------------------------------------
// resolvePiAiCompat
// ---------------------------------------------------------------------------------------------

const AGENT_ENTRY = "file:///app/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const HOISTED_COMPAT = "file:///app/node_modules/@earendil-works/pi-ai/dist/compat.js";
const NESTED_COMPAT =
	"file:///app/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js";

function fakeResolve(map) {
	return (specifier) => {
		if (!(specifier in map)) throw new Error(`Cannot find package '${specifier}'`);
		return map[specifier];
	};
}

test("prefers the nested pi-ai copy -- the one pi-coding-agent actually imports", () => {
	const candidates = resolvePiAiCompat({
		resolve: fakeResolve({
			"@earendil-works/pi-coding-agent": AGENT_ENTRY,
			"@earendil-works/pi-ai/compat": HOISTED_COMPAT,
		}),
		exists: () => true,
	});
	assert.deepEqual(candidates, [
		{ tag: "nested", url: NESTED_COMPAT },
		{ tag: "hoisted", url: HOISTED_COMPAT },
	]);
});

test("falls back to the hoisted copy when no nested copy exists on disk", () => {
	const candidates = resolvePiAiCompat({
		resolve: fakeResolve({
			"@earendil-works/pi-coding-agent": AGENT_ENTRY,
			"@earendil-works/pi-ai/compat": HOISTED_COMPAT,
		}),
		exists: () => false,
	});
	assert.deepEqual(candidates, [{ tag: "hoisted", url: HOISTED_COMPAT }]);
});

test("an unresolvable package yields no candidate rather than throwing", () => {
	assert.deepEqual(resolvePiAiCompat({ resolve: fakeResolve({}), exists: () => true }), []);
	const onlyNested = resolvePiAiCompat({
		resolve: fakeResolve({ "@earendil-works/pi-coding-agent": AGENT_ENTRY }),
		exists: () => true,
	});
	assert.deepEqual(onlyNested, [{ tag: "nested", url: NESTED_COMPAT }]);
});

// ---------------------------------------------------------------------------------------------
// installProcessUsageMeter
// ---------------------------------------------------------------------------------------------

/**
 * A pi-ai copy: a module-level api-provider registry plus the compat exports we touch. The point of
 * the fixture is that a ModelRegistry writes to exactly ONE of these, which is the whole reason the
 * installer probes instead of trusting a resolved path.
 */
function fakeCopy(apis = []) {
	const registry = new Map();
	const seedBuiltins = () => {
		for (const api of apis) registry.set(api, { api, streamSimple: () => streamOf(usage({ total: 1 })) });
	};
	seedBuiltins();
	return {
		registry,
		// resetApiProviders(): clears every registration, then re-registers the builtins as FRESH
		// objects. This is what AgentSession.reload() triggers, and why the meter must be re-armable.
		reset() {
			registry.clear();
			seedBuiltins();
		},
		module: {
			getApiProvider: (api) => registry.get(api) ?? null,
			getApiProviders: () => [...registry.values()],
			createAssistantMessageEventStream: () => new FakeStream(),
		},
	};
}

/** A ModelRegistry stand-in bound to exactly one copy, as the real one is bound to the nested copy. */
function fakeModelRegistry(copy) {
	const calls = [];
	return {
		calls,
		registerProvider(name, config) {
			calls.push({ name, config });
			// The real registry re-wraps into a NEW provider object on every registration.
			copy.registry.set(config.api, { api: config.api, streamSimple: config.streamSimple });
		},
	};
}

/** The sibling the installer loads for builtinModels(), resolved relative to the accepted compat url. */
const NESTED_PROVIDERS = new URL("./providers/all.js", NESTED_COMPAT).href;

function installArgs({ copy, registryCopy = copy, ...rest }) {
	return {
		modelRegistry: fakeModelRegistry(registryCopy),
		meter: createUsageMeter({ maxTokens: null }),
		resolve: fakeResolve({
			"@earendil-works/pi-coding-agent": AGENT_ENTRY,
			"@earendil-works/pi-ai/compat": HOISTED_COMPAT,
		}),
		exists: () => true,
		load: async (url) => {
			if (url === NESTED_COMPAT) return copy.module;
			// The default fixture has NO providers/all.js -- the degraded case, so it is the one the
			// baseline tests assert against rather than the one they quietly assume away.
			const error = new Error(`no such module: ${url}`);
			error.code = "ERR_MODULE_NOT_FOUND";
			throw error;
		},
		rearmMs: 60_000,
		platform: "darwin",
		...rest,
	};
}

test("wraps every api the accepted copy has registered, and never the probe", async () => {
	const copy = fakeCopy(["anthropic-messages", "openai-completions"]);
	const args = installArgs({ copy });
	const logged = [];
	const handle = await installProcessUsageMeter({ ...args, log: (event, fields) => logged.push({ event, fields }) });
	handle.uninstall();

	assert.equal(handle.ok, true);
	assert.equal(handle.tag, "nested");
	assert.deepEqual(handle.apis, ["anthropic-messages", "openai-completions"]);
	assert.equal(handle.rearms, 0);
	assert.equal(
		copy.registry.has(PROBE_API),
		true,
		"the probe stays registered: unregisterProvider() calls refresh(), which would wipe the wrappers",
	);
	assert.equal(
		args.modelRegistry.calls.some((c) => c.config.api === PROBE_API && c.name.startsWith(METER_PROVIDER_PREFIX)),
		false,
		"the probe api must never be wrapped",
	);
	for (const api of handle.apis) {
		assert.equal(
			args.modelRegistry.calls.some((c) => c.name === `${METER_PROVIDER_PREFIX}:${api}`),
			true,
		);
	}
	assert.deepEqual(logged, [
		{
			event: "usage_meter",
			fields: {
				ok: true,
				tag: "nested",
				apis: ["anthropic-messages", "openai-completions"],
				// This fixture ships no providers/all.js and the meter is uncapped, so BOTH degradations
				// are present -- and both are stated. Reporting a bare ok:true here is the exact failure
				// these fields exist to remove.
				fallback: false,
				fallbackError: "ERR_MODULE_NOT_FOUND",
				capped: false,
				brake: false,
			},
		},
		{ event: "usage_meter_teardown", fields: { rearms: 0, apis: 2, rearmMs: 60_000 } },
	]);
	assert.equal(handle.children, null, "child sampling is Linux-only and degrades to null elsewhere");
});

test("a healthy meter reports its catalog and its brake as present", async () => {
	// The POSITIVE half. Without it, `fallback:false, brake:false` could be hard-wired and every
	// assertion above would still pass while the two fields said nothing about anything.
	const copy = fakeCopy(["anthropic-messages"]);
	const logged = [];
	const handle = await installProcessUsageMeter({
		...installArgs({ copy }),
		meter: createUsageMeter({ maxTokens: 1000 }),
		load: async (url) => {
			if (url === NESTED_COMPAT) return copy.module;
			if (url === NESTED_PROVIDERS) return { builtinModels: () => fakeCatalog([MODEL]) };
			throw new Error(`no such module: ${url}`);
		},
		log: (event, fields) => logged.push({ event, fields }),
	});
	handle.uninstall();

	assert.deepEqual(logged[0].fields, {
		ok: true,
		tag: "nested",
		apis: ["anthropic-messages"],
		fallback: true,
		capped: true,
		brake: true,
	});
	assert.equal("fallbackError" in logged[0].fields, false, "a healthy load must not report a reason");
});

test("a sibling that loads but exposes no builtinModels() is reported, not passed off as healthy", async () => {
	// The pin-bump shape: providers/all.js still resolves, its export is gone. Identical loss to a
	// failed load, so it must not read as a clean one.
	const copy = fakeCopy(["anthropic-messages"]);
	const logged = [];
	const handle = await installProcessUsageMeter({
		...installArgs({ copy }),
		load: async (url) => {
			if (url === NESTED_COMPAT) return copy.module;
			if (url === NESTED_PROVIDERS) return {};
			throw new Error(`no such module: ${url}`);
		},
		log: (event, fields) => logged.push({ event, fields }),
	});
	handle.uninstall();

	assert.equal(logged[0].fields.fallback, false);
	assert.equal(logged[0].fields.fallbackError, "no-builtin-models");
});

test("a cap with no stream factory is logged as capped-but-brakeless", async () => {
	// The silent one: the accepted module exposes neither createAssistantMessageEventStream nor
	// AssistantMessageEventStream, so the pre-dispatch brake vanishes and the cap can only be enforced
	// after a call has already been paid for. capped:true + brake:false is what says so.
	const copy = fakeCopy(["anthropic-messages"]);
	delete copy.module.createAssistantMessageEventStream;
	const logged = [];
	const handle = await installProcessUsageMeter({
		...installArgs({ copy }),
		meter: createUsageMeter({ maxTokens: 1000 }),
		log: (event, fields) => logged.push({ event, fields }),
	});
	handle.uninstall();

	assert.equal(logged[0].fields.capped, true);
	assert.equal(logged[0].fields.brake, false);
});

test("teardown reports the re-arm count, so a post-reset unmetered window is inferable", async () => {
	// The gap: resetApiProviders() wipes the wrappers and replays nothing, so a provider call landing
	// before the next poll is metered NOWHERE and the totals simply come out low. rearms > 0 on this
	// line is the only evidence such a window existed; rearmMs is how wide it could have been.
	const copy = fakeCopy(["anthropic-messages", "openai-completions"]);
	const logged = [];
	const handle = await installProcessUsageMeter({
		...installArgs({ copy }),
		log: (event, fields) => logged.push({ event, fields }),
	});

	copy.reset();
	handle.arm();
	handle.uninstall();
	handle.uninstall(); // idempotent: a second teardown must not double the record

	const teardown = logged.filter((entry) => entry.event === "usage_meter_teardown");
	assert.equal(teardown.length, 1);
	assert.deepEqual(teardown[0].fields, { rearms: 2, apis: 2, rearmMs: 60_000 });
});

test("rejects a copy whose registry cannot see the probe and advances to the next candidate", async () => {
	// The exact failure this module exists to prevent: the hoisted copy imports cleanly, registers
	// cleanly, and meters nothing, because the ModelRegistry writes to the nested copy.
	const nested = fakeCopy(["anthropic-messages"]);
	const hoisted = fakeCopy(["anthropic-messages"]);
	const modelRegistry = fakeModelRegistry(hoisted); // bound to the WRONG copy for the nested candidate

	const handle = await installProcessUsageMeter({
		...installArgs({ copy: nested }),
		modelRegistry,
		load: async (url) => {
			if (url === NESTED_COMPAT) return nested.module;
			if (url === HOISTED_COMPAT) return hoisted.module;
			throw new Error(`no such module: ${url}`);
		},
	});
	handle.uninstall();

	assert.equal(handle.ok, true);
	assert.equal(handle.tag, "hoisted", "acceptance is decided by mutation probe, not by resolved path");
	assert.equal(nested.registry.has(`${METER_PROVIDER_PREFIX}`), false);
	assert.deepEqual(handle.apis, ["anthropic-messages"]);
});

test("returns ok:false when no candidate can be proven, so the caller can fall back", async () => {
	const blind = fakeCopy(["anthropic-messages"]);
	const visible = fakeCopy([]);
	const logged = [];
	const handle = await installProcessUsageMeter({
		...installArgs({ copy: blind }),
		modelRegistry: fakeModelRegistry(visible), // writes somewhere neither candidate can see
		load: async (url) => {
			if (url === NESTED_COMPAT || url === HOISTED_COMPAT) return blind.module;
			throw new Error(`no such module: ${url}`);
		},
		log: (event, fields) => logged.push({ event, fields }),
	});

	assert.equal(handle.ok, false);
	assert.doesNotThrow(() => handle.arm());
	assert.doesNotThrow(() => handle.uninstall());
	assert.equal(logged.length, 1);
	assert.equal(logged[0].event, "usage_meter_unavailable");
	assert.deepEqual(logged[0].fields.tried, ["nested", "hoisted"]);
	assert.equal(
		JSON.stringify(logged[0].fields).includes("/"),
		false,
		"logs ship: tags only, never a filesystem path",
	);
});

test("arm() re-wraps after a simulated resetApiProviders() and counts the re-arm", async () => {
	// A bare resetApiProviders() -- what AgentSession.reload() calls -- wipes our registrations without
	// replaying them. Install-once would silently stop metering from that moment on.
	const copy = fakeCopy(["anthropic-messages", "openai-completions"]);
	const handle = await installProcessUsageMeter(installArgs({ copy }));
	handle.uninstall();

	const beforeReset = copy.registry.get("anthropic-messages");
	handle.arm();
	assert.equal(handle.rearms, 0, "an already-wrapped entry must not be wrapped again");
	assert.equal(copy.registry.get("anthropic-messages"), beforeReset, "arm() is idempotent while armed");

	copy.reset();
	handle.arm();

	assert.equal(handle.rearms, 2, "one per api id re-wrapped after the wipe");
	assert.deepEqual(handle.apis, ["anthropic-messages", "openai-completions"]);
	assert.notEqual(copy.registry.get("anthropic-messages"), beforeReset);
	assert.equal(copy.registry.has(PROBE_API), false, "the wipe took the probe too; we do not re-add it");
});

test("a wrapped api routes real calls through the meter", async () => {
	const copy = fakeCopy(["anthropic-messages"]);
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root-1" });
	const handle = await installProcessUsageMeter(installArgs({ copy, meter }));
	handle.uninstall();

	// Exactly what compat does once the api id is overridden: resolve the entry, call streamSimple.
	const entry = copy.registry.get("anthropic-messages");
	entry.streamSimple(MODEL, [], { sessionId: "child-3" });
	entry.streamSimple(MODEL, [], { sessionId: "root-1" });
	await flush();

	assert.equal(meter.state.calls, 2);
	assert.equal(meter.state.total, 2);
	assert.equal(meter.state.otherTotal, 1, "a subagent call the session bus would have missed entirely");
	assert.equal(meter.state.rootTotal, 1);
});
