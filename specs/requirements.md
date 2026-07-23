# Requirements

What pi-dispatch must do. Design decisions live in `design.md`; non-negotiable constraints live in
`constitution.md`. This file is the acceptance surface.

Evidence convention as in `constitution.md`: `Evidence (upstream)` is authoritative, `Reference` is not.

## Scope

Run pi as a self-hosted harness that executes each job in an isolated container, follows a predefined
flow, supports frontend work with visual verification, and survives burst load without dropping work.

A job is a **trigger × target** (see `DES-CRON-VIA-BULLMQ-SCHEDULER`):

- **Targets**: a **local folder** on the operator's machine (edited in place — the primary self-hosted
  use, needs only a provider key), or a **GitHub repo** (cloned, worked, opened as a PR — needs a GitHub
  App).
- **Triggers**: the **CLI** (operator-initiated, `DES-CLI-TRIGGER-FOR-LOCAL`; the admin extension operates
  the queue and triggers no jobs except the gated `dispatch_run` enqueue), a **webhook** (GitHub issue
  activity), or **cron** (a schedule).

Everything below the trigger is identical: budget check → `/job:ro` inputs → one container → the runner
→ an exit code. What differs is authz (a label/collaborator gate for webhooks vs CLI access for
local), the credential (a short-lived scoped token for GitHub jobs vs none for local), and the completion signal
(an issue comment vs the console, or the admin extension's runs view — see `REQ-JOB-STATUS-COMMENTS` and `REQ-LOCAL-JOB-VISIBILITY`).

**Out of scope**: being a hosted service; multi-tenancy; merging anything.

---

## REQ-QUEUE-BURST-NO-DROP

- **Statement**: 50 deliveries arriving within 60 seconds shall produce 50 durably queued jobs. None
  dropped, none coalesced except by an explicit dedup key. All shall eventually execute.
- **Why**: This is the single differentiator and the reason the project exists. pi has no cross-session
  queue at all; the closest existing tool drops fires past a queue depth of 3 and does not coordinate
  across processes. 50 is the observed shape of label-spam and bulk-triage bursts, not an architectural
  bound — the real bound is Redis memory. Relax this and the harness is a toy that loses work silently,
  which is worse than not existing, because the requester believes it ran.
- **Evidence (upstream)**: `Davidcreador/pi-routines @ 6d2aa64 → src/types.ts:423 → MAX_QUEUE_DEPTH = 3`
  · `→ src/guard.ts → isRoutineTurnActive` (single-flight)
- **Traces to**: `DES-QUEUE-BULLMQ-OVER-CUSTOM`, `REQ-DEDUP-BY-DELIVERY-GUID`
- **Acceptance**: Given concurrency 3 and 50 distinct deliveries within 60s, queue depth reaches 50, all
  50 execute, zero are lost, and process memory stays flat.

## REQ-RUNNER-TURN-BUDGET

- **Statement**: The runner shall count agent turns and call `session.abort()` on exceeding a configured
  maximum. The maximum is a config knob with a conservative default.
- **Why**: **pi has no max-turns, step-limit, or iteration cap of any kind.** The agent loop is a bare
  `while (true)` bounded only by an `AbortSignal`; the only control surface is `session.abort()`. The
  design document assumed pi provided this and listed it as "verify" — it does not, so we build it.
  Critically, `REQ-JOB-TIMEOUT-30M` does **not** substitute: that bounds *wall-clock*, and an agent can
  burn 200 turns of tokens in 29 minutes and exit "successfully" while blowing the money budget
  entirely. Time and spend are different axes and each needs its own bound.
  *Negative fact — this requirement exists because of an upstream absence.* If pi ships max-turns, this
  becomes deletable; the absence is named here so a future maintainer knows it is safe to delete rather
  than leaving it as unexplained ballast.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf` — repo-wide search of `packages/*/src` for
  `maxTurns|max_turns|maxSteps|max_steps|maxIterations|stepLimit|turnLimit` returns **zero hits** ·
  `→ packages/agent/src/agent-loop.ts:170 → while (true)` — an outer `while (true)` wrapping an inner
  `while (hasMoreToolCalls || pendingMessages.length > 0)`; both unbounded except by the `AbortSignal` ·
  `→ core/agent-session.ts:1530 → abort()` (the only control surface) ·
  `→ packages/agent/src/types.ts:420 → | { type: "turn_start" }` — **the event carries no turn index**,
  so the runner must keep its own counter. Note `agent-session.ts:706-712` builds a *different*
  `TurnStartEvent` **with** `turnIndex` — but that is emitted only to the **extension** runner, whereas
  `subscribe()` receives the bare `AgentEvent` (`agent-session.ts:136` —
  `AgentSessionEvent = Exclude<AgentEvent, {type:"agent_end"}> | …`). Counting `turn_start` off
  `subscribe()` is correct; expecting `turnIndex` there is not ·
  `→ agent-loop.ts:176` (first turn's `turn_start` is emitted before the loop, subsequent ones inside —
  so the count is the true turn count)
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `REQ-JOB-TIMEOUT-30M`, `REQ-UPSTREAM-CONTRACT-TESTS`
- **Acceptance**: Given a flow that would exceed the turn maximum, the runner aborts at the threshold and
  exits with the policy code, not the infra code.
- **Open**: the default N is underived. It should come from `OQ-002`'s measurement plus a target
  cost-per-job. Until then it is a conservative knob, not an evidenced threshold.

## REQ-UPSTREAM-CONTRACT-TESTS

- **Statement**: The image build shall assert every pinned assumption about pi, and fail the build when
  one no longer holds. No image publishes on a failed assertion.
- **Why**: pi ships breaking changes between minors, and its HEAD moved within 24 hours of this
  project's design being written. `CONST-PI-VERSION-PINNED` makes an upgrade an explicit commit, so CI
  fires on it and these tests are the gate. A prose checklist depends on a maintainer reading it at 11pm
  during an upgrade; a failing build does not. **The assumptions worth asserting are exactly the ones
  that fail silently** — a crash is self-reporting and needs no test. Each assertion below maps to a
  point where the design document was wrong and nothing would have told us:
  - the baked `APPEND_SYSTEM.md` **and** a per-flow append both appear in the assembled prompt
    (the `??` trap drops the persona with no error, as does a forgotten `reload()`);
  - a hostile `AGENTS.md` fixture's sentinel appears **nowhere** in the assembled prompt (`-nc` holds —
    and note it is off by default, so this asserts against an *omission*);
  - Chromium launches as the non-root runtime user (the `PLAYWRIGHT_BROWSERS_PATH` collision);
  - `pi -p` exits 0 (catches a flag rename);
  - the runner's turn budget fires at N **and exits 2** — not 0;
  - **a simulated provider error exits 1 — not 0.** Inside the agent loop pi does **not** throw: an
    abort, a 429, a 5xx and a dead network all resolve `prompt()` normally, so a `try`/`catch`-only
    runner reports success for every infra failure. This assertion is the only thing standing between us
    and a queue that cheerfully records success for jobs that did nothing.
  - **a missing API key exits 2 — not 1, and does not crash.** Preflight **does** throw (pi's own JSDoc
    says so), so a `stopReason`-only runner dies of an unhandled rejection and exits Node's default `1`
    — which this protocol defines as *retryable*, making the queue pay to retry a job that can never
    succeed. The two assertions above are deliberately a **pair**: each catches the failure the other's
    implementation causes. See `INT-RUNNER-EXIT-CODE-PROTOCOL`.
  - **`stopReason: "length"` exits 0 and is logged** — all five stop reasons are enumerated. A
    default-to-0 branch maps a truncated run to silent success.

  **Cost note — these are nearly all free.** The loader-boundary assertions are pure. The assembled-prompt
  assertions run through an inline extension on `before_agent_start`, which fires strictly before any
  provider HTTP call. No API key, no tokens, no flake. There is no excuse for not running them on every
  build.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → CHANGELOG.md:5-10` (`[Unreleased]` breaking
  change in flight)
- **Traces to**: `CONST-PI-VERSION-PINNED`, `CONST-NO-CONTEXT-FILES-MANDATORY`, `INT-SDK-SESSION-OPTIONS`,
  `OQ-005`
- **Acceptance**: Given a version bump where a pinned assumption breaks, the build fails and publishes
  nothing.

## REQ-DEDUP-BY-DELIVERY-GUID

- **Statement**: `jobId` shall be the `X-GitHub-Delivery` GUID, giving exactly-once semantics per
  delivery **for as long as the job key is retained**. `removeOnComplete` / `removeOnFail` retention
  shall therefore be set to meet or exceed GitHub's redelivery window.
- **Why**: GitHub redelivers on timeout. A redelivered job is a second paid agent run **and** a second
  pull request on one issue — visible, embarrassing, and billed. The GUID rather than `repo#issue`
  because it is exactly-per-delivery and GitHub-generated, so no coordination is needed and the queue
  can reject the duplicate without a lookup. Semantic dedup on `repo#issue:flow` is a separate, additive
  window for coalescing label-spam, not a replacement.
  **The guarantee is retention-bounded, not absolute** — this qualifier is load-bearing and was missing.
  BullMQ's dedup is literally `if rcall("EXISTS", jobIdKey) == 1 then return handleDuplicatedJob(...)`:
  it is a key-existence test and nothing more. Once `removeOnComplete` deletes the job hash, the same
  GUID is added **fresh**, with no memory that it ever ran. The source design document paired a 7-day
  `removeOnComplete` with a claim of exactly-once; GitHub retains deliveries for roughly 30 days and
  permits manual redelivery throughout, so days 8–30 were an unguarded gap. Retention is not
  housekeeping here — **it *is* the dedup window**, and shortening it silently shortens the guarantee.
- **Evidence (upstream)**: `taskforcesh/bullmq @ v5.80.4 → src/commands/addStandardJob-9.lua:88-93`
  (`EXISTS jobIdKey` → `handleDuplicatedJob`; a duplicate add is a silent no-op, not a throw)
- **Traces to**: `REQ-QUEUE-BURST-NO-DROP`, `CONST-RETRY-INFRA-ONLY`
- **Acceptance**: Given the same delivery GUID twice **within the retention window**, the second add is
  ignored and exactly one job runs. Given a redelivery after retention has expired, a new job runs — this
  is accepted and documented, not a defect, but it must be a *chosen* window rather than an inherited
  default.

## REQ-TRIGGER-AUTHOR-GATE

- **Statement**: The receiver shall enqueue only for: allowlisted issue labels; comments whose
  `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` matching the trigger phrase; and `pull_request`
  events whose approval gate is satisfied. Events sent by our own App identity shall be ignored. The label
  allowlist is a `{any, all, none}` predicate over the label set: `any` is an OR requirement, `all` a
  stricter AND requirement, and `none` is **suppress-only** — it can never cause a trigger, only prevent
  one. A label rule (and a `labeled` PR rule) shall carry at least one positive selector (a non-empty
  `any` or `all`). For a `pull_request`: `action: labeled` is gated by the label predicate (a
  collaborator-applied label is the approval); `action ∈ {opened, synchronize, reopened}` is gated by the
  PR `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` — a gate hard-coded in the filter, never
  config-optional. A comment carrying `issue.pull_request` is a PR-context comment and enqueues a
  pull_request target.
- **Why**: The enforcement of `CONST-TRIGGER-AUTHOR-GATE`. The bot-loop guard matters independently: our
  own job comments on the issue — or pushes to a PR head branch, which fires `pull_request.synchronize` —
  an event that without the guard triggers another job, an unbounded paid recursion. The positive-selector
  requirement is what keeps a `none`-only rule — which would match every labeled event lacking the excluded
  labels, wider than a single-label OR — from ever loading. The PR auto-action author gate is
  load-bearing money control: without it, any fork PR opened by a stranger launches a paid agent run.
- **Traces to**: `CONST-TRIGGER-AUTHOR-GATE`, `CONST-HMAC-OVER-RAW-BODY`
- **Acceptance**: Given `@pi fix this` with `author_association: NONE`, 204 and zero jobs. Given a
  comment from our own App id, 204 and zero jobs. Given a flow rule with no positive selector (`none`
  only, or empty), config load fails and the receiver does not boot. Given a `pull_request.opened` whose
  PR `author_association` is not a collaborator, 204 and zero jobs; given the same from a `COLLABORATOR`,
  exactly one job. Given a `pull_request.synchronize` whose `sender.id` is our own identity, 204 and zero
  jobs (the bot-loop guard).

## REQ-JOB-TIMEOUT-30M

- **Statement**: A container exceeding 30 minutes shall be stopped and the job failed.
- **Why**: Bounds *wall-clock*, which `REQ-RUNNER-TURN-BUDGET` does not. A wedged agent otherwise holds
  one of three worker slots indefinitely — a single runaway costs 33% of throughput. 30 minutes is ~3×
  headroom over the ~10-minutes-per-job working assumption. Note the design document framed this as the
  coarse control with pi's max-turns as the fine one; **pi has no fine one**, so this and the turn budget
  are both required and neither substitutes for the other.
- **Traces to**: `REQ-RUNNER-TURN-BUDGET`
- **Acceptance**: Given a job that hangs, the container is stopped at 30 minutes and the slot is freed.
- **Open**: 30 minutes is inherited unmeasured. Honest v1 default, not an evidenced threshold.

## REQ-FRONTEND-VISUAL-VERIFY

- **Statement**: A frontend flow shall start a dev server, screenshot the affected page, make changes,
  re-screenshot, and iterate to a maximum of 5 rounds, attaching before/after images to the PR.
- **Why**: The capability that motivates the project — precisely the limitation of hosted agent routines
  being worked around. Capped at 5 because each round is a full paid turn against an unbounded aesthetic
  goal ("make it look better" never terminates on its own); uncapped, this loop *is* the runaway.
- **Traces to**: `DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS`, `REQ-RUNNER-TURN-BUDGET`
- **Acceptance**: Given a `pi:frontend` job that changes a page, the PR body contains at least two image
  attachments.
- **Open**: 5 rounds is inherited unmeasured. Honest v1 default.

## REQ-JOB-STATUS-COMMENTS

- **Statement**: Each **GitHub-backed** job shall comment on its triggering issue at start, and on
  completion or failure.
- **Scope**: GitHub jobs only. A local-folder job has no issue to comment on; its equivalent is
  `REQ-LOCAL-JOB-VISIBILITY`. Stated explicitly because the original requirement assumed every job is a
  GitHub issue — it is not.
- **Why**: State must be visible where the human already is — the issue thread. An admin surface the
  operator must deliberately open (now the pi-extension session) does not change that; the issue thread is
  where the requester is already looking, and is the only surface a non-maintainer ever sees. It is also the **only** signal for
  `CONST-PI-VERSION-PINNED`'s silent-no-op failure mode: if an upstream break makes every job a no-op,
  the queue still reports success — a missing completion comment is what a human would actually notice.
- **Traces to**: `CONST-MERGE-NEVER-AUTOMATIC`, `CONST-PI-VERSION-PINNED`
- **Acceptance**: Given any GitHub job reaching a terminal state, exactly one completion or failure
  comment exists on the issue.

## REQ-BRANCH-PROTECTION-PRECONDITION

- **Statement**: The worker shall refuse a GitHub-backed job whose default branch is unprotected,
  before reserving budget or starting a container.
- **Scope**: GitHub jobs only. A local-folder job has no remote branch to protect.
- **Why**: The per-job credential carries `contents:write`, which covers push **and** merge, so branch
  protection is the only technical barrier to a self-merge — the precondition is the operational
  backstop for `CONST-MERGE-NEVER-AUTOMATIC`. The check is consulted before any spend so a repo that
  cannot satisfy it costs nothing: a determinate "no protection object" (a `404` from the protection
  API) is a policy refusal, while any other error is retryable and must never be read as a silent
  "unprotected" that would bypass the backstop.
- **Traces to**: `CONST-MERGE-NEVER-AUTOMATIC`, `CONST-TOKEN-SCOPED-PER-JOB`, `CONST-BUDGET-BEFORE-TOKENS`
- **Acceptance**: Given a GitHub job whose default branch has no protection, the worker returns a policy
  refusal before `reserveBudget` and before any container starts — no budget slot is consumed, no
  provider spend occurs, and a refusal comment is posted to the issue. A transient protection-API error
  (non-`404`) is retried, not treated as unprotected.

## REQ-LOCAL-JOB-VISIBILITY

- **Statement**: A local-folder job shall surface its outcome where the operator is already looking — the
  worker's console — at start and on completion or failure, and in the admin extension's `runs` view
  (`REQ-ADMIN-VIA-PI-EXTENSION`). The container's own output shall stream to that console during the run.
- **Why**: The local counterpart of `REQ-JOB-STATUS-COMMENTS`, and it carries the same load: it is the
  signal for `CONST-PI-VERSION-PINNED`'s silent-no-op failure mode. A local job has no issue thread, so
  without a console signal a broken run would still report success to the queue and a human would notice
  nothing. Streaming the container output is not a debug nicety — on the operator's own machine, watching
  the agent work on their own folder is the primary feedback surface, and a missing completion line is
  what tells them a run did nothing.
- **Note on logs**: in a terminal this is the operator's own console for their own folder, not a
  persistent multi-user log. **Under a service manager it becomes one**: the console is the manager's
  captured, persistent log (systemd's journald, launchd's `StandardOutPath`, nssm's `AppStdout`), so
  `no-pii-in-logs` applies to it directly — not only to hypothetical *stored* logs. Log the stable job id
  and outcome, not task bodies.
- **Traces to**: `CONST-PI-VERSION-PINNED`, `DES-CLI-TRIGGER-FOR-LOCAL`, `INT-RUNNER-EXIT-CODE-PROTOCOL`
- **Acceptance**: Given a local job reaching a terminal state, the worker console shows exactly one
  completion or failure line carrying the job id and outcome; during the run, the container's output is
  visible there.

## REQ-CRON-SCHEDULED-JOBS

- **Statement**: Scheduled jobs shall be driven by BullMQ **Job Schedulers** (`upsertJobScheduler`), one
  per configured schedule. A schedule is a **trigger, not a job kind**: on each tick it emits an ordinary
  `kind:"local"` job that flows through the **same** processor as an interactively-triggered local job.
- **Why**: An unattended recurring trigger spends real money against a paid provider with nobody watching,
  so every failure mode of the scheduler is a money-or-silence failure. Job Schedulers are a Redis-resident
  object (survives worker and Redis-under-AOF restart) and give no-backfill and structural no-overlap for
  free — reimplementing those is the four-mechanism drowning `DES-CRON-VIA-BULLMQ-SCHEDULER` refused. The
  scheduler is also the one path that **bypasses `maxStalledCount`** (`CONST-RETRY-INFRA-ONLY`), so the
  stall backstop must be rebuilt explicitly; and because it fires while nobody watches, a `-10`/`-11`
  silent no-op or an in-tick retry storm would be invisible without the loud-surfacing and no-retry rules
  below.
- **Traces to**: `DES-CRON-VIA-BULLMQ-SCHEDULER`, `CONST-RETRY-INFRA-ONLY`, `CONST-BUDGET-BEFORE-TOKENS`,
  `REQ-RUNNER-TURN-BUDGET`
- **Acceptance**:
  - Given a config with N schedules, when the worker loads them, then it calls `upsertJobScheduler` once
    per schedule; a `-10` (`SchedulerJobIdCollision`) or `-11` (`SchedulerJobSlotsBusy`) result — whether
    thrown or returned — is surfaced loudly (logged and the load fails), never swallowed into a silent
    no-op.
  - Given a scheduler whose per-scheduler stall counter exceeds `PI_SCHEDULER_STALL_MAX`, when the next
    stall is observed, then the scheduler is torn down via `removeJobScheduler` — the explicit backstop for
    the `maxStalledCount` carve-out.
  - Given a worker that was down across one or more due ticks, when it restarts, then exactly one job is
    emitted (no backfill) and no second job for a schedule is created while that schedule's prior job is
    still processing (no overlap).
  - Given a scheduler resident in Redis but absent from the current config, when the worker performs its
    startup reconcile, then the orphaned scheduler is removed.
  - Given a schedule entry with `kind:"github"`, when the config loads, then the entry is rejected — a
    scheduled trigger supplies no webhook delivery, issue number, title, or body, so only `kind:"local"`
    is admissible.
  - Given a scheduled occurrence that fails (including an infra fault), when the tick concludes, then the
    occurrence is **not** retried within the tick — the schedule's own cadence is the retry.

## REQ-DURABLE-RUN-HISTORY

- **Statement**: For each job reaching a terminal state — completed, policy refusal, or infra failure —
  the worker shall persist a durable, PII-free status record retrievable by job id, and — when raw
  capture is explicitly enabled (`PI_CAPTURE_JOB_LOGS`) — capture the container's output to
  `logs/<jobId>.log`. Records shall survive a worker restart and outlive BullMQ's job-hash eviction. No
  new datastore.
- **Scope**: Both GitHub and local jobs. This is a **third, durable** surface — it complements, and does
  not replace, `REQ-LOCAL-JOB-VISIBILITY` (the ephemeral console line plus live stream) and
  `REQ-JOB-STATUS-COMMENTS` (the GitHub issue comment).
- **Why**: The admin extension and post-hoc debugging need a keyed, structured read-model that a scrolling
  console/journal cannot provide; the durable record is also a second, persistent signal for
  `CONST-PI-VERSION-PINNED`'s silent-no-op mode. The id-only record honours `no-pii-in-logs` — log the
  stable ids (the delivery GUID, `repo#issue`), never issue or comment bodies — while the raw
  `logs/<jobId>.log` is agent output that may echo issue text, so it is opt-in (default off) and
  gitignored. Assembled in `worker/src/run-history.mjs` and written at the terminal path in
  `worker/src/index.mjs`.
- **Traces to**: `REQ-LOCAL-JOB-VISIBILITY`, `REQ-JOB-STATUS-COMMENTS`, `INT-RUNNER-EXIT-CODE-PROTOCOL`,
  `INT-RUN-HISTORY-FILE-CONTRACT`, `CONST-PI-VERSION-PINNED`
- **Acceptance**: Given a job reaching a terminal state, a record keyed by its job id exists carrying the
  correct outcome and is present after a worker restart; the record contains no issue or comment body,
  title, or username (`target` is `repo#issue` / `local:<basename>` only); the raw `logs/<jobId>.log`
  exists only when `PI_CAPTURE_JOB_LOGS` is set and is gitignored.

## REQ-ADMIN-VIA-PI-EXTENSION

- **Statement**: The admin surface shall ship as a pi extension in `admin/`, loaded into the operator's
  interactive pi session. It provides operator slash commands for observability (`status`, `runs`, `logs`,
  `budget`, `triggers`), queue on/off (`pause`/`resume`, backed by the same durable `queue.pause()`), and
  settings editing (`set`/`unset`, writing the `settings.json` overlay). The model-callable tools are
  **reads, `pause`/`resume`, and `dispatch_run`** (a gated enqueue); every settings write is an
  operator-typed command, never a model-invocable tool, and `dispatch_run` accordingly takes **no
  spend-knob argument** (`model`/`maxTurns`/`dailyCap`/`concurrency`).
- **Scope**: The operator's interactive session on the worker host. The admin surface triggers no jobs
  except the gated `dispatch_run` enqueue, and is never materialised into a job's `/job` inputs —
  `INT-CONTAINER-JOB-INPUTS` mounts the serviced repo's own `.pi/` extensions, not this one.
- **Why**: See `DES-ADMIN-VIA-PI-EXTENSION` — a session-bound, port-less admin surface for a
  terminal-native operator, narrower than the superseded localhost panel. No model-callable tool can
  **raise** the daily cap: every settings write (dailyCap included) is operator-typed, and `dispatch_run`
  takes no spend-knob argument — they resolve from the overlay/env per
  `DES-RUNTIME-SETTINGS-FILE-OVERLAY`, and the paid run `dispatch_run` enqueues spends **within** the cap
  (`reserveBudget`, consumer-side), it does not widen it (`CONST-BUDGET-BEFORE-TOKENS`). The
  injected-`dispatch_run` residual is bounded by structure, not undo — folder allowlist, committed
  per-flow opt-in, dirty refusal, no spend knobs, per-hour rate limit, and the daily cap
  (`DES-ADMIN-VIA-PI-EXTENSION`). Raw `.log` output is overlay-only, so untrusted container text never
  enters model context (`CONST-ISSUE-TEXT-IS-DATA`, one layer down).
- **Traces to**: `DES-ADMIN-VIA-PI-EXTENSION`, `DES-AI-TRIGGER-FLOW-GATE`, `DES-JOB-OUTBOX-CHAINING`,
  `CONST-ISSUE-TEXT-IS-DATA`, `CONST-BUDGET-BEFORE-TOKENS`, `REQ-DURABLE-RUN-HISTORY`,
  `REQ-AI-TRIGGERED-RUNS`
- **Acceptance**: Given the extension is loaded, when the operator runs `/dispatch status`, then queue
  counts, paused state, and budget render with no model involvement; given a model-invoked tool call, when
  it is a settings write, then no such tool exists (writes are commands only); given `dispatch_run`, when
  it is invoked, then it exposes no `model`/`maxTurns`/`dailyCap`/`concurrency` argument, admits a run only
  for a folder within `PI_DISPATCH_RUN_ROOTS` and a flow whose pre-agent-SHA `SKILL.md` carries
  `ai-trigger: allow`, and the enqueued job's spend resolves from overlay/env and is bounded by the daily
  cap; given `/dispatch logs`, when
  the raw `.log` renders, then it renders in the overlay viewer and is never returned as a tool result or
  sent as a message into model context; given an operator pi whose API surface lacks any required member,
  when the extension loads, then it registers nothing and reports the unsupported version loudly.

## REQ-AI-TRIGGERED-RUNS

- **Statement**: The harness shall enqueue a local job on behalf of the AI from two sources — the
  model-callable `dispatch_run` tool (with its operator `/dispatch run` command) and a completed job's
  `/outbox`, collected by the worker — each subject to a **per-flow default-deny gate**: the flow's
  `.pi/skills/<flow>/SKILL.md` must carry `ai-trigger: allow` frontmatter read at a **pre-agent SHA**. A
  flowless AI trigger is refused. The `dispatch_run` tool's folder is confined to `PI_DISPATCH_RUN_ROOTS`;
  chaining is bounded by depth, count, and rate caps (`PI_CHAIN_DEPTH_MAX`, `PI_CHAIN_MAX_PER_JOB`,
  `PI_DISPATCH_RUN_PER_HOUR`). Budget is unchanged: a chained or enqueued job passes `reserveBudget`
  consumer-side like any other local job.
- **Scope**: Local jobs only; same-folder chaining only in this slice (the outbox `folder` field is
  ignored — the child runs the parent's own folder). An operator-typed CLI (`pi-dispatch run`) or
  `/dispatch run` command is **ungated** — typing it is the approval.
- **Why**: The two model-reachable producers need a WHAT-gate the operator-typed CLI does not, because
  they are prompt-injection-reachable; the committed, pre-agent-SHA opt-in is agent-uninfluenceable. See
  `DES-AI-TRIGGER-FLOW-GATE` (the gate) and `DES-JOB-OUTBOX-CHAINING` (the outbox producer and its
  host-computed depth).
- **Traces to**: `DES-AI-TRIGGER-FLOW-GATE`, `DES-JOB-OUTBOX-CHAINING`, `DES-ADMIN-VIA-PI-EXTENSION`,
  `DES-CLI-TRIGGER-FOR-LOCAL`, `CONST-BUDGET-BEFORE-TOKENS`, `CONST-ISSUE-TEXT-IS-DATA`,
  `INT-OUTBOX-CONTRACT`
- **Acceptance**: Given a flow whose pre-agent-SHA `SKILL.md` lacks `ai-trigger: allow`, when a
  `dispatch_run` or outbox trigger names it, then it is refused, nothing is enqueued, and no budget is
  touched; given a flow whose `SKILL.md` carries `ai-trigger: allow` at that SHA, when triggered, then it
  is enqueued as an ordinary local job that passes `reserveBudget` consumer-side; given a `dispatch_run`
  folder outside `PI_DISPATCH_RUN_ROOTS`, when invoked, then it is refused; given a dirty working tree,
  when `dispatch_run` fires, then it refuses with no force option; given a chain request exceeding
  `PI_CHAIN_DEPTH_MAX` or `PI_CHAIN_MAX_PER_JOB`, when collected, then it is refused loudly and the
  parent's own outcome is unchanged; given an operator-typed `/dispatch run`, when invoked, then no gate
  applies.

## REQ-RUNTIME-SETTINGS-PICKUP

- **Statement**: The worker shall honour overlay changes without a restart: `model`, `provider`,
  `maxTurns`, `dailyCap`, `weeklyCap`, `monthlyCap`, `maxTokens`, `dailyTokenCap`, and `softHoldPct`
  resolve per job at job start, and `concurrency` is applied at the worker's next job pickup.
- **Why**: A settings edit at 11pm must not require a service restart. The worker re-reads the overlay in
  its processor at each job start — no watcher and no reload signal (see `DES-RUNTIME-SETTINGS-FILE-OVERLAY`).
- **Traces to**: `DES-RUNTIME-SETTINGS-FILE-OVERLAY`, `INT-CONFIG-OVERLAY-CONTRACT`,
  `CONST-BUDGET-BEFORE-TOKENS`
- **Acceptance**: Given a present-but-invalid overlay, when a job starts, then the processor returns a
  policy refusal `settings-overlay-invalid` before `reserveBudget` — no budget slot consumed, no container
  started, not retried; given a job whose data omits `model`/`provider`/`maxTurns`, when it starts, then
  the value falls to the overlay, then env, then default — not a value frozen at enqueue; given `dailyCap`
  lowered below today's reserved count, when the next job starts, then it is refused over-budget before any
  container.

## REQ-SPEND-CAPS-MULTI-WINDOW

- **Statement**: The pre-container budget check shall bound container starts across **three windows** — a
  **mandatory daily** cap plus **optional weekly and monthly** ceilings — and shall additionally refuse new
  starts inside a single **soft-hold band** expressed as a percentage of each active window's cap. A job is
  admitted only when **every** active window is within its cap **and** outside its soft-hold band; otherwise
  it is refused pre-container with a window-named reason (`over-budget` at the hard cap, `soft-hold` in the
  band). Week/month are disabled when their cap is unset; the soft-hold band is disabled when its percentage
  is unset. All three windows and the band are overlay/env tunable (`weeklyCap`, `monthlyCap`, `softHoldPct`;
  `PI_WEEKLY_CAP`, `PI_MONTHLY_CAP`, `PI_SOFT_HOLD_PCT`) and resolve `job.data > overlay > env` per job.
- **Why**: A daily cap alone bounds a single day's blast radius but not a slow bleed — a flow that stays
  under 25/day every day still spends unboundedly across a month. The weekly and monthly ceilings close that
  gap on longer horizons. The soft-hold band is a distinct operator brake **before** the hard wall: crossing
  it pauses new starts (in-flight containers finish, since the reservation is pre-container) and turns the
  panel meter amber, so an operator is warned and can raise a cap or intervene rather than discovering the
  ceiling only when jobs start refusing. These remain **job-count** caps (container starts), not tokens —
  the thing knowable *before* a run — so `CONST-BUDGET-BEFORE-TOKENS` is unchanged; the token controls are a
  separate, structurally lagging problem addressed by `REQ-TOKEN-ACCOUNTING-AND-CAPS` (`OQ-010`).
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `DES-RUNTIME-SETTINGS-FILE-OVERLAY`,
  `INT-CONFIG-OVERLAY-CONTRACT`, `REQ-RUNTIME-SETTINGS-PICKUP`
- **Acceptance**: Given any active window over its cap, when a job starts, then it is refused `over-budget`
  before `reserveBudget` admits a container, and the refusal names the blocking window; given a reservation
  that lands inside the soft-hold band of any active window but under every hard cap, when a job starts, then
  it is refused `soft-hold` before any container while in-flight jobs continue; given an unset `weeklyCap`
  (and no `PI_WEEKLY_CAP`), when a job starts, then the weekly window is neither counted nor evaluated; given
  a `softHoldPct` set live in the overlay, when the next job starts, then the band takes effect with no
  restart; given a refused reservation, when the window rolls over, then its counter is reclaimed by TTL.

## REQ-TOKEN-ACCOUNTING-AND-CAPS

- **Statement**: The harness shall (a) **account** every job's token usage — the runner accumulates the
  per-turn `usage` pi emits on `subscribe()` (`OQ-010`) into per-job totals `{ input, output, total, cost }`,
  emits them on the `exit` line, and the worker persists them in the run record and surfaces them in the admin
  run views; (b) provide an **optional per-job token budget** (`maxTokens` / `PI_MAX_TOKENS`) that the runner
  enforces in-run by aborting the session once cumulative tokens exceed it, exiting policy (`2`) with
  `reason: "token_budget"`; and (c) provide an **optional daily token cap** (`dailyTokenCap` /
  `PI_DAILY_TOKEN_CAP`) that refuses a new job pre-container once the day's recorded spend has reached it.
  Both caps are unset-means-disabled and resolve `job.data > overlay > env` per job; accounting is always on.
- **Why**: pi bounds neither tokens nor money; before this, spend was visible only on the provider bill.
  Accounting is the high-value piece — per-job token/cost in the run history is what lets an operator tune the
  **proactive** levers (`maxTurns`, the job-count caps). The two token caps are **backstops**, and both are
  structurally **lagging** (`OQ-010`): a token's cost is knowable only *after* its turn runs. So `maxTokens`
  can only abort *after* the breaching turn is already paid for (finer-grained than `maxTurns`, since turns
  vary wildly in token cost), and `dailyTokenCap` can only stop the *next* job. This forces a deliberate
  **asymmetry** with `CONST-BUDGET-BEFORE-TOKENS`: the job-count cap is check-**before** (it can, a count is
  knowable pre-run); the daily token cap is check-**after** — a read-only check of prior recorded spend before
  the container (consuming no job-count slot) plus an `INCRBY` of the job's tokens after it. The constitution
  governs only the *job-count* cap's ordering and is unchanged; this is a differently-shaped control, not a
  relaxation of it. Under concurrency the daily counter is best-effort — N in-flight jobs each pass the check
  before any records, so the day can overshoot by up to N per-job budgets — which is acceptable for a lagging
  backstop and is not the job-count cap's atomic guarantee.
- **Traces to**: `OQ-010`, `REQ-RUNNER-TURN-BUDGET`, `REQ-UPSTREAM-CONTRACT-TESTS`,
  `CONST-BUDGET-BEFORE-TOKENS`, `INT-RUNNER-EXIT-CODE-PROTOCOL`, `INT-RUN-HISTORY-FILE-CONTRACT`,
  `INT-CONFIG-OVERLAY-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`, `REQ-SPEND-CAPS-MULTI-WINDOW`
- **Acceptance**: Given any completed job, when it ends, then its run record carries a `tokens`
  `{ input, output, total, cost }` object and the admin run views show its total and cost; given `maxTokens`
  set and a job whose cumulative usage exceeds it, when the budget is hit, then the runner aborts, exits `2`
  with `reason: "token_budget"`, and the queue does not retry it; given `dailyTokenCap` set and a day whose
  recorded spend has reached it, when the next job starts, then it is refused pre-container with
  `daily-token-cap`, spends zero provider tokens, and consumes no job-count slot; given a container that ran
  and spent, when it ends on any outcome, then its tokens are added to the daily counter; given both caps
  unset, then usage is still accounted and no job is ever refused or aborted for tokens; given a pin bump that
  drops or reshapes `Usage`, then `REQ-UPSTREAM-CONTRACT-TESTS` fails the build, not a live job.

---

## Notes (not requirements)

**Capacity and cost.** ~1.5–2.5 GB RAM per job (pi + dev server + headless Chromium) and roughly
$0.5–$5 per job are **unmeasured estimates** — the design document says "measure!" and notes no
published figures exist. A requirement needs a testable threshold; a guess is rationale at best. These
inform `DES-CONCURRENCY-3` and are tracked at `OQ-002`. Only the budget caps graduate to a constraint
(`CONST-BUDGET-BEFORE-TOKENS`), now spanning day/week/month windows plus a soft-hold band
(`REQ-SPEND-CAPS-MULTI-WINDOW`).

**Burst math.** 50 triggers at concurrency 3 and ~10 min/job drains in ≈2.8 hours. That is the
wait-list working as designed, not a failure — see `README.md`.

---

## Revision History

| Date | Change |
|---|---|
| 2026-07-15 | Initial. Extracted from `DESIGN.md` v0.1 §1, §5.1–5.2, §5.6, §7, §8. `REQ-RUNNER-TURN-BUDGET` and `REQ-UPSTREAM-CONTRACT-TESTS` are **new** — both exist because source-verification refuted design assumptions the doc had marked "verify". §8's failure-mode table was the richest source; one of its rows ("verify: pi max-turns option") was wrong. |
| 2026-07-17 | Added REQ-BRANCH-PROTECTION-PRECONDITION, formalizing the branch-protection refusal already enforced in `processor.mjs`/`github-host.mjs` (was a dangling code citation). |
| 2026-07-17 | Added REQ-CRON-SCHEDULED-JOBS, formalizing the implemented BullMQ Job Scheduler cron path: `local`-only triggers, loud `-10`/`-11` handling, per-scheduler stall teardown, startup orphan reconcile, and no in-tick retry. |
| 2026-07-21 | Added REQ-DURABLE-RUN-HISTORY (durable per-job run record + opt-in raw log; read model for the panel). |
| 2026-07-16 | **Scope de-GitHub-ified.** It said "triggers on GitHub issue activity" and never mentioned local folders, the CLI/panel, or cron -- stale, since local is now first-class and built. Rewritten as trigger × target. `REQ-JOB-STATUS-COMMENTS` scoped to GitHub jobs explicitly (a local job has no issue). New `REQ-LOCAL-JOB-VISIBILITY`: local jobs surface their outcome on the worker console (and later the panel) -- the local counterpart of the issue comment and the same signal for `CONST-PI-VERSION-PINNED`'s silent-no-op mode. Code updated to match: startWorker now logs one terminal line per job. |
| 2026-07-21 | Added REQ-ADMIN-VIA-PI-EXTENSION (admin surface as a pi extension in `admin/`: operator observability/pause-resume/settings commands, reads-plus-pause/resume-only model tools, overlay-only raw logs) and REQ-RUNTIME-SETTINGS-PICKUP (per-job overlay re-read for model/provider/maxTurns/dailyCap; concurrency at next pickup). Rescoped panel references to the admin extension in Scope, `REQ-JOB-STATUS-COMMENTS`, `REQ-LOCAL-JOB-VISIBILITY`, and `REQ-DURABLE-RUN-HISTORY`. |
| 2026-07-22 | Added REQ-SPEND-CAPS-MULTI-WINDOW: the pre-container budget check now spans a mandatory daily cap plus optional weekly/monthly ceilings and a soft-hold percentage band (enforcing — refuses new starts in-band with a distinct `soft-hold` reason). Extended REQ-RUNTIME-SETTINGS-PICKUP's key list to include `weeklyCap`/`monthlyCap`/`softHoldPct`. `CONST-BUDGET-BEFORE-TOKENS` unchanged (still job-count, still check-before-start). |
| 2026-07-22 | Amended REQ-ADMIN-VIA-PI-EXTENSION to the three-tool framing — `dispatch_run` is a third, spend-knobless model-callable enqueue gated by `DES-AI-TRIGGER-FLOW-GATE`; the `Statement` and `Why` both drop the superseded reads-plus-pause/resume-only categorical, keeping the cap-integrity rationale on the new premise that no model tool carries a spend knob, and the `Acceptance` gains a `dispatch_run` clause. Added REQ-AI-TRIGGERED-RUNS (the two AI-triggered producers — the `dispatch_run` tool/command and the worker's `/outbox` collector — under a per-flow pre-agent-SHA `ai-trigger: allow` gate, folder-confined to `PI_DISPATCH_RUN_ROOTS`, depth/count/rate-capped, budget unchanged; operator-typed CLI/command ungated). |
| 2026-07-22 | Coherence fix: reworded the two live "triggers no jobs" admin claims — REQ-ADMIN-VIA-PI-EXTENSION `Scope` and the `Triggers` overview bullet — to "triggers no jobs except the gated `dispatch_run` enqueue", resolving the self-contradiction with the same entry's `Statement`/`Why` `dispatch_run` clauses (still never materialised into a job's `/job` inputs). |
| 2026-07-22 | Added REQ-TOKEN-ACCOUNTING-AND-CAPS (issue #25, unblocked by OQ-010): per-job token/cost accounting in the run record + admin views; an optional in-run per-job token budget (`maxTokens`/`PI_MAX_TOKENS`, exits policy `token_budget`); and an optional daily token cap (`dailyTokenCap`/`PI_DAILY_TOKEN_CAP`) enforced **check-AFTER** — the deliberate asymmetry with `CONST-BUDGET-BEFORE-TOKENS`, which is unchanged (still job-count, still check-before). Extended REQ-RUNTIME-SETTINGS-PICKUP's key list with `maxTokens`/`dailyTokenCap`; retargeted REQ-SPEND-CAPS-MULTI-WINDOW's OQ-010 forward-reference to the new REQ. |
