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
- **Triggers**: the **CLI** / **panel** (operator-initiated, `DES-CLI-TRIGGER-FOR-LOCAL`), a **webhook**
  (GitHub issue activity), or **cron** (a schedule).

Everything below the trigger is identical: budget check → `/job:ro` inputs → one container → the runner
→ an exit code. What differs is authz (a label/collaborator gate for webhooks vs panel/CLI access for
local), the credential (a short-lived scoped token for GitHub jobs vs none for local), and the completion signal
(an issue comment vs the console/panel — see `REQ-JOB-STATUS-COMMENTS` and `REQ-LOCAL-JOB-VISIBILITY`).

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

- **Statement**: The receiver shall enqueue only for allowlisted labels, or comments whose
  `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` matching the trigger phrase. Events sent by our
  own App identity shall be ignored.
- **Why**: The enforcement of `CONST-TRIGGER-AUTHOR-GATE`. The bot-loop guard matters independently: our
  own job comments on the issue, which is an `issue_comment.created` event, which without the guard
  triggers another job — an unbounded paid recursion.
- **Traces to**: `CONST-TRIGGER-AUTHOR-GATE`, `CONST-HMAC-OVER-RAW-BODY`
- **Acceptance**: Given `@pi fix this` with `author_association: NONE`, 204 and zero jobs. Given a
  comment from our own App id, 204 and zero jobs.

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
- **Why**: State must be visible where the human already is. The queue dashboard sits behind basic auth
  on a home box and nobody opens it; the issue thread is where the requester is already looking, and is
  the only surface a non-maintainer ever sees. It is also the **only** signal for
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
  worker's console — at start and on completion or failure, and (once built) in the panel's job view. The
  container's own output shall stream to that console during the run.
- **Why**: The local counterpart of `REQ-JOB-STATUS-COMMENTS`, and it carries the same load: it is the
  signal for `CONST-PI-VERSION-PINNED`'s silent-no-op failure mode. A local job has no issue thread, so
  without a console signal a broken run would still report success to the queue and a human would notice
  nothing. Streaming the container output is not a debug nicety — on the operator's own machine, watching
  the agent work on their own folder is the primary feedback surface, and a missing completion line is
  what tells them a run did nothing.
- **Note on logs**: this is the operator's own terminal for their own folder, not a persistent multi-user
  log; `no-pii-in-logs` still applies to any *stored* worker logs (log the stable job id and outcome,
  not task bodies).
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

---

## Notes (not requirements)

**Capacity and cost.** ~1.5–2.5 GB RAM per job (pi + dev server + headless Chromium) and roughly
$0.5–$5 per job are **unmeasured estimates** — the design document says "measure!" and notes no
published figures exist. A requirement needs a testable threshold; a guess is rationale at best. These
inform `DES-CONCURRENCY-3` and are tracked at `OQ-002`. Only the daily budget cap graduates to a
constraint (`CONST-BUDGET-BEFORE-TOKENS`).

**Burst math.** 50 triggers at concurrency 3 and ~10 min/job drains in ≈2.8 hours. That is the
wait-list working as designed, not a failure — see `README.md`.

---

## Revision History

| Date | Change |
|---|---|
| 2026-07-15 | Initial. Extracted from `DESIGN.md` v0.1 §1, §5.1–5.2, §5.6, §7, §8. `REQ-RUNNER-TURN-BUDGET` and `REQ-UPSTREAM-CONTRACT-TESTS` are **new** — both exist because source-verification refuted design assumptions the doc had marked "verify". §8's failure-mode table was the richest source; one of its rows ("verify: pi max-turns option") was wrong. |
| 2026-07-17 | Added REQ-BRANCH-PROTECTION-PRECONDITION, formalizing the branch-protection refusal already enforced in `processor.mjs`/`github-host.mjs` (was a dangling code citation). |
| 2026-07-17 | Added REQ-CRON-SCHEDULED-JOBS, formalizing the implemented BullMQ Job Scheduler cron path: `local`-only triggers, loud `-10`/`-11` handling, per-scheduler stall teardown, startup orphan reconcile, and no in-tick retry. |
| 2026-07-16 | **Scope de-GitHub-ified.** It said "triggers on GitHub issue activity" and never mentioned local folders, the CLI/panel, or cron -- stale, since local is now first-class and built. Rewritten as trigger × target. `REQ-JOB-STATUS-COMMENTS` scoped to GitHub jobs explicitly (a local job has no issue). New `REQ-LOCAL-JOB-VISIBILITY`: local jobs surface their outcome on the worker console (and later the panel) -- the local counterpart of the issue comment and the same signal for `CONST-PI-VERSION-PINNED`'s silent-no-op mode. Code updated to match: startWorker now logs one terminal line per job. |
