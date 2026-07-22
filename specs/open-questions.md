# Open Questions

A **register**, not a work queue. A row records the question *and*, once answered, the answer — which
is the durable half. GitHub issues are for scheduling work; an issue closes and takes its answer with
it into a place nobody greps. Rows may link to an issue; the issue may close; the row does not.

Status values: `OPEN` (unanswered) · `WATCH` (not a question — a known-incoming change to monitor) ·
`ACCEPTED RISK` (decided, shipping anyway) · `CLOSED` (answered; the answer stays here).

---

## OQ-001 — Do concurrent `createAgentSession` instances safely coexist in one Node process?

- **Status**: **CLOSED — MOOT BY DESIGN**
- **Answer**: Unreachable. `CONST-ISOLATION-CONTAINER-PER-JOB` means one agent per container per job, so
  two sessions never share a process. The source design doc said this outright: container-per-job
  *"sidesteps an open question from the research… We never find out the hard way."*
- **What would reopen it**: abandoning container-per-job. Nothing else. If that is ever proposed, this
  question comes back with it, and it is unanswered — pi's SDK documentation contains no concurrency,
  thread-safety, or parallel-session guidance, and no upstream issue addresses it. Note also that pi's
  `[Unreleased]` `modelRuntime` refactor touches shared auth/catalog state, so in-process concurrency
  should not be assumed even if it happens to work on a given day.

## OQ-002 — What is the real RAM footprint per job?

- **Status**: **OPEN**
- **Question**: Actual resident memory of pi + a dev server + headless Chromium, under a representative
  frontend job.
- **Why it matters**: `DES-CONCURRENCY-3` currently rests on a ~1.5–2.5 GB/job estimate that **nobody
  measured** — the source design doc says "measure!" and notes no published figures exist. Until this is
  answered, the concurrency default is a guess wearing a number's clothing. Note the answer may not even
  bind: the provider's rate limits likely throttle concurrent streams before Docker exhausts memory, in
  which case RAM is the wrong axis entirely and that itself is the finding.
- **Blocks**: `DES-CONCURRENCY-3` being evidenced rather than assumed. Blocks nothing from shipping.
- **How to answer**: run a representative frontend job; measure peak RSS of the container.
- **May also get an issue**: yes — this is schedulable work. The row stays regardless.

## OQ-003 — Does the assembled system prompt survive compaction and session reload byte-identically?

- **Status**: **OPEN**
- **Question**: When pi compacts context or reloads a session, is the cached prefix reproduced
  byte-for-byte?
- **Why it matters**: `CONST-PERSONA-IN-CACHED-PREFIX`'s economics assume the prefix is stable — a
  ~10× cost difference between a cache hit and a re-send. If compaction perturbs the prefix by even one
  byte, the cache misses and the assumed saving quietly evaporates. It would not break correctness, so
  nothing would alert us; it would just cost more than the design says.
- **Honest note**: no verification pass has tested this. It is listed as unknown rather than assumed
  safe.
- **Mitigating factor**: jobs are short-lived and single-purpose, so compaction may never trigger in
  practice. That is a hypothesis, not an answer.

## OQ-004 — Egress from the job container is unrestricted in v1

- **Status**: **ACCEPTED RISK** — *wants explicit ratification*
- **Position**: v1 ships without an allowlist proxy. A job container can reach the internet. The bound
  on exfiltration is `CONST-TOKEN-SCOPED-PER-JOB`'s short-lived, minimally-permissioned credential, not network policy.
- **Why it is a risk row and not a constraint**: the source design doc listed egress allowlisting as
  security "layer 4" while also saying v1 ships without it. **A constraint that ships unenforced is worse
  than an honest open risk** — it teaches readers that the constitution is aspirational, which corrodes
  every other entry in it. So it lives here, and `SECURITY.md` states it plainly under "what is NOT
  defended".
- **What would close it**: an allowlist proxy (`api.anthropic.com`, `github.com`,
  `registry.npmjs.org`) on a dedicated Docker network. At that point it graduates to a `CONST-`.
- **Needs**: maintainer ratification that shipping v1 this way is acceptable.

## OQ-005 — pi's `modelRuntime` migration: NOT in the pin; lands when we bump

- **Status**: **WATCH — NOT IN THE PIN**
- **Not a question — a scheduled landmine.** pi's changelog carries the breaking change under
  `[Unreleased]`: `authStorage` and `modelRegistry` *replaced* by an async `modelRuntime`.
  `createAgentSession`'s option set changes with it. **It has not shipped.** At `0.80.7` the wiring is
  `AuthStorage.create(authPath)` + `ModelRegistry.create(authStorage, modelsPath)`, both synchronous,
  and `modelRegistry.find(provider, modelId)` is the lookup. The runner is written against **that**.
- **Retracted (2026-07-16)**: an earlier revision of this row asserted `modelRuntime` was "already
  present at the pin" and concluded **"the changelog is not a reliable signal"**. Both were wrong, and
  the second was wrong in a way worth keeping on the record. The claim came from reading
  `sdk.ts` at `5e336cf` — which is **HEAD, not the 0.80.7 release**. `ModelRuntime` does not exist in
  the published `0.80.7` at all: there is no `model-runtime` module in its `dist/`, and `dist/index.js`
  does not export the symbol. **The changelog said `[Unreleased]` and meant it.** The runner was then
  written against `modelRuntime`, the image built cleanly, and every job would have died on a missing
  export — caught only when CI actually ran a container.
  The lesson is not about this row; it is the evidence convention itself, now amended in
  `constitution.md`: **a sha is not a version, and verifying a moving branch does not verify a pinned
  artifact.** Reading source remains right. Reading the *wrong* source carefully is still wrong.
- **Why it cannot be a test**: `REQ-UPSTREAM-CONTRACT-TESTS` gates *our* assumptions against a *pinned*
  version and will fire the moment the pin moves — `pinned-api.test.mjs` asserts `ModelRuntime` is
  **absent**, so the migration shipping is a test failure with a message rather than a discovery. But
  you cannot test for a change that has not shipped. This row is what a human reads before a bump.
- **Action on bump**: re-verify `dist/core/sdk.d.ts` **in the new tarball** — not on `main` — before
  moving the pin. Specifically: whether `model` is still a `Model<any>`, how it is now obtained, and
  whether `authStorage`/`modelRegistry` are gone or merely deprecated.
- **Evidence (pinned artifact — authoritative)**: `npm @earendil-works/pi-coding-agent@0.80.7 →
  dist/core/sdk.d.ts` — `authStorage?: AuthStorage`, `modelRegistry?: ModelRegistry`, **no
  `modelRuntime`**; no `dist/**/model-runtime*` exists; `dist/index.js` exports `AuthStorage` and
  `ModelRegistry` as values and not `ModelRuntime`
- **Evidence (HEAD — the incoming change, not the current one)**:
  `earendil-works/pi @ 5e336cf → CHANGELOG.md:5-10` (`[Unreleased]`) · `→ sdk.ts:33-80`
  (`modelRuntime?: ModelRuntime` present **on main only**) · `→ sdk.ts:171` (async `ModelRuntime.create`)

## OQ-006 — Which GitHub auth mechanism is the default, and when is an App required?

- **Status**: **CLOSED — default `gh` / fine-grained PAT for single-owner; App for multi-tenant**
- **Answer**: The default `GITHUB_AUTH_SOURCE` is `gh` (or a repo-scoped, short-expiry fine-grained PAT)
  for a single-owner deployment. The GitHub App path is optional, strictly stronger on the token axis
  (true per-repo scoping, shorter expiry), and **mandatory for multi-tenant** deployments — a
  fine-grained PAT is per-account and cannot isolate mutually-distrusting owners. A broad or long-lived
  classic PAT is non-conformant either way. This is the property set `CONST-TOKEN-SCOPED-PER-JOB`
  enumerates; the App is no longer a hard prerequisite for running GitHub jobs.
- **Why it was an open question**: the original design assumed a GitHub App was mandatory. Research
  found no GitHub requirement forcing an App for a single-owner tool, and `@octokit/auth-app` shipped
  declared-but-unused — so the mechanism was undecided in practice while the docs implied App-only.
- **What closed it**: this plan (the pluggable `makeGitHubAuth(pat|gh|app)` resolver) plus the E1
  amendment of `CONST-TOKEN-SCOPED-PER-JOB` from App-mandatory/one-hour to mechanism-neutral required
  properties. Recorded here so the decision is durable and greppable rather than buried in a closed PR.
- **Related risk**: `OQ-004` (unrestricted egress) is the reason the credential mechanism matters — the
  token's short expiry, not network policy, is the exfiltration bound, so the mechanism must keep that
  expiry short and the scope narrow. `OQ-004` remains **ACCEPTED RISK** (unchanged by this entry).

## OQ-007 — Run-history log & record retention: periodic (non-boot) sweep

- **Status**: **OPEN**
- **Question**: Should the durable run-history sidecars (`logs/<jobId>.{json,log}`) be pruned by a
  periodic, timer-driven sweep, and if so at what cadence?
- **Why it matters**: sidecar retention is decoupled from BullMQ's queue eviction — the records are meant
  to outlive the queue entries. Pruning is a **boot-time** age sweep only (`makeLogReaper`, window
  `PI_LOG_RETENTION_DAYS`, `0` = keep forever). A worker that runs for a long time without restarting
  therefore never re-sweeps, so `logs/` can grow between restarts. The boot sweep is the shipped partial
  answer; the periodic sweep is the unresolved half.
- **How to answer**: decide whether a timer-driven sweep is warranted and pick a cadence, or ratify
  boot-only pruning as sufficient given the expected restart frequency.
- **Secondary note**: `sanitizeJobId` collapses filesystem-illegal characters (e.g. the colons in a
  `repeat:<sched>:<millis>` scheduler id) to `_`, so two distinct job ids could in principle map to one
  filename. Considered vanishingly unlikely given the `gh-` / `local-` / `repeat:` id grammars; revisit
  with a hash suffix only if it is ever observed.
- **Blocks**: nothing from shipping. The boot sweep bounds growth across restarts today.

## OQ-008 — Runtime trigger editing (cron toggle, label→flow) is deferred

- **Status**: **OPEN**
- **Question**: Should the admin extension edit triggers — toggling a cron schedule, remapping a
  label→flow — and via what mechanism that survives a worker or receiver restart?
- **Why it matters**: A Redis-side scheduler toggle is overwritten by the worker's boot reconcile
  (`REQ-CRON-SCHEDULED-JOBS` acceptance: startup removes schedulers absent from the schedules file), so a
  runtime edit that silently reverts at the next boot is worse than no edit at all. The label→flow mapping
  lives in `receiver.flows.json`, loaded fail-loud at receiver boot, so an edit there needs a receiver
  restart. Two sources of truth — a live toggle and a file the boot reconcile trusts — is the failure mode.
- **How to answer**: Either make the files the write target (the extension edits `schedules.json` /
  `receiver.flows.json` and gains a reload story), or ratify trigger editing as display-only.
- **Blocks**: Nothing this slice — the admin extension ships triggers **display-only**.

## OQ-009 — Chaining from a GitHub-job parent (and cross-folder chaining) is deferred

- **Status**: **OPEN**
- **Question**: Should a GitHub-job parent ever chain follow-up flows, and by what mechanism — given its
  task text is adversarial issue content (`CONST-ISSUE-TEXT-IS-DATA`)? And, as a related future slice,
  should an outbox request ever target a **different** folder than the parent's (cross-folder chaining),
  which would need its own guard stack (realpath + a containment allowlist)?
- **Why it matters**: This slice ships chaining as **same-folder-only, local-parent-only**:
  `DES-JOB-OUTBOX-CHAINING` creates no `/outbox` mount for a `kind:github` job, and the outbox `folder`
  field is forced to the parent's own folder. Both are deliberate deferrals already decided there and
  merely recorded here — this row is the register pointer, not a reconsideration of whether to drop them
  now. A GitHub parent that could nominate host folders would cross the webhook→local trust boundary — the
  same boundary the receiver's author-gate and the container hold — so it needs its own threat analysis and
  author-gate semantics for machine-initiated follow-ups before it can ship. Cross-folder chaining has the
  same shape: it reopens the arbitrary-host-path mount that forcing the child folder to the parent's own
  closes, and so wants the realpath + containment-allowlist guard stack in its own right.
- **How to answer**: Design the threat model and author-gate semantics for a machine-initiated
  GitHub-parent follow-up (who authorizes it, and how the adversarial task text stays DATA), plus the
  realpath + containment-allowlist guard for a cross-folder target; or ratify GitHub-parent and
  cross-folder chaining as permanently out of scope.
- **Blocks**: Nothing this slice — same-folder, local-parent-only chaining ships now.

---

## Retired from the source design document

`DESIGN.md` v0.1 §10 carried a ten-item "verify-on-implementation checklist". It is not reproduced here,
because most of it is now **answered** — and answered items are not open questions, they are ordinary
spec content. They live in `constitution.md`, `requirements.md`, `design.md`, and `interfaces.md` with
their evidence, with no trace back to a checklist.

Seven of those answers were **corrections**: `pi --mode print` does not exist; the mode union has no
`tui`; no max-turns exists anywhere in pi; `AGENTS.md` is not trust-gated; the persona decisions #1 and
#2 were mutually exclusive; the Dockerfile was broken for non-root; the pinned version was stale on
arrival. One resolved in our favour: the "caches roll at midnight" caveat is obsolete — 0.80.7 removed
the date from the default system prompt.

**The recurring class that the checklist could not express** — "re-verify on every pi upgrade" — is not
a question at all and does not belong in a register. It became `REQ-UPSTREAM-CONTRACT-TESTS`: a CI gate,
because a prose checklist depends on a maintainer reading it at 11pm during an upgrade, and a failing
build does not.

## Known gap

`DESIGN.md`'s header records "50 claims adversarially verified: 48 confirmed, **2 refuted**". Only one
refutation is documented in it (the pi-caveman premise correction, §5.7). **The second is never
stated.** Refutations are anti-facts — they stop a wrong design being re-derived — and this one dies
with the uncommitted document. If the maintainer can recall it, it belongs in `design.md` as a rejected
alternative. Partly academic now: source-verification subsequently found seven more errors than both
adversarial passes did.

---

## Revision History

| Date | Change |
|---|---|
| 2026-07-15 | Initial. Replaces `DESIGN.md` v0.1 §10. Collapsed from ~10 checklist items to 5 rows: source-verification at `earendil-works/pi @ 5e336cf` answered most of them. The register's value inverted in the process — from "holds ten unknowns" to "holds one known-incoming breaking change" (`OQ-005`). |
| 2026-07-16 | `OQ-005` **retracted and re-corrected** to `WATCH — NOT IN THE PIN`. The 2026-07-15 "correction" below was itself wrong: it read `sdk.ts` at `5e336cf` (**HEAD**) to describe npm `0.80.7` (**the pin**), concluded `modelRuntime` had already landed, and declared the changelog unreliable. `ModelRuntime` does not exist in `0.80.7` — no `model-runtime` in its `dist/`, not exported from `dist/index.js`. The changelog said `[Unreleased]` and was exactly right. The runner was written against the phantom API, the image built cleanly, and every job would have died on a missing export; CI caught it on the first real container run. `constitution.md`'s evidence convention now requires verification against the **published artifact**, and `pinned-api.test.mjs` asserts `ModelRuntime` is absent so the real migration fails a test instead of a job. |
| 2026-07-15 | ~~`OQ-005` corrected to **WATCH — PARTIALLY LANDED**~~ — **this entry was wrong; see above.** It claimed `modelRuntime` was already in `CreateAgentSessionOptions` at the pinned sha and that the changelog was not a reliable signal. Both false: the sha was HEAD, not the pin. Kept rather than deleted, because a spec that hides having been wrong teaches the next reader to trust it more than it deserves. |
| 2026-07-17 | Added OQ-006 recording the GitHub-auth-mechanism decision (default gh/fine-grained PAT single-owner; App mandatory multi-tenant), closed by this plan + the E1 CONST-TOKEN-SCOPED-PER-JOB amendment. |
| 2026-07-21 | Added OQ-007 (run-history retention: periodic sweep). |
| 2026-07-21 | Added OQ-008 (runtime trigger editing — cron toggle, label→flow — deferred; the admin extension ships triggers display-only). |
| 2026-07-22 | Added OQ-009 (chaining from a GitHub-job parent, and cross-folder chaining, deferred; this slice ships same-folder, local-parent-only chaining). |
