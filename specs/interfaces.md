# Interfaces

The contracts below cross a process or container boundary. These are the seams where a mistake is
expensive, because both sides ship separately and nothing type-checks across the gap.

Note what makes this file worth having at a project this size: **these cross a trust boundary, not just
a process boundary.** The container is the untrusted side. Two of these contracts are the *mechanism* by
which a constitutional constraint is enforceable rather than aspirational, and one of them fails
completely silently.

There is deliberately **no data-design document**: there is no database. Redis holds BullMQ's schema,
which is BullMQ's to specify, not ours.

Evidence convention as in `constitution.md`.

---

## INT-SDK-SESSION-OPTIONS

**runner → pi SDK.** The most valuable block in this file — the only contract here that fails
*invisibly*.

- **Contract**:
  **Verified against the published `0.80.7` tarball, not against HEAD** — see the evidence convention
  in `constitution.md`. At this pin the model/auth wiring is `AuthStorage` + `ModelRegistry`. There is
  **no `ModelRuntime`**: that is HEAD-only, `[Unreleased]`, and importing it makes every job die on a
  missing export while the image builds cleanly.

  ```typescript
  const authStorage   = AuthStorage.create(`${agentDir}/auth.json`);
  // Prefer the operator overlay's models.json when the :ro overlay is mounted (REQ-GLOBAL-PI-OVERLAY) —
  // how a CUSTOM provider/model becomes resolvable. Definitions only; the key still flows env -> auth.json.
  const modelsPath = existsSync("/opt/pi-global/models.json") ? "/opt/pi-global/models.json" : `${agentDir}/models.json`;
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
  const model = modelRegistry.find(process.env.PI_PROVIDER, process.env.PI_MODEL);  // NOT getModel
  if (!model) throw configError(`unknown model`);   // configError tags exit 2 — see below
  if (!modelRegistry.hasConfiguredAuth(model)) throw configError(`no configured auth`);

  // Guardrails read EXPLICITLY from a path we own — never via discovery. See (e).
  const guardrails     = readFileSync("/opt/pi-dispatch/HARD_RULES.md", "utf8");
  const globalPersona  = readIfExists("/opt/pi-global/APPEND_SYSTEM.md"); // operator overlay, :ro (REQ-GLOBAL-PI-OVERLAY)
  const projectPersona = readIfExists("/job/pi/APPEND_SYSTEM.md");        // :ro, default-branch SHA

  const resourceLoader = new DefaultResourceLoader({
    cwd: "/workspace",
    agentDir: getAgentDir(),
    noContextFiles: true,                              // CONST-NO-CONTEXT-FILES-MANDATORY
    noSkills: true,                                    // exclude cwd/package discovery …
    noExtensions: true,                                // … we supply ours explicitly instead
    // Repo path FIRST so a repo skill overrides a global one of the same name (pi is first-path-wins).
    additionalSkillPaths:     ["/job/pi/skills", ...(existsSync("/opt/pi-global/skills") ? ["/opt/pi-global/skills"] : [])],
    // Overlay extensions are fail-closed: only when PI_GLOBAL_ALLOW_EXTENSIONS=1 AND the dir is present.
    additionalExtensionPaths: ["/job/pi/extensions", ...(allowGlobalExtensions && existsSync("/opt/pi-global/extensions") ? ["/opt/pi-global/extensions"] : [])],
    // Floor first (unremovable), then operator-global, then repo (most specific). Deploy-time overlay
    // persona is the SAME trust class as baking (DES-OPERATOR-GLOBAL-OVERLAY), distinct from the
    // admin-editable runtime settings overlay, which still may never carry persona.
    appendSystemPromptOverride: () => [guardrails, globalPersona, projectPersona].filter(Boolean),
  });
  await resourceLoader.reload();        // MANDATORY — createAgentSession will NOT do this for you
  // NOTE: reload() is NOT called with `resolveProjectTrust`. Project trust is never granted.

  const { session } = await createAgentSession({
    cwd: "/workspace",
    agentDir: getAgentDir(),
    authStorage,
    modelRegistry,
    model,
    sessionManager: SessionManager.inMemory("/workspace"),
    settingsManager: SettingsManager.inMemory({ retry: { maxRetries, baseDelayMs } }),
    resourceLoader,
  });
  ```
  **Project instructions use pi's native structure — `.pi/APPEND_SYSTEM.md` and `.pi/skills/**/SKILL.md`
  (the Agent Skills spec) — but are loaded through the explicit `additional*Paths` channel from a
  read-only mount, never through pi's cwd discovery.** Inventing a bespoke `.pi-dispatch/` layout would
  reimplement pi's resource system (`no-reimplementing-pi`); using cwd discovery would read from the
  *checked-out branch* and grant project trust. This does neither.
  **`appendSystemPrompt` is forbidden.** The smoke path is `pi -p`, **not** `pi --mode print` — that
  does not exist; `--mode` accepts `text|json|rpc` only. The internal mode union is
  `interactive|print|json|rpc` — there is no `tui`.
- **Why**: **Three of the four things that make this contract dangerous are invisible at runtime**, and
  each has its own mechanism. Read them as four separate traps, not one.

  **(a) `appendSystemPrompt` replaces discovery.** It does not compose with it. The `??` means the
  persona baked at `~/.pi/agent/APPEND_SYSTEM.md` is never looked for. No error, no warning, the job
  succeeds, and the only symptom is an agent that quietly ignores its standing rules.
  `appendSystemPromptOverride` receives the discovered content as `base` and is applied *after*
  discovery, so it is the only path preserving both.

  **(b) `appendSystemPromptOverride` is a `DefaultResourceLoader` option, not a `createAgentSession`
  option.** It is reached only by constructing the loader yourself and passing it as `resourceLoader`.
  This is the one trap here that is *not* silent — TypeScript's excess-property check rejects it on an
  object literal — but only if the options are written inline and not widened through a variable.

  **(c) `noContextFiles: true` is the SDK equivalent of `-nc`, and it is OFF BY DEFAULT.** When no
  `resourceLoader` is passed, `createAgentSession` builds `new DefaultResourceLoader({cwd, agentDir,
  settingsManager})` — which loads `AGENTS.md`. **`CONST-NO-CONTEXT-FILES-MANDATORY` is therefore
  violated by *omission*, not only by commission.** There is no flag to forget; there is a whole object
  to forget to build.

  **(d) `createAgentSession` does not `reload()` a loader you pass it.** `reload()` runs *only* inside
  the `if (!resourceLoader)` branch. `reload()` is the method that populates the persona;
  `getAppendSystemPrompt()` is a plain getter with no lazy load. **So (c) forces you to construct your
  own loader, and constructing your own obliges you to call `reload()` yourself — the two constitutional
  constraints collide exactly on the trap.** Omit it and the persona is silently empty: no error, no
  log, job succeeds. This is the second known path to the failure this project fears most, and nothing
  at runtime will ever report it — see `REQ-UPSTREAM-CONTRACT-TESTS`.

  **(e) A trusted project's `.pi/APPEND_SYSTEM.md` SHADOWS the baked guardrails — it does not layer.**
  `discoverAppendSystemPromptFile()` early-returns the project path when the project is trusted, and
  **never looks at the global one**. So "bake guardrails at `~/.pi/agent/APPEND_SYSTEM.md` and let the
  project add its own" is **incoherent**: the project's file would replace ours, silently, and the job
  would succeed. This is the *third* independent path to the persona-vanishing failure, after the `??`
  trap (a) and the missing `reload()` (d).
  **The fix removes the whole class**: read the guardrails **explicitly** from a path we own
  (`/opt/pi-dispatch/HARD_RULES.md`, outside `agentDir`) and prepend them in the override. Then no
  discovery result can shadow them, because discovery is no longer how they arrive. `base` becomes
  irrelevant and the override ignores it.

  **(f) Project trust is never granted, and is not needed.** `reload({ resolveProjectTrust })` is the only
  way to set it; we do not pass it. Trust would gate-in `.pi/settings.json`, `.pi/extensions`,
  `.pi/skills`, `.pi/SYSTEM.md` from the **checked-out working tree** — which for a PR-triggered job is
  the PR branch, possibly a fork. Instead `additionalSkillPaths` / `additionalExtensionPaths` are merged
  **in both the `noSkills`/`noExtensions` branches and are not trust-checked at all**, so
  `noSkills: true` + `additionalSkillPaths` loads *exactly* what we hand it and nothing from the tree.
  Explicit beats gated: the same principle as `noContextFiles` + an explicit read.

  `modelRegistry.find(provider, modelId)` is a **method**, not a free function; there is no exported
  `getModel`. Pin the model explicitly: with `model` omitted, pi picks from settings and provider
  defaults, which is nondeterministic across images and silently changes cost per job. A missing model
  yields a fallback message on the *result*, not a throw — validate and fail loudly.
  `SessionManager.inMemory()` because the container is ephemeral: session storage would write to a
  filesystem that is about to cease existing.
  `SettingsManager.inMemory()` is load-bearing beyond the retry pin: it writes our settings to the
  **global** scope of a storage with **no project file**, so a serviced project's `.pi/settings.json` is
  never read and **cannot override our spend controls**. `SettingsManager.create(cwd, agentDir)` would
  read it and `deepMergeSettings(global, project)` lets project win. Use `inMemory`. Deliberately.

  The complete option set **at 0.80.7** is `cwd`, `agentDir`, `authStorage`, `modelRegistry`, `model`,
  `thinkingLevel`, `scopedModels`, `noTools`, `tools`, `excludeTools`, `customTools`, `resourceLoader`,
  `sessionManager`, `settingsManager`, `sessionStartEvent`. `OQ-005`'s migration replaces the first two
  with an async `modelRuntime` and **has not shipped** — it exists only on `main`.
- **Evidence (pinned artifact — authoritative)**: `npm @earendil-works/pi-coding-agent@0.80.7 →
  dist/core/sdk.d.ts → CreateAgentSessionOptions` — `authStorage?: AuthStorage` ("Default:
  AuthStorage.create(agentDir/auth.json)"), `modelRegistry?: ModelRegistry` ("Default:
  ModelRegistry.create(authStorage, agentDir/models.json)"); **no `modelRuntime` field, and no
  `model-runtime` module in `dist/` at all** · `→ dist/core/model-registry.d.ts → find(provider, modelId)`,
  `hasConfiguredAuth(model)`, `getAvailable()`, `getAll()`, `static create(authStorage, modelsJsonPath?)`
  · `→ dist/index.js` — `AuthStorage` and `ModelRegistry` are value exports; `ModelRuntime` is absent ·
  `→ dist/core/resource-loader.d.ts` — `noContextFiles`, `noSkills`, `noExtensions`,
  `additionalSkillPaths`, `additionalExtensionPaths`, `appendSystemPromptOverride` all present at the pin
- **Evidence (HEAD — explains behaviour, does NOT establish the pin contains it)**:
  `earendil-works/pi @ 5e336cf → packages/coding-agent/src/core/sdk.ts:33-80`
  (option set; no append fields, `resourceLoader?: ResourceLoader`) · `→ sdk.ts:164` (`createAgentSession`
  is async) · `→ sdk.ts:176-180` (default loader is built
  **and `reload()`ed** only when none is passed) · `→ sdk.ts:187-217` (`findInitialModel` fallback;
  `modelFallbackMessage` returned, not thrown) · `→ resource-loader.ts:122-157`
  (`DefaultResourceLoaderOptions`; `cwd`/`agentDir` **required**) · `→ resource-loader.ts:156`
  (`appendSystemPromptOverride?: (base: string[]) => string[]`) · `→ resource-loader.ts:463-470`
  (`noContextFiles` gates `loadProjectContextFiles`) · `→ resource-loader.ts:480-482` (the `??`) ·
  `→ resource-loader.ts:286` (`getAppendSystemPrompt` is a plain getter) · `→ resource-loader.ts:338,489`
  (`async reload`, `this.loaded = true`) · `→ model-runtime.ts:293 → getModel(providerId, modelId)` ·
  `→ session-manager.ts:1479 → static inMemory()` · `→ args.ts:10 → type Mode = "text" | "json" | "rpc"` ·
  `→ args.ts:140` (`--print`/`-p` is a separate boolean) · `→ project-trust.ts:12` (`AppMode`)
- **Traces to**: `DES-PERSONA-VIA-APPEND-SYSTEM-MD`, `CONST-PERSONA-IN-CACHED-PREFIX`,
  `CONST-NO-CONTEXT-FILES-MANDATORY`, `REQ-UPSTREAM-CONTRACT-TESTS`, `OQ-005`
- **Acceptance**: Constructing the loader exactly as the runner does and calling `reload()`,
  `getAppendSystemPrompt()` contains both the persona sentinel and the per-flow sentinel, and
  `getAgentsFiles().agentsFiles` is empty in the presence of a hostile `AGENTS.md`. This is assertable
  **offline, with no provider call** — the loader boundary is pure, which is what makes the scariest
  assertions in this project free.
  **The fully-assembled prompt is also assertable for free**, which `REQ-UPSTREAM-CONTRACT-TESTS`
  depends on. `buildSystemPrompt` is not exported from the package root (only its options type is), but
  an **inline extension** observing `before_agent_start` receives the complete assembled `systemPrompt`,
  and that event is emitted **strictly before** anything that can reach the network — so the assertion
  costs zero tokens. Register it via `DefaultResourceLoaderOptions.extensionFactories`:
  ```typescript
  const captured: string[] = [];
  const probe = { name: "assert-system-prompt",
    factory: (pi) => { pi.on("before_agent_start", (e) => { captured.push(e.systemPrompt); }); } };
  ```
  Unlike `subscribe()`'s listener, an extension handler **may be async and is awaited**.
  **Model IDs**: provider id is `"anthropic"`. Valid ids at the pin include `claude-opus-4-8`,
  `claude-sonnet-5`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`. **The unsuffixed ids are
  floating "(latest)" aliases; the `-YYYYMMDD` ones are pinned snapshots.** Prefer a dated id where one
  exists — a floating alias silently changes the model, and therefore the cost and behaviour, under a
  fixed pi pin, which is the same failure `CONST-PI-VERSION-PINNED` exists to prevent. Note the newest
  models have no dated variant in this catalog, so that is a real trade, not a free win.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → core/agent-session.ts:1213 → emitBeforeAgentStart`
  vs `→ agent-session.ts:1252 → await this._runAgentPrompt(messages)` (the only path to a provider
  request — assembly and emit both precede it) · `→ core/extensions/types.ts:686-696 →
  BeforeAgentStartEvent` (carries `prompt`, `images?`, `systemPrompt` **fully assembled**,
  `systemPromptOptions`) · `→ types.ts:1161 → ExtensionHandler` (may be async; awaited) ·
  `→ types.ts:1477-1483 → InlineExtension` · `→ resource-loader.ts:131` (`extensionFactories`) ·
  `→ packages/ai/src/providers/anthropic.models.ts` (auto-generated catalog) ·
  `→ packages/ai/src/providers/anthropic.ts:12-14 → envApiKeyAuth("Anthropic API key", ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"])`
  — the OAuth precedence is baked into the provider definition too, independently of `env-api-keys.ts`

## INT-RUNNER-EXIT-CODE-PROTOCOL

**container → worker.**

- **Contract**:
  | Code | Meaning | Queue behaviour |
  |---|---|---|
  | `0` | Agent completed — **including** concluding "I cannot fix this" | Success. Never retried |
  | `1` | Infrastructure failure (container died, network, provider 5xx/429) | Retryable |
  | `2` | Budget or policy refusal (cap exhausted, turn budget hit, token budget hit) | Not retried |

  **A worker-initiated termination overrides the numeric code.** When the worker itself stops the
  container — `docker stop` on the 30-minute timeout (`cancelJob`) or on graceful shutdown, delivering
  SIGTERM (`143`) then SIGKILL (`137`) — the outcome is classified **POLICY, not retried**, keyed on the
  worker's own abort signal rather than the exit code, because a worker SIGKILL and a kernel OOM both
  surface as `137`. Retrying a worker-aborted job re-runs a wedged run into a second PR. This is distinct
  from the runner's clean in-process abort (turn budget / timeout observed inside the container, exit
  `2`) and from an **unbidden** OOM-`137` with no worker abort, which stays infra-retryable (`1` class).

  **The runner needs BOTH a `try`/`catch` AND `stopReason` handling — they cover disjoint failure sets.**
  `session.prompt()` is `Promise<void>`, so there is no return value to inspect; the terminal message is
  captured via `subscribe()` (`turn_end` / `agent_end`).

  | Failure | Surfaces as | Exit |
  |---|---|---|
  | **Our own precondition fails** — missing/malformed `PI_*` env, missing `/job/prompt.md`, unknown model | **throws a tagged `configError`** | `2` — deterministic; the worker passes the same bad value on every retry |
  | No API key for the provider | **throws** (preflight) | `2` — config error; retrying cannot fix it |
  | No model selected / unknown model | **throws** (preflight) | `2` — same |
  | Streaming without `streamingBehavior` | **throws** (preflight) | `1` — our bug |
  | `"Agent is already processing."` | **throws** (before the lifecycle try) | `1` — our bug |
  | Extension error in `before_agent_start` | **throws** (preflight) | `1` |
  | Provider 429 / 5xx / network death | `stopReason: "error"` | `1` — infra, retryable |
  | Our turn budget or timeout aborts | `stopReason: "aborted"` | `2` |
  | Our per-job **token budget** aborts | `stopReason: "aborted"` | `2` — `decideExit` intercepts it as `reason: "token_budget"` BEFORE the generic `"aborted"`, exactly as the turn budget is intercepted (`REQ-TOKEN-ACCOUNTING-AND-CAPS`) |
  | Normal completion | `stopReason: "stop"` \| `"toolUse"` | `0` |
  | **Output truncated at the token limit** | `stopReason: "length"` | `0`, **but log it** — it is a completed run, not a silent failure, and must not be mistaken for either |

  `StopReason` is exactly `"stop" | "length" | "toolUse" | "error" | "aborted"` — enumerate all five. A
  default-to-`0` branch would map `"length"` to success without anyone noticing the agent was cut off.

  The runner's `exit` log line carries two **read-only telemetry** fields beside the outcome — `turns` and
  `tokens` (`{ input, output, total, cost }`, the per-job usage totals). Both are recovered host-side
  (`parseExitTurns` / `parseExitTokens`) into the run record and **must not feed exit-code or retry
  classification** — that is this protocol's job. The catch-path exit line (a preflight throw, no session
  ran) omits both, so each parses to `null`.
- **Why**: This exit code **is** the mechanism `CONST-RETRY-INFRA-ONLY` is implemented by. The worker
  has no other channel to distinguish "the agent ran and said no" from "the container died" — collapse
  them and you either burn money blind-retrying determinate outcomes, or you silently swallow real infra
  failures as if the agent had decided something. The counter-intuitive part is load-bearing: **`0` on
  "can't fix"** is correct, because from the queue's perspective the work was done. The agent's verdict
  is the product, not the failure.
  **Both obvious implementations are wrong, in opposite directions.** This is why the mechanism is
  specified rather than left to the coder.

  **Wrong #1 — `try`/`catch` alone.** Inside the agent loop, pi does **not** throw.
  `Agent.runWithLifecycle` wraps the run in
  `try { await executor(signal) } catch (error) { await this.handleRunFailure(error, signal.aborted) }`
  and `handleRunFailure` **does not rethrow** — it synthesises an assistant message carrying
  `stopReason: aborted ? "aborted" : "error"` and emits an ordinary terminal event sequence. So a 429, a
  5xx, a dead network, and our own abort **all resolve `await session.prompt(...)` normally**:
  ```js
  try { await session.prompt(text); process.exit(0); }   // exits 0 on EVERY provider failure
  catch { process.exit(1); }
  ```
  The queue records success, never retries, and the job did **nothing** — verbatim the failure class
  `CONST-PI-VERSION-PINNED` names as the worst available: *the queue still reports success*. It silently
  defeats `REQ-RUNNER-TURN-BUDGET` too: the budget aborts at N, `prompt()` resolves, exit `0`, and nothing
  downstream learns the budget fired.

  **Wrong #2 — `stopReason` alone, with no `try`/`catch`.** An earlier draft of this entry asserted *"pi
  never throws"* and forbade `try`/`catch` outright. **That was false.** `AgentSession.prompt()` runs a
  preflight that rethrows, and pi's own JSDoc says so: *"@throws Error if streaming and no
  streamingBehavior specified / @throws Error if no model selected or no API key available"*. Separately,
  `Agent.runWithLifecycle` throws `"Agent is already processing."` **before** its own try block, so that
  one escapes to the caller too. A runner without a `catch` dies of an unhandled rejection on a missing
  API key and exits with Node's default `1` — which this protocol defines as **retryable**, so the queue
  pays to retry a job that can never succeed.

  The split is the point: **preflight throws; the loop swallows.** Neither mechanism alone is sufficient,
  and there is no typed error class — classify caught errors by inspection, and loop outcomes by
  `stopReason`. For errors the runner raises *itself* (bad env, missing input), do not lean on inspecting
  pi's error vocabulary: **tag them** with the exit code at the throw site (a `configError` helper), so the
  classifier honours the tag instead of pattern-matching a string it controls. A regex tuned for "no
  model / no API key" will not match "invalid PI_MAX_TURNS", and that miss silently makes a config typo
  *retryable*.

  **`session.dispose()` in the `finally`.** Every official SDK example disposes; it is the only caller of
  the provider cleanup callbacks. Skip it and a provider transport can keep the event loop alive, hanging
  the container until the 30-minute timeout turns a completed job into a timeout failure — silent, and
  exactly the class this file exists to prevent.
  **The listener must be synchronous.** `_emit` is `for (const l of this._eventListeners) { l(event); }`
  — no `await`. An `async` listener is fire-and-forget, so a budget check that awaits anything is not
  guaranteed to run before the next turn. `session.abort()` returns a promise but flips the `AbortSignal`
  synchronously inside, so `void session.abort()` from a sync listener is correct and sufficient.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → packages/agent/src/agent.ts:485-491`
  (`catch (error) { await this.handleRunFailure(error, abortController.signal.aborted) }` — no rethrow) ·
  `→ agent.ts:494-510 → handleRunFailure` (`stopReason: aborted ? "aborted" : "error"`, `errorMessage`;
  emits `message_start`/`message_end`/`turn_end`/`agent_end` and returns) ·
  `→ agent.ts:470-471` — `if (this.activeRun) { throw new Error("Agent is already processing.") }`,
  **outside** the try/catch, so it escapes to the caller ·
  `→ core/agent-session.ts:1242-1244` — `catch (error) { preflightResult?.(false); throw error; }`
  (**the preflight rethrow that refutes "pi never throws"**) ·
  `→ agent-session.ts:1099-1100` — JSDoc: *"@throws Error if streaming and no streamingBehavior
  specified / @throws Error if no model selected or no API key available (when not streaming)"* ·
  `→ agent-session.ts:1102 → async prompt(text, options?): Promise<void>` (**no return value**) ·
  `→ packages/ai/src/types.ts:380 → export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"`
  (all five — note `"length"`) · `→ agent-session.ts:527-531 → _emit` (sync, unawaited) ·
  `→ agent-session.ts:2610-2614 → _isRetryableError` → `isRetryableAssistantError(message)` — classifies
  the **message**, not a thrown error
- **Traces to**: `CONST-RETRY-INFRA-ONLY`, `REQ-RUNNER-TURN-BUDGET`, `REQ-JOB-STATUS-COMMENTS`,
  `REQ-UPSTREAM-CONTRACT-TESTS`
- **Acceptance**: Given a runner that exits 0 after concluding no fix is possible, the job records
  success and does not re-run. Given a **simulated provider error**, the runner exits `1` — not `0`.
  Given a turn-budget abort, it exits `2` — not `0`. Both must be asserted: they are the cases the
  obvious implementation gets silently wrong.

## INT-CONTAINER-JOB-INPUTS

**worker → container.**

- **Contract**: `/job` mounted **read-only**. `/workspace` is writable; a **local** job additionally
  mounts `/outbox` (writable, `INT-OUTBOX-CONTRACT`); a **github** job does not.
  ```
  /job/prompt.md          task text (issue/PR payload, or the operator-supplied task)
  /job/event.json         webhook payload subset — an `issue` OR a `pull_request` body per the target
                          discriminator; ABSENT for local-folder jobs
  /job/pi/APPEND_SYSTEM.md      project persona   ─┐ materialised by the worker from the
  /job/pi/skills/<name>/SKILL.md project skills    ├─ project's .pi/ at the DEFAULT-BRANCH SHA,
  /job/pi/extensions/...        project extensions ┘  via `git show`, never `fs.readFile`
  ```
  **The guardrails are baked into the image** at a path outside `agentDir` and are **not** mounted.
- **Why the worker materialises `.pi/` instead of letting pi discover it**: pi's discovery reads from
  `cwd` — i.e. the **checked-out branch**, which for a PR-triggered job may be a fork. Materialising from
  the default-branch SHA into a read-only mount keeps three properties at once: the instructions are
  pi-native (`SKILL.md`, the Agent Skills spec — not a bespoke format we'd have to reimplement), they come
  from a ref only a merger can change, and **the agent cannot rewrite them mid-run** because `/job` is
  `:ro`. Read them with `git show <sha>:.pi/...` — `fs.readFile` off the clone follows **symlinks**, and
  `loadSkillsFromDir` follows them too (`entry.isSymbolicLink()` → `statSync`), so a symlinked
  `SKILL.md` or `APPEND_SYSTEM.md` would pull a worker-host file into the system prompt.
- **Why**: Read-only because the container is the **untrusted side**. The agent must not be able to
  rewrite the instructions it was handed — that filesystem permission is what makes
  `CONST-ISSUE-TEXT-IS-DATA` *enforceable* rather than merely asked-for. The persona is baked rather than
  mounted so that even a total compromise of `/job` cannot reach the system prompt: the trusted prefix
  is not reachable from the untrusted side at all.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → core/resource-loader.ts:417-418` —
  `additionalSkillPaths` is merged in **both** the `noSkills` and `else` branches and is **not**
  trust-checked · `→ resource-loader.ts:979-991 → discoverAppendSystemPromptFile` (project path
  **early-returns**, shadowing the global) · `→ resource-loader.ts:346-350` (`resolveProjectTrust` is the
  only way trust is set) · `→ core/skills.ts:168-200 → loadSkillsFromDir` (layout is `**/SKILL.md`;
  symlinks followed) · `→ skills.ts:67-81 → SkillFrontmatter` (`name`, `description`,
  `disable-model-invocation`; validated "per Agent Skills spec")
- **Traces to**: `CONST-ISSUE-TEXT-IS-DATA`, `CONST-ISOLATION-CONTAINER-PER-JOB`,
  `DES-PERSONA-VIA-APPEND-SYSTEM-MD`, `INT-SDK-SESSION-OPTIONS`
- **Acceptance**: A write to any path under `/job` fails from inside the container; `/outbox` is writable
  for a local job and absent for a github job. A hostile symlink at
  `.pi/APPEND_SYSTEM.md` or `.pi/skills/x/SKILL.md` in the serviced repo results in **no host file
  content anywhere** in `/job` or the assembled prompt.

## INT-CONTAINER-RUNTIME-CONTRACT

**worker → docker daemon.**

- **Contract**:
  - Flags: `--rm --init --cap-drop=ALL --security-opt no-new-privileges --memory=4g --cpus=2
    --pids-limit=512 --shm-size=1g`
  - User: non-root
  - **`--shm-size=1g`, and explicitly NOT `--ipc=host`.** Playwright's docs say verbatim: *"Using
    `--ipc=host` is recommended when using Chromium. Without it, Chromium can run out of memory and
    crash."* **We deliberately diverge.** `--ipc=host` shares the **host's IPC namespace** with a
    container running adversarial-input agent code — it trades a documented crash for an undocumented
    hole in `CONST-ISOLATION-CONTAINER-PER-JOB`. Playwright's docs assume a *trusted* CI container; ours
    is hostile by design. The crash is caused by Docker's default 64 MB `/dev/shm`, so `--shm-size`
    fixes the actual cause without touching namespacing. If Chromium still OOMs, **raise `--shm-size`;
    never reach for `--ipc=host`.**
  - **`--init`.** Playwright: *"recommended to avoid special treatment for processes with PID=1. This is
    a common reason for zombie processes."* Our entrypoint `exec`s the runner, so **node is PID 1** and
    reaps nothing. Chromium spawns many processes; zombies accumulate against `--pids-limit` until the
    job dies of something unrelated to its actual work.
  - Env **passed by the worker**: the configured provider's key variable(s), derived — not hardcoded
    (see below); `GITHUB_TOKEN` (scoped, short-lived — GitHub-backed jobs only); `PI_JOB_ID`; `PI_PROVIDER`;
    `PI_MODEL`; `PI_MAX_TURNS`; `PI_MAX_TOKENS` (the per-job token budget — forwarded ONLY when set, omitted
    otherwise so the runner meters usage without a cap; `REQ-TOKEN-ACCOUNTING-AND-CAPS`); `PI_CODING_AGENT_DIR`
    (if not `$HOME/.pi/agent`); `PI_GLOBAL_ALLOW_EXTENSIONS=1` (forwarded ONLY when the operator armed overlay
    extensions — fail-closed; `REQ-GLOBAL-PI-OVERLAY`); and each name in `PI_FORWARD_ENV` (an explicit operator
    allowlist of extra host vars — e.g. a custom provider's key — forwarded by exact `-e NAME=VALUE`, never a
    pass-through, so it satisfies `no-broad-env-into-container`). Note `PI_DAILY_TOKEN_CAP` is **worker-only and is
    NOT forwarded** — the daily token counter is enforced host-side, and the container stays queue/budget-blind.
  - Env **baked into the image**, because they are facts about the image and not choices a job makes:
    `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, `PLAYWRIGHT_MCP_BROWSER=chromium`,
    `PLAYWRIGHT_MCP_SANDBOX=false`. **`PLAYWRIGHT_MCP_BROWSER` is load-bearing**: `playwright-cli`
    defaults to the branded **`chrome` channel** and looks for `/opt/google/chrome/chrome`, which this
    image does not have and must not — a system Chrome with a persistent profile is exactly what
    `DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS` rejected. Omit it and every frontend job dies with
    *"Chromium distribution 'chrome' is not found"*, making `REQ-FRONTEND-VISUAL-VERIFY` dead on
    arrival. Leaving these to the worker means every caller must remember them; baking them means the
    image cannot be held wrong.
  - **The provider key variable is derived from pi's own table via `findEnvKeys(provider)`**
    (`import { findEnvKeys } from "@earendil-works/pi-ai/compat"`), never hardcoded and never
    pass-through. pi supports ~30 providers, each with its own variable, so "support any model" must not
    become "forward everything" — `no-broad-env-into-container` is a BLOCKER. Deriving the allowlist
    from pi's table rather than copying it means it **cannot drift** when pi adds a provider, and a
    hand-maintained copy is exactly the reinvention `no-reimplementing-pi` forbids. For `anthropic` the
    call returns `["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]` — **the array order *is* the
    precedence**, which is precisely the trap this rule exists for.
  - **Sourcing the key from pi's `auth.json` is a credential *source*, not a new injection path, and is ON by
    default.** When the provider key is absent from the worker env, the worker reads it **host-side** from
    `~/.pi/agent/auth.json` (honoring `PI_CODING_AGENT_DIR`) and injects it under the variable name pi expects
    — the name resolved by the same `findEnvKeys` oracle, so no hand table. It stays a HOST-SIDE read of a
    host-held secret, env-injected exactly like the env path, **never a credential file mounted into the
    container** (`CONST-TOKEN-SCOPED-PER-JOB`). **API-key credentials only**: an OAuth/subscription login is
    refused pre-spend (it expires, the container cannot refresh it, and it is not the credential for an
    unattended service). The env, when present, always wins — this is a fallback, not an override.
    `PI_AUTH_FROM_PI=0` disables it (env-only, fail-loud on a missing env key).
  - Mounts: `/job:ro`, `/workspace:rw`, — **local jobs only** — `/outbox:rw`, and — **only when
    `PI_GLOBAL_PI_DIR` is configured** — `/opt/pi-global:ro` — delivered by host bind mounts
    (`-v <hostPath>:<containerPath>`, per `DES-WORKER-ON-HOST` and `worker/src/docker-run.mjs`): the worker
    runs on the host and binds the per-job inputs dir, the workspace folder, the outbox dir, and the operator's
    global pi overlay directly. `/opt/pi-global` is the operator's own `~/.pi/agent` subset — custom models, global
    skills, a global persona — layered UNDER each repo's `.pi/` (`REQ-GLOBAL-PI-OVERLAY`, `DES-OPERATOR-GLOBAL-OVERLAY`);
    it is `:ro` and **credential-free by construction** (`import-pi` refuses a literal-key `models.json` and never
    copies `auth.json`; `CONST-TOKEN-SCOPED-PER-JOB`). No credential is ever written to `/outbox` or `/opt/pi-global`
    (same rule as `/workspace`).
  - No TTY (`-it` absent)
  - **The agent dir must be writable by the non-root runtime user.** pi lazily creates
    `~/.pi/agent/` (mode `0700`) and `auth.json` (mode `0600`, contents `{}`) on the **first credential
    operation** — both `withLock` and `withLockAsync` call `ensureParentDir()` + `ensureFileExists()`.
    Bake the guardrails in as root and forget to `chown`, and the job dies EACCES at runtime, inside the
    container, on a path nothing in the Dockerfile hints at. `models.json` is the exception: read-only,
    never created, safe if absent.
    **Inversely, the guardrails, the runner, `node_modules`, and the browser cache are root-owned and NOT
    writable by the runtime user.** The agent runs *as* that user; if it could rewrite
    `/opt/pi-dispatch/HARD_RULES.md` it would own its own safety floor, and `/job:ro` — which exists
    precisely so the agent cannot rewrite its instructions — would be pointless next to a writable `/opt`.
    Only `~/.pi/agent` is agent-writable, because pi must write `auth.json` there. Everything the agent
    merely reads or executes stays root-owned; the browser binaries are `0755` root-owned, which is all a
    non-root user needs to launch Chromium.
    **`COPY --chown` alone does NOT fix this** — it does not apply to parent directories that `COPY`
    auto-creates, so `/home/pi/.pi` and `/home/pi/.pi/agent` are still born `root:root`. The trap
    survives the obvious fix. Create and chown the directory explicitly:
    ```dockerfile
    RUN mkdir -p /home/pi/.pi/agent && chown -R pi:pi /home/pi/.pi
    COPY --chown=pi:pi guardrails/HARD_RULES.md /home/pi/.pi/agent/APPEND_SYSTEM.md
    ```
  - **Chromium's own sandbox is disabled via `PLAYWRIGHT_MCP_SANDBOX=false`** — an env var, **not** a
    `--no-sandbox` argument, and not a `playwright-cli` flag. This is a **deliberate divergence from
    Playwright's docs**, which never mention disabling it: their supported path for non-root Chromium is
    a custom seccomp profile granting `clone`/`setns`/`unshare`, or `--cap-add=SYS_ADMIN`. We give it
    neither, because `--cap-drop=ALL` *is* `CONST-ISOLATION-CONTAINER-PER-JOB`'s enforcement surface.
    Disabling the inner sandbox does not acquire the privilege — it skips the code path that needs it,
    leaving the container as the only boundary, which is what this project already decided the boundary
    is. **Never "fix" a Chromium launch error by adding `SYS_ADMIN` or widening seccomp**: that trades
    the outer boundary for an inner one against adversarial input, inverting the security model. Written
    here because the vendor's own documentation recommends the thing we must not do.
  - **`playwright-cli` is stateful.** `open <url>` starts a session; `screenshot --filename <path>` acts
    on the current page; `snapshot` returns the DOM. There is no one-shot `screenshot <url> <path>` form.
    **Navigation to `file://` is blocked outright** by default (not merely restricted to cwd — an
    earlier version of this spec claimed the latter, and it was wrong). A frontend job navigates its dev
    server over **http**, which is not blocked; that is the real usage and the only one worth testing.
    Do **not** set `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS` to work around the block — the block
    is a good default.
  - **Fonts are required, and their absence is silent.** `bookworm-slim` ships none, so Chromium renders
    tofu boxes and screenshots look plausible while containing no legible text — which would quietly
    gut `REQ-FRONTEND-VISUAL-VERIFY`, the capability the whole image exists for. Install `fontconfig` +
    `fonts-liberation` + `fonts-dejavu-core` and run `fc-cache -f`.
- **Why**: This is the enforcement surface of `CONST-ISOLATION-CONTAINER-PER-JOB` — every flag is
  load-bearing and none is decoration. `--cap-drop=ALL` removes the capabilities pi would otherwise
  inherit from the launching user (pi has no permission system of its own to do this).
  `--pids-limit` bounds a fork bomb. `--memory` bounds an OOM to one job rather than the host.
  `PLAYWRIGHT_BROWSERS_PATH` resolves the collision between non-root execution and root-installed
  Chromium — see `DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS`.
  **Env is an allowlist, never a pass-through**: `ANTHROPIC_OAUTH_TOKEN` silently takes *precedence*
  over `ANTHROPIC_API_KEY`, so a stray variable in the host environment would quietly redirect which
  credential every job spends. Pass exactly these.
  Absence of `-it` is worth knowing rather than relying on: with no TTY, pi enters print mode
  automatically. Pass `-p` explicitly anyway — inferring behaviour from TTY presence is fragile.
- **Open**: `--pids-limit=512` is **UNVERIFIED** — no authoritative figure for headless Chromium exists in
  any vendor documentation. Chromium spawns browser + renderer + GPU + zygote + crashpad per page, plus
  node/pi/git/gh. 512 is a guess wearing a number's clothing, exactly like `OQ-002`'s RAM estimate, and
  it gets measured on the same run rather than trusted. `--init` makes it more survivable by reaping
  zombies that would otherwise accumulate against it.
- **Reference** (no authority): Playwright docs — `--ipc=host` and `--init` recommendations; seccomp /
  `SYS_ADMIN` as the supported non-root sandbox path. Cited to record **what we deliberately do not do**
  and why.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → packages/ai/src/env-api-keys.ts:69-71 → getApiKeyEnvVars`
  — verbatim: `// ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY` /
  `return ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]` (the array order **is** the precedence) ·
  `→ packages/coding-agent/src/config.ts:515 → getAgentDir()` — `process.env[ENV_AGENT_DIR]` else
  `join(homedir(), CONFIG_DIR_NAME, "agent")`: respects `$HOME`, **no hardcoded `/root`** ·
  `→ packages/coding-agent/src/config.ts:495 → ENV_AGENT_DIR = \`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR\``
  (the override var is *derived*, not a literal — it resolves to `PI_CODING_AGENT_DIR`, and would follow a
  rename of `APP_NAME`) · `→ main.ts:99-108` (no TTY → print mode)
- **Traces to**: `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-TOKEN-SCOPED-PER-JOB`,
  `DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS`
- **Acceptance**: Chromium launches as the non-root user; `capsh --print` inside the container shows no
  capabilities.

## INT-WEBHOOK-PAYLOAD-SUBSET

**GitHub → receiver.**

- **Contract**:
  - Events consumed: `issues`, `issue_comment`, `pull_request`. Everything else drops as `unhandled-event`.
  - Headers consumed: `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`
  - Body fields consumed: `action`, `issue.number`, `issue.title`, `issue.body`, `issue.labels[].name`,
    `issue.pull_request` (presence marker only — an `issue_comment` on a PR carries it), `comment.body`,
    `comment.author_association`, `sender.id`, `repository.full_name`, and for a `pull_request` event:
    `pull_request.number`, `pull_request.title`, `pull_request.body`, `pull_request.author_association`,
    `pull_request.labels[].name`, `pull_request.head.ref`, `pull_request.head.sha`,
    `pull_request.head.repo.full_name`, `pull_request.base.ref`
  - `issue.labels[].name` and `pull_request.labels[].name` are consumed as a **set**, evaluated by the
    `{any, all, none}` trigger predicate (`REQ-TRIGGER-AUTHOR-GATE`) — this changes *how* the field is
    used, not which fields are read.
  - **`pull_request.head.*` and `.base.*` are DATA only.** They are attacker-controlled (the head may be a
    fork) and are carried into `/job/event.json` for the flow's own `gh` use; they are **never** used as a
    clone ref. The worker still clones the base repo's default-branch SHA (`INT-CONTAINER-JOB-INPUTS`).
  - **Everything else is ignored.**
- **Why**: Naming the subset **is** the contract. Because everything else is ignored by construction, an
  upstream schema addition cannot change our behaviour — and a reviewer can see the entire attack
  surface as one list, instead of inferring it from destructuring scattered across a handler. Every
  field here is attacker-controlled except the headers and `sender.id`, and the headers are only
  trustworthy *after* `CONST-HMAC-OVER-RAW-BODY` has run. `pull_request.author_association` is
  attacker-*claimed* but GitHub-*computed*, and it gates only auto actions — a stranger cannot forge
  themselves into `COLLABORATOR` because GitHub, not the payload author, sets it.
- **Traces to**: `CONST-HMAC-OVER-RAW-BODY`, `REQ-TRIGGER-AUTHOR-GATE`, `REQ-DEDUP-BY-DELIVERY-GUID`,
  `INT-CONTAINER-JOB-INPUTS`
- **Acceptance**: Given a payload with unknown extra fields, behaviour is unchanged. Given a
  `pull_request` payload, no `head.sha`/`head.ref` value is ever passed to a clone or fetch — the fetch
  pins the base default-branch SHA.

## INT-TRIGGERS-FILE-CONTRACT

**operator → worker + receiver.** One unified file, read by both services; each validates the WHOLE file
and selects the `on.type` it owns (worker: `cron`; receiver: `label`, `comment`, `pull_request`).

- **Contract**:
  ```
  triggers.json  (path via PI_TRIGGERS_FILE; absolute; unset = cron disabled for the worker, but the
                  receiver requires it)
  { "triggers": [
    { "on": { "type": "cron", "id": "<[A-Za-z0-9._-]+, no ':' , unique>",
              "pattern": "<5 or 6 space-separated fields>" },
      "run": { "kind": "local", "folder": "<absolute HOST path, must exist>", "flow": "<flow name>",
               "task": "<operator-authored prompt text — DATA, lands in /job/prompt.md>",
               "provider": "<optional passthrough>", "model": "<optional>", "maxTurns": <optional> } },
    { "on": { "type": "label", "any": [...], "all": [...], "none": [...] },
      "run": { "kind": "github", "flow": "<flow name>" } },
    { "on": { "type": "comment", "phrase": "<trigger phrase>" },       // at most one
      "run": { "kind": "github", "flow": "<default flow>" } },
    { "on": { "type": "pull_request", "action": ["labeled"|"opened"|"synchronize"|"reopened", ...],
              "any": [...], "all": [...], "none": [...] },
      "run": { "kind": "github", "flow": "<flow name>" } } ] }
  ```
- **The on × run diagonal is the trust boundary, enforced fail-loud at load**: `cron ⟹ run.kind:"local"`;
  every webhook type (`label`, `comment`, `pull_request`) `⟹ run.kind:"github"`. Off-diagonal throws a
  `piDispatchConfig` error — a `cron` trigger has no webhook delivery, issue/PR number, title, or body to
  supply a github run, and a webhook trigger is adversarial input that always produces a github job.
- **Why**: The operator's trigger set is one host file — diffable, reviewable, git-trackable — rather than
  two files in two shapes across two services. The schema unifies the *view*; evaluation still splits by
  owner (a `label` is never scheduled; a `cron` never receives a webhook). `on.id` (cron only) must be
  `:`-free because the stall guard parses BullMQ's `repeat:<id>:<millis>` job id by splitting on `:`.
  `run.task` is operator-authored natural language and therefore **DATA** (`CONST-ISSUE-TEXT-IS-DATA`): it
  lands in `/job/prompt.md`, never in a system prompt. `provider`/`model`/`maxTurns` are **pure
  passthrough**: omitted → absent from the emitted job data, resolved at job start via the overlay then env
  (`INT-CONFIG-OVERLAY-CONTRACT`). A `labeled` PR rule (like a `label` rule) requires a positive selector;
  at most one `comment` trigger may be configured.
- **Traces to**: `DES-TRIGGERS-UNIFIED-FILE`, `DES-CRON-VIA-BULLMQ-SCHEDULER`, `REQ-TRIGGER-AUTHOR-GATE`,
  `CONST-ISSUE-TEXT-IS-DATA`, `INT-CONFIG-OVERLAY-CONTRACT`
- **Acceptance**: Given an off-diagonal entry (`cron`→`github`, or any webhook type→`local`), a duplicate
  cron `id`, a `:` in a cron `id`, a cron `run.folder` that does not exist, a `labeled` PR/label rule with
  no positive selector, or a second `comment` trigger, when the config loads, then load throws a
  `piDispatchConfig`-tagged error in both services. Given a valid `cron` entry, when it fires, then the
  emitted job's `data` byte-matches the interactive local (`enqueueLocalJob`) shape.

## INT-RUN-HISTORY-FILE-CONTRACT

**worker → admin extension.**

- **Contract**:
  ```
  <logsDir>/<sanitizedJobId>.log      append-only container stdout+stderr; untrusted, PII-bearing; written ONLY when PI_CAPTURE_JOB_LOGS=1
  <logsDir>/<sanitizedJobId>.json     one JSON object, PII-free, overwritten on each terminal state (last-write-wins across retries)
  (logsDir via PI_LOGS_DIR; empty/unset = <OS temp>/pi-dispatch/logs)
  { "jobId":   "<raw job id: delivery GUID | local-<hex> | repeat:<sched>:<millis>>",
    "kind":    "github" | "local" | null,
    "target":  "<repo>#<issue>"  |  "local:<basename>" | null,
    "flow":    "<flow name>" | null,
    "startedAt": "<ISO-8601>", "endedAt": "<ISO-8601>",
    "outcome":   "completed" | "policy" | "failed",
    "reason":    "<fixed enum: worker-abort|over-budget|unprotected-branch|runner-policy|container-never-started|settings-overlay-invalid|...>" | null,
    "exitCode":  <int> | null,
    "turns":     <int> | null,
    "tokens":    { "input": <int>, "output": <int>, "total": <int>, "cost": <number> } | null,  // per-job usage totals; null when the container died before the exit line
    "budgetReserved": <bool> | null,
    "attempt":   <int>,
    "parentJobId": "<job id: same id-space as jobId>" | null,
    "chainDepth":  <int> | null,
    "chainRefused": <int> | null }   // count of chain requests refused on this parent; 0 = none
  ```
  Field order is the serialisation order (`JSON.stringify` emits insertion order). The filename uses the
  **sanitized** id (`:` → `_`, because `repeat:<sched>:<millis>` is NTFS-illegal); the record **body**
  keeps the raw `jobId`. `reason` is a fixed enum passed through from the terminal outcome — never
  free-form and never payload text — and `turns` is `null` when the container died before emitting the
  runner `exit` line.
- **Why**: The admin extension is a separate process (`DES-ADMIN-VIA-PI-EXTENSION`) that reads this as a
  read-model it does not share memory with — the worker writes the files, the admin extension reads them, and
  nothing crosses in RAM. The worker writes on both terminal paths: `worker/src/index.mjs` `makeProcessor`
  calls `recordRun` on the success (`result`) and the failure (`error`) branch alike, and
  `worker/src/run-history.mjs` `makeRecordWriter` serialises the record with a truncating
  `fs.writeFileSync`, so a re-run of the same id overwrites — last-write-wins across retries. The `.json`
  is PII-free **by construction**: `buildRecord` (`worker/src/run-history.mjs`) is an explicit object
  literal over stable id-only fields and never spreads `job.data`, `result`, or `error`, so a GitHub
  job's title/body and a local job's `task` or full folder path cannot leak — `target` keeps only
  `repo#issue` or the folder `basename` (`no-pii-in-logs`, `REQ-LOCAL-JOB-VISIBILITY`). The `.log` is a
  **separate file** from the `.json` precisely so the untrusted, PII-bearing container stream — teed off
  each stdout/stderr chunk by the sink in `worker/src/run-container.mjs` — never contaminates the
  structured record; it is opt-in, host-side (never mounted into the container), and written only under
  `PI_CAPTURE_JOB_LOGS=1`. This is a **flat per-job file, not a database**: one `.json` (plus the optional
  `.log`) keyed by the sanitized job id, no schema and no query surface — upholding this file's standing
  invariant that **there is deliberately no database**. The chain fields — `parentJobId`, `chainDepth`,
  `chainRefused` — are **additive and nullable**, set as explicit literals by the same no-spread
  `buildRecord` (a chained job carries its parent id and host-computed depth; `chainRefused` records how many
  of a parent's own `/outbox` requests were refused). `chainRefused` is an **`<int>` count, not a boolean** —
  the collector returns a running `refused` count, and the record stores it verbatim (`0` = none), so the runs
  view can surface "2 refused" rather than a bare yes/no. The `reason` enum is **untouched**: a chain refusal is
  **pre-enqueue of the child**, so there is no child record and no new terminal reason — `chainRefused` is
  a separate count on the **parent**, never an enum value. The `tokens` field is **additive and nullable**
  in exactly the same way — an explicit no-spread literal `{ input, output, total, cost }` of the runner's
  per-job usage totals (`REQ-TOKEN-ACCOUNTING-AND-CAPS`), or `null` when the container died before emitting
  the runner `exit` line. It is PII-free by construction: integer token counts and a numeric cost only, no
  payload text. It is read-only telemetry recovered from the exit line (`parseExitTokens`) exactly as
  `turns` is, and like `turns` it never feeds exit-code or retry classification (`INT-RUNNER-EXIT-CODE-PROTOCOL`).
- **Traces to**: `REQ-DURABLE-RUN-HISTORY`, `REQ-LOCAL-JOB-VISIBILITY`, `INT-RUNNER-EXIT-CODE-PROTOCOL`, `REQ-TOKEN-ACCOUNTING-AND-CAPS`
- **Acceptance**: Given a job reaching a terminal state, exactly one `.json` keyed by its sanitized job
  id exists; its `outcome` matches the queue outcome (`completed` / `policy` / `failed`); no field carries
  issue or comment body text (`target` is `repo#issue` / `local:<basename>` only); `turns` is `null` when
  the container died before emitting the runner `exit` line; the `.log` exists only when
  `PI_CAPTURE_JOB_LOGS` is set.

## INT-OUTBOX-CONTRACT

**container (agent) → worker.**

- **Contract**: A **local** job mounts a read-write `/outbox` (a **github** job does not). The agent
  requests follow-up flows by writing `request-<n>.json`, `n = 1..PI_CHAIN_MAX_PER_JOB`:
  ```
  /outbox/request-<n>.json    n = 1..PI_CHAIN_MAX_PER_JOB; each file <= 4 KiB
  { "flow": "<skill-charset flow name>",   // required
    "task": "<freeform text>" }            // optional -- DATA, lands in the child's prompt.md
  ```
  The `folder` field is **ignored** — the child folder is forced to the parent's own folder, so this slice
  is **same-folder-only**; unknown keys are ignored. `task` is agent-authored **DATA**
  (`CONST-ISSUE-TEXT-IS-DATA`, one layer down): it becomes the child's `/job/prompt.md` user prompt and
  **never** enters the run-history `.json` record.
- **Validation order** (host-side, fail-closed at the first miss): count cap (`PI_CHAIN_MAX_PER_JOB`) →
  per-file size cap (4 KiB) → regular-file-only (a symlink, directory, or device is rejected) → JSON
  parse → flow-name charset (the skill charset) → depth cap (host-computed `parent.chainDepth + 1` against
  `PI_CHAIN_DEPTH_MAX`, **never** read from the outbox) → `ai-trigger` gate at the **parent's pre-agent
  SHA** (`DES-AI-TRIGGER-FLOW-GATE`) → enqueue.
- **Retry-idempotent child id**: `parent id + content-hash(flow, task)`, so a retried parent re-enqueues
  **identical** ids that BullMQ dedups — a retry cannot fan out duplicate follow-ups.
- **Completed-only collection**: `/outbox` is read **only** after a completed container exit; a policy or
  infra-thrown parent spawns nothing. A **github** parent has **no `/outbox` mount at all** — the request
  channel does not exist for it, so an untrusted issue author cannot chain.
- **Ro shadow**: the agent can re-read its own requests via the `/job:ro` tree (`/job/outbox/…`) —
  harmless, since the file is agent-authored and the worker trusts nothing in it.
- **Why**: The `/outbox` file is the container's only signal channel back to the host and is **untrusted**;
  every field is allowlist-validated host-side before an enqueue, the child folder is forced, and depth is
  host-computed, so a queue-blind container can neither forge a shallow chain to evade the cap nor escape
  same-folder scope. Keeping `task` out of the `.json` preserves the record's PII-free-by-construction
  guarantee (`INT-RUN-HISTORY-FILE-CONTRACT`), and enqueued children pass `reserveBudget` consumer-side
  like any local job (`CONST-BUDGET-BEFORE-TOKENS`).
- **Traces to**: `DES-JOB-OUTBOX-CHAINING`, `DES-AI-TRIGGER-FLOW-GATE`, `CONST-ISSUE-TEXT-IS-DATA`,
  `CONST-BUDGET-BEFORE-TOKENS`, `INT-RUN-HISTORY-FILE-CONTRACT`
- **Acceptance**: Given a completed local parent with a valid `request-1.json`, when the worker collects
  `/outbox`, then exactly one child is enqueued on the parent's own folder with `chainDepth = parent + 1`;
  given a request over the count or depth cap, or whose flow fails the `ai-trigger` gate, when collected,
  then it is refused and no child is enqueued; given a **github** parent, when it exits, then no `/outbox`
  exists to collect; given a symlink or an oversize `request-<n>.json`, when validated, then it is
  rejected; given a **retried** parent, when its outbox is re-collected, then the idempotent child id
  dedups and no second child is enqueued.

## INT-CONFIG-OVERLAY-CONTRACT

**admin extension → worker.**

- **Contract**:
  ```
  settings.json  (PI_SETTINGS_FILE; absolute; unset -> <OS temp>/pi-dispatch/settings.json — same defaulting convention as PI_LOGS_DIR)
  {
    "model":       "<optional, non-empty string>",   // provider-native model id
    "provider":    "<optional, non-empty string>",   // pi provider id
    "maxTurns":    <optional, int >= 1>,             // runner turn budget
    "dailyCap":    <optional, int >= 1>,             // jobs admitted per day (mandatory window; env default 25)
    "weeklyCap":   <optional, int >= 1>,             // jobs admitted per ISO week; unset -> weekly window disabled
    "monthlyCap":  <optional, int >= 1>,             // jobs admitted per calendar month; unset -> monthly window disabled
    "maxTokens":     <optional, int >= 1>,           // per-job token budget (in-run abort); unset -> per-job token budget disabled
    "dailyTokenCap": <optional, int >= 1>,           // daily token cap (check-AFTER; refuses next job); unset -> daily token counter disabled
    "concurrency": <optional, int 1-10>,             // worker slot count
    "softHoldPct": <optional, int 1-99>              // soft-hold band as a % of each active cap; unset -> band disabled
  }
  ```
  All keys are optional; a missing file is an empty overlay. **Write protocol** (admin extension): validate
  the candidate object, serialise it, write a same-directory `settings.json.tmp`, then `rename` it over
  `settings.json` — an atomic replace, with one EPERM retry on Windows. When the existing file is invalid,
  a write rebuilds it from scratch with the sanitized candidate and surfaces a loud, key-only notice that
  it replaced an invalid file — the write path is the documented repair for a broken overlay, so the
  fail-closed guarantee lives only on the worker's job-start read, which is unchanged. **Read protocol** (worker): read at
  **each job start**; a missing file is an empty overlay and is normal; an unknown key is ignored and
  logged, leaving the file valid; an invalid known key (wrong type or out of bounds) or unparseable JSON
  makes the **whole file** invalid.
- **Why**: The worker resolves the effective job settings at job start — precedence
  `job.data > overlay > env > default` — so this file is the shared, durable truth between the admin
  extension and the worker: a write made while the worker is down is simply read at the next job start.
  `dailyCap`/`weeklyCap`/`monthlyCap`/`softHoldPct` are resolved at the existing pre-container cap check, so
  the overlay changes *which values* the caps and band take, never *when* they are checked
  (`CONST-BUDGET-BEFORE-TOKENS`, `REQ-SPEND-CAPS-MULTI-WINDOW`). An unset `weeklyCap`/`monthlyCap` disables
  that window; an unset `softHoldPct` disables the band. The two token knobs (`REQ-TOKEN-ACCOUNTING-AND-CAPS`)
  resolve the same way but differ in *where* they act: `maxTokens` is forwarded into the container
  (`PI_MAX_TOKENS`, `INT-CONTAINER-RUNTIME-CONTRACT`) and enforced in-run by the runner; `dailyTokenCap` is
  worker-only and, unlike the job-count caps, is enforced **check-AFTER** — a read of prior recorded spend
  before the container plus an `INCRBY` of the job's tokens after it — because token cost is knowable only
  post-run. This is the one overlay knob whose enforcement is not at the same pre-container check point as
  the rest; `CONST-BUDGET-BEFORE-TOKENS` (job count, check-before) is unchanged. See
  `DES-RUNTIME-SETTINGS-FILE-OVERLAY` for why a file, why atomic, and why a present-but-invalid file fails closed.
- **Traces to**: `DES-RUNTIME-SETTINGS-FILE-OVERLAY`, `DES-ADMIN-VIA-PI-EXTENSION`,
  `CONST-BUDGET-BEFORE-TOKENS`, `CONST-RETRY-INFRA-ONLY`, `REQ-SPEND-CAPS-MULTI-WINDOW`, `REQ-TOKEN-ACCOUNTING-AND-CAPS`
- **Acceptance**: Given a present-but-invalid file, when a job starts, then the processor returns a policy
  refusal `settings-overlay-invalid` before `reserveBudget` — no budget slot consumed, no container
  started, not retried; given a job whose data omits `model`/`provider`/`maxTurns`, when it starts, then
  the value falls to the overlay, then env, then default — not a value frozen at enqueue; given `dailyCap`
  lowered below today's reserved count, when the next job starts, then it is refused over-budget before any
  container; given a concurrent write, when the worker reads, then it never observes a partial file (atomic
  rename); given an unknown key, when read, then it is ignored and logged, and the file remains valid.

---

## INT-PAUSE-WINDOWS-FILE-CONTRACT

- **Producer/Consumer**: The admin extension (operator dialogs + confirm-gated tools) writes; the worker
  reads and enforces (`REQ-SCOPED-PAUSE-WINDOWS`, `DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED`). The receiver does
  not read it.
- **Location**: `PI_PAUSE_WINDOWS_FILE` (unset = feature off; the worker loads `[]`).
- **Shape**: `{ "windows": [ { scope, from, to, tz?, days?, dateFrom?, dateTo? } ] }`.
  - `scope` (required): a github `"owner/name"`, a local folder path, or `"*"` (all). Matched against a job's
    `repo`/`folder` by `kind`, exact.
  - `from` / `to` (required): `"HH:MM"` 24h. `from > to` is an overnight window. `from == to` is **rejected**
    (a 24h pause is not expressible).
  - `tz` (optional, default `"UTC"`): IANA zone, validated by constructing an `Intl.DateTimeFormat`.
  - `days` (optional, default all): weekday allow-list (`mon`..`sun`) gating the occurrence's **start** day.
  - `dateFrom` / `dateTo` (optional, default unbounded): inclusive `"YYYY-MM-DD"` bound on the start date.
- **Validation**: the SHARED `parsePauseWindows` (worker `./pause-windows`) validates the WHOLE file fail-loud
  (`configError`); the admin writes through it (fail-closed — a rejected file is never written) and the worker
  boot-loads through it. Neither side re-derives the schema, so they cannot drift (mirrors
  `INT-TRIGGERS-FILE-CONTRACT`).
- **Write protocol**: atomic tmp + rename (`writePauseWindows`); the worker's directory watch hot-swaps the
  in-memory windows on change and **keeps the last-good set on a bad edit** (no restart).
- **Enforcement**: at pickup, before `reserveBudget`, a scope-matching active window defers the job with
  `job.moveToDelayed(windowEndMs, token)` + `DelayedError`; it consumes no budget and auto-resumes at the end.
- **Acceptance**: Given a well-formed file with a window covering now for a job's scope, the job is delayed to
  the window end and reserves nothing; given `from == to` or a bad tz/day/date, the write is rejected and the
  file is unchanged; given a mid-run malformed edit, the worker keeps the last-good windows and logs
  `pause_windows_reload_invalid`.

---

## Revision History

| Date | Change |
|---|---|
| 2026-07-22 | Unified triggers (issue #20 + `pull_request` triggers): replaced INT-SCHEDULES-FILE-CONTRACT with **INT-TRIGGERS-FILE-CONTRACT** — one `triggers.json` of `{ on, run }` entries via `PI_TRIGGERS_FILE`, read by both worker (`on.type:cron`) and receiver (`label`/`comment`/`pull_request`), with the `on × run` diagonal enforced fail-loud at load. Expanded INT-WEBHOOK-PAYLOAD-SUBSET to consume the `pull_request` event and its fields (`number`/`title`/`body`/`author_association`/`labels[].name`/`head.{ref,sha,repo.full_name}`/`base.ref`) plus `issue.pull_request` as a presence marker — `head`/`base` are attacker-controlled DATA, never a clone ref. Amended INT-CONTAINER-JOB-INPUTS: `/job/event.json` now carries an `issue` OR a `pull_request` body per the job-data `target` discriminator. See `DES-TRIGGERS-UNIFIED-FILE`, `DES-PR-TRIGGER-ROUTES-TO-FLOW`. |
| 2026-07-22 | Corrected INT-CONTAINER-RUNTIME-CONTRACT's mount-mechanism sentence: the `/job:ro`, `/workspace:rw`, and local-only `/outbox:rw` mounts are host bind mounts (`-v host:container`), not the superseded named-volume + `volume-subpath` mechanism. Aligns the INT with `DES-WORKER-ON-HOST` and the shipped `worker/src/docker-run.mjs`. Also corrected INT-RUN-HISTORY-FILE-CONTRACT's `chainRefused` annotation from `<bool>` to `<int>` (a count of refused `/outbox` requests on the parent; `0` = none), matching the shipped `buildRecord`, which stores the collector's running `refused` count verbatim. |
| 2026-07-21 | Extended INT-CONFIG-OVERLAY-CONTRACT's write protocol: an invalid existing file is repaired by the next write, which rebuilds from scratch with the sanitized candidate and surfaces a loud key-only notice — the fail-closed guarantee is stated to live only on the worker's job-start read. |
| 2026-07-22 | Added INT-OUTBOX-CONTRACT (container→worker `/outbox` request files: `request-<n>.json` byte-capped at 4 KiB, `folder`-ignored same-folder-only, validation order count→size→regular-file→parse→charset→host-computed depth→`ai-trigger` gate→enqueue, retry-idempotent child ids, completed-only collection, no mount for github parents, `task` as DATA never in the run record). Extended INT-CONTAINER-JOB-INPUTS and INT-CONTAINER-RUNTIME-CONTRACT with the writable `/outbox` mount (local jobs only; absent for github). Appended `parentJobId`/`chainDepth`/`chainRefused` (additive, nullable, no-spread) to INT-RUN-HISTORY-FILE-CONTRACT's record — the `reason` enum untouched, since a chain refusal is pre-enqueue of the child. |
| 2026-07-21 | Added INT-CONFIG-OVERLAY-CONTRACT (admin extension → worker `settings.json` overlay: optional keys with bounds, atomic tmp+rename write, per-job-start read, fail-closed `settings-overlay-invalid` on a present-but-invalid file). Reworded INT-RUN-HISTORY-FILE-CONTRACT's boundary from worker→panel to worker→admin extension (repointing the read-model rationale to `DES-ADMIN-VIA-PI-EXTENSION`) and added `settings-overlay-invalid` to its `reason` enum. Clarified in INT-SCHEDULES-FILE-CONTRACT that `provider`/`model`/`maxTurns` are pure passthrough — absent from an entry means absent from job data, resolved against the overlay/env at job start. De-numeralized the intro (contract count no longer stated). |
| 2026-07-22 | Token accounting (issue #25 / `REQ-TOKEN-ACCOUNTING-AND-CAPS`): INT-RUN-HISTORY-FILE-CONTRACT record gains an additive, nullable `tokens` `{ input, output, total, cost }` field (recovered from the exit line by `parseExitTokens`, read-only telemetry like `turns`); INT-RUNNER-EXIT-CODE-PROTOCOL gains the `token_budget` policy-`2` row and documents `tokens` on the exit line; INT-CONFIG-OVERLAY-CONTRACT gains the `maxTokens`/`dailyTokenCap` overlay keys and records that the daily token cap is the one knob enforced check-AFTER; INT-CONTAINER-RUNTIME-CONTRACT gains `PI_MAX_TOKENS` (forwarded only when set) and records that `PI_DAILY_TOKEN_CAP` is worker-only and never forwarded. |
| 2026-07-21 | Added INT-RUN-HISTORY-FILE-CONTRACT (worker→panel run-history read-model files). |
| 2026-07-17 | Added INT-SCHEDULES-FILE-CONTRACT, documenting the implemented `schedules.json` host-file shape (`PI_SCHEDULES_FILE`): `local`-only, `:`-free unique `id`, `task` as DATA, and load-time rejection of malformed/`github`/duplicate/missing-folder entries. |
| 2026-07-15 | Initial. Extracted from `DESIGN.md` v0.1 §5.1, §5.3, §5.4, §5.5. `INT-SDK-SESSION-OPTIONS` is **new** — the source doc left the SDK option set unverified (its §10) and was wrong about the print-mode flag shape and the mode union. `PLAYWRIGHT_BROWSERS_PATH` added to the runtime contract: the source doc's Dockerfile was broken as written for non-root execution. The source doc's code sketches are deliberately **not** carried over — the real Dockerfile and handler are the truth, and a spec that mirrors them drifts on the first commit. |
| 2026-07-16 | **Correction — "pi never throws" was FALSE**, and it was in this file for a day as the justification for forbidding `try`/`catch` outright. Adversarial re-verification refuted it: `agent-session.ts:1242-1244` is `catch (error) { preflightResult?.(false); throw error; }`, and pi's **own JSDoc** (`:1099-1100`) documents throws on no-model, no-API-key, and missing `streamingBehavior`; `agent.ts:470-471` throws `"Agent is already processing."` outside the lifecycle try entirely. The rule as written would have produced a runner that dies of an unhandled rejection on a missing API key, exiting Node's default `1` = *retryable*, so the queue pays to retry a job that can never succeed. **Both mechanisms are required and cover disjoint sets: preflight throws, the loop swallows.** Also corrected: `StopReason` has **five** values (`packages/ai/src/types.ts:380`) — the entry handled three, and a default branch silently maps `"length"` (truncated output) to success. `reload()` has **no early return** — a second call fully re-runs everything; the earlier "the `loaded` guard makes a double call safe" framing was wrong. The lesson is the file's own: this entry was written from source and still asserted an absolute from a partial read. `INT-CONTAINER-RUNTIME-CONTRACT` gained `--init`, `--shm-size` (explicitly **not** `--ipc=host`, which Playwright recommends but which would share the host IPC namespace with an adversarial container), fonts (absent ⇒ tofu-box screenshots that silently gut `REQ-FRONTEND-VISUAL-VERIFY`), and the fact that **`COPY --chown` does not fix the EACCES trap** because it skips auto-created parent dirs. |
| 2026-07-15 | `INT-RUNNER-EXIT-CODE-PROTOCOL` gained its **mechanism**, which was the missing half. The codes were right; nothing said how to produce them, and **the obvious implementation produces them wrong**. ~~`pi never throws`~~ (**refuted the next day — see above**): `agent.ts:485-491` catches and `handleRunFailure` does not rethrow, so abort / 429 / 5xx / dead network all resolve `await session.prompt()` normally — and `prompt()` returns `Promise<void>`, so there is no return value either. A `try`/`catch` runner exits `0` on every infrastructure failure: queue records success, never retries, job did nothing — verbatim the worst failure class this project names. The exit code must be derived from `stopReason` on the terminal message, captured via `subscribe()`. Also recorded: the `subscribe()` listener is **sync and unawaited**, so a budget check that awaits will overshoot. `INT-CONTAINER-RUNTIME-CONTRACT` gained two runtime facts that fail *inside the container* where no Dockerfile hints at them: the agent dir must be **writable** by the non-root user (pi lazily writes `auth.json` on first credential touch), and Chromium needs **`--no-sandbox`** because `--cap-drop=ALL` denies it the seccomp/`SYS_ADMIN` its own sandbox requires — the container is the sandbox, and re-granting caps to Chromium would invert the security model. Two cited paths were **dead** (`packages/ai/src/api/env-api-keys.ts`, `packages/coding-agent/src/core/config.ts`); claims and line numbers were correct, only the addresses were wrong — the sneakiest defect class, since it reads as verified and cannot be followed. All cited paths now resolve. Good news recorded too: `before_agent_start` fires strictly before any provider HTTP call, so the assembled-prompt assertion costs **zero tokens**. |
| 2026-07-15 | `INT-SDK-SESSION-OPTIONS` **materially corrected** before any code was written against it. The contract block was **not callable as published**: it passed `appendSystemPromptOverride` as a `createAgentSession` option (it is a `DefaultResourceLoader` option) and called `getModel` as a free function (it is a `ModelRuntime` method, and is not exported). Two further traps were found by reading source and are now recorded: `noContextFiles` is **off by default**, so `CONST-NO-CONTEXT-FILES-MANDATORY` fails **open by omission**; and `createAgentSession` **does not `reload()` a loader you pass it**, so the persona is silently empty — a second, previously-unrecorded path to this project's most-feared failure, created by the *interaction* of two constitutional constraints. The irony is the point: this block's own `Why` called it *"the only contract here that fails invisibly"*, and it was itself wrong in three ways for a month. This is the third time a doc-verified pi claim has been refuted by source — exactly what the evidence convention in `constitution.md` predicts. |
