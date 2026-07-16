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
  on exfiltration is `CONST-TOKEN-SCOPED-PER-JOB`'s one-hour expiry, not network policy.
- **Why it is a risk row and not a constraint**: the source design doc listed egress allowlisting as
  security "layer 4" while also saying v1 ships without it. **A constraint that ships unenforced is worse
  than an honest open risk** — it teaches readers that the constitution is aspirational, which corrodes
  every other entry in it. So it lives here, and `SECURITY.md` states it plainly under "what is NOT
  defended".
- **What would close it**: an allowlist proxy (`api.anthropic.com`, `github.com`,
  `registry.npmjs.org`) on a dedicated Docker network. At that point it graduates to a `CONST-`.
- **Needs**: maintainer ratification that shipping v1 this way is acceptable.

## OQ-005 — pi's `modelRuntime` migration: partly landed at the pin, rest still incoming

- **Status**: **WATCH — PARTIALLY LANDED**
- **Not a question — a scheduled landmine, and it is already half-detonated.** pi's changelog carries the
  breaking change under `[Unreleased]`: `authStorage` and `modelRegistry` *replaced* by an async
  `modelRuntime`.
- **Correction (2026-07-15)**: **`modelRuntime` is already present in `CreateAgentSessionOptions` at the
  pinned sha**, and `createAgentSession` itself already does
  `options.modelRuntime ?? (await ModelRuntime.create({authPath, modelsPath}))`. So the migration is not
  pending arrival — part of it has shipped inside the version we pin, while the changelog still files it
  under `[Unreleased]`. **The changelog is not a reliable signal for when this lands**, which is the same
  lesson as the evidence convention in `constitution.md`: read `sdk.ts`, not the release notes. The
  runner is written against `modelRuntime` from day one rather than against the older wiring, so the
  remaining migration should be additive for us rather than breaking.
- **Why it cannot be a test**: `REQ-UPSTREAM-CONTRACT-TESTS` gates *our* assumptions against a *pinned*
  version, and it will catch the rest the moment the pin moves. But you cannot test for a change that has
  not shipped. This row is the one thing a human must actually read source for.
- **Action on release**: re-verify the `sdk.ts` option set at the new version before bumping the pin.
  Specifically: whether `model` remains a `Model<any>` obtained from `modelRuntime.getModel()`, and
  whether `authPath`/`modelsPath` are still derived only when `agentDir` is passed.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → CHANGELOG.md:5-10` (`[Unreleased]`) ·
  `→ packages/coding-agent/src/core/sdk.ts:33-80` (`modelRuntime?: ModelRuntime` **present**) ·
  `→ sdk.ts:171` (async `ModelRuntime.create`) · `→ model-runtime.ts:293 → getModel`

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
| 2026-07-15 | `OQ-005` corrected to **WATCH — PARTIALLY LANDED**. `modelRuntime` is **already in `CreateAgentSessionOptions` at the pinned sha**, while pi's changelog still files the migration under `[Unreleased]`. The row previously said it "will break" wiring; part of it had already shipped inside the version we pin. **The changelog is not a reliable signal for when this lands** — the same lesson as the evidence convention, one layer out: release notes are docs too. Mitigation is favourable: the runner is written against `modelRuntime` from day one, so the remainder should be additive rather than breaking. |
