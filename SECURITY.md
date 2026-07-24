# Security Policy

pi-dispatch executes untrusted, adversarial input through an unrestricted coding agent, on purpose.
This document states plainly what that means, what is defended, and what is not.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository (Security → Report a
vulnerability). Please do not open a public issue for a security bug.

This is a solo-maintained project. Expect an acknowledgement within a week. There is no SLA and no bug
bounty. Fixes land on `main`; there is no backport branch.

## The threat model in one paragraph

Anyone on the internet can open a GitHub issue. Its text reaches a coding agent that runs with the
permissions of its process and holds credentials. pi has **no built-in permission system** — its own
README says so, and says to containerize it. Therefore: **the container is the security boundary**, and
every other control exists to keep that boundary meaningful or to bound what a successful attack gets.

Assume the issue body will eventually say *"ignore your previous instructions."* The design question is
not whether that happens, but what it costs when it does.

**Corrected 2026-07-16 — the answer is worse than this document previously claimed.** It said the cost
was *"one wasted job budget and one garbage pull request that a human declines to merge."* That assumed
the agent's token could not merge. **It can.** See *What is NOT defended*. On a repository whose default
branch is unprotected, one successful injection is a full compromise of that repository within the hour.

## Who this is for

pi-dispatch services **repositories you control**, and folders on your own machine. The trust model is
the same as `.github/workflows/`: **whoever can merge to your default branch can instruct the agent.**
It is not built to be installed on repositories you do not trust, and doing so is outside the model
below.

Jobs are a **trigger × target** matrix, and the triggers do not share a threat model:

| Trigger | Who can start a job | Undo |
|---|---|---|
| **Webhook** — label or `@pi` comment | A collaborator. The label *is* the approval step. | Decline the PR |
| **CLI** — manual run (`pi-dispatch run`) | Whoever has shell on the host / can run the CLI | Decline the PR, or **nothing** for a folder |
| **Cron** — a schedule | **Nobody, at the time it runs.** It fires unattended. | As above |
| **AI tool** — `dispatch_run` (operator session) | Whoever can prompt-inject the operator's model | **Nothing** — it enqueues a paid run that edits a folder in place |
| **Outbox chain** — a completed job container | A completed local job's agent, after host-side validation | As the folder row above — a same-folder follow-up, no undo |

## Trust boundaries

| Zone | Trust | Why |
|---|---|---|
| Issue/comment text | **None** | Anyone can write it |
| A serviced repo's `.pi/` on the **default branch** | **Maintainer-level** | It is read into the system prompt, from a pinned SHA, on purpose — same trust as `.github/workflows/`. Only someone who can merge can change it. |
| A serviced repo's contents on **any other branch** | **None** | A fork PR can contain anything. Never read for instructions. |
| A local folder's `.pi/` | **Whatever can write that folder** | No merge gate, no reviewer, no history |
| The job container | **None** — it is the untrusted side | It runs the agent |
| A job container's `/outbox` request file | **None** — agent-authored | The container's **only** signal channel back to the host; validated host-side before anything is enqueued |
| Receiver, worker, queue, admin extension | Trusted | They never execute agent-authored content — the admin extension feeds only PII-free, fixed-enum run records to the model; raw container output stays in the overlay viewer |

## What is defended

- **Who can trigger.** Comment triggers require `author_association ∈ {OWNER, MEMBER, COLLABORATOR}`.
  Label triggers require an allowlisted label — and since only collaborators can apply labels, **the
  label is the human approval step**, not a routing hint. A stranger's issue sits until a maintainer
  labels it.
- **Webhook authenticity.** `X-Hub-Signature-256` is verified with a timing-safe comparison over the
  **raw** body, before parsing. Without this every other gate collapses, because the label and author
  checks would be reading fields from a body nobody authenticated.
- **Isolation.** One ephemeral container per job: `--cap-drop=ALL`, `--security-opt no-new-privileges`,
  memory/CPU/pids limits, non-root, `--rm`. Per-job rather than per-session, so state cannot leak
  between mutually-untrusting issue authors.
- **Credential scope.** A repo-scoped, short-lived token minted per job — a GitHub App installation
  token, or a single-owner fine-grained PAT. Its narrow scope and short expiry bound **where** and for
  **how long** an injected agent can act within that repo. See *What is NOT defended*.
- **CI integrity.** The token is minimally-permissioned — `contents` and `pull-requests`, **not**
  `workflows`, which is a separate scope. For a fine-grained PAT this is an operator-set property. An
  injected agent therefore cannot rewrite `.github/workflows/` even though it can write code. This one
  holds.
- **Branch protection is required.** The worker refuses to run against a repository whose default branch
  is unprotected, checked before any money is spent. This is the control that makes human review real
  rather than customary — without it, nothing technical stops a merge.
- **System-prompt integrity.** Jobs run with context-file discovery disabled. A cloned repo's `AGENTS.md`
  / `CLAUDE.md` are **not** trust-gated by pi and load from *every ancestor directory*, so they would
  otherwise let anyone who can land a PR write our agent's standing instructions. Project instructions
  arrive by a different route entirely: the worker reads `.pi/` from the **default branch at a pinned
  SHA**, through git's object store (not the filesystem — a symlink would otherwise pull a host file into
  the prompt), and mounts them **read-only**. The agent cannot rewrite the instructions it was given, and
  a pull request cannot change them. Baked guardrails are read from a path the project cannot influence.
- **We never merge.** No code path in this project calls a merge API; grep is the test. Note carefully
  what that does and does not mean — see below.
- **Spend.** A daily cap checked *before* tokens are spent, a per-job turn budget enforced by our runner
  (pi has no turn limit of its own), and a 30-minute container wall-clock timeout. An agent that concluded
  "I can't fix this" is a success and is never blind-retried.

## What is NOT defended (v1)

Stated openly rather than discovered later:

- **The agent's own token can merge, force-push, and delete branches — and no scope prevents it.**
  This is the sharpest thing on this page. Merging a pull request (`PUT /pulls/{n}/merge`), merging a
  branch directly (`POST /merges`), force-pushing (`PATCH /git/refs/{ref}`) and deleting a ref are **all
  gated by `contents: write`** — the *same* permission the agent needs to push the commit that is its
  entire job. GitHub offers no finer split. The container also ships `gh`. So "we never call merge" is
  true of *our* code and says nothing about what an injected agent does with a valid credential.
  **Branch protection on your default branch is the only technical barrier**, which is why the worker
  refuses to run without it. If you disable it, the honest worst case is: **one successful injection =
  full compromise of that repository within the hour**, including rewriting `.pi/` itself — which
  poisons every future job on that repo. That is standing compromise, not a one-shot.
- **Local-folder jobs have no gate and no undo.** No merge, no reviewer, no pull request to decline. The
  bar for writing the agent's standing instructions drops from "can merge to default" to "can write a
  file in that folder" — which includes anything you ever downloaded into it. If the folder is not under
  version control there is **no recovery path** from a bad run. Point this at folders you would be
  willing to restore from backup.
- **Scheduled jobs run unattended, and the queue's double-spend protection does not cover them.** A job
  produced by a scheduler is **exempt** from BullMQ's stalled-job limit for as long as that scheduler
  exists: a wedged run is re-processed — and re-paid — on every stall, indefinitely. Our per-job turn
  budget is the real backstop there, not the queue. Cron multiplies every other risk on this page by
  removing the human who would have noticed.
- **Network egress from the job container is unrestricted.** There is no allowlist proxy in v1. A job
  can reach the internet. If an agent is successfully induced to exfiltrate its environment, egress
  filtering will not stop it — the token's short expiry and narrow scope are what bound the damage. Run this on
  hardware where that is acceptable, or put an egress policy on the Docker network yourself.
- **The provider API key is broad.** Unlike the GitHub token it cannot be meaningfully scoped per job —
  the agent needs it to function. It is the one broad secret inside the container. **Set a spend limit
  on it.**
- **Captured job logs can contain issue and comment text (PII).** By default the worker writes only an
  id-only status record per job — `logs/<jobId>.json`, keyed on stable ids (the delivery GUID,
  `repo#issue`) and never on issue or comment bodies. With `PI_CAPTURE_JOB_LOGS=1` (opt-in, **off by
  default**) it also tees the container's raw stdout/stderr to `logs/<jobId>.log`, and that stream **can**
  carry issue/comment text. Both live host-side under `PI_LOGS_DIR`, are **never mounted into the job
  container**, and are **gitignored**; a boot-time sweep prunes them (`PI_LOG_RETENTION_DAYS`, `0` = keep
  forever). Leave capture off unless you need it, and treat the log directory as personal data while it is on.
- **Prompt injection is not prevented, only bounded.** Untrusted text is kept out of the trusted region
  of the prompt by *placement*, not by filtering — content-filtering natural language is not a security
  boundary and this project does not pretend otherwise. The bound is the container, the scoped token,
  branch protection, and the human merge gate.
- **A project's own instructions can argue with the guardrails.** The baked safety floor cannot be
  *deleted* from the prompt — that is asserted by a test. It can be *contradicted* by a project persona,
  because prompt ordering is not an enforcement mechanism. This is the same honesty as the point above:
  what stops a merge is branch protection, not a sentence telling the agent not to.
- **The host Docker daemon is trusted, and so is the worker.** A container escape is a full compromise.
  The worker drives the Docker CLI, so a compromise of the worker process — or of its dependency tree —
  is root-equivalent on the host. The worker never reads issue text (that is the agent's job, in the
  container), so this is a supply-chain risk, not an injection one. Keep Docker patched; do not run this
  on a host you care about.
- **No multi-tenancy.** This is a single-operator tool. Nothing isolates one operator's jobs from
  another's, because there is only meant to be one.
- **An agent that can write a folder can self-authorize a flow by committing to it.** Making a flow
  AI-triggerable is a committed `ai-trigger: allow` in the folder's `.pi/`, so an agent that can write the
  folder can commit that opt-in, after which a **later** operator or CLI action could run that flow. This
  is bounded by the local trust model — "whatever can write the folder can trigger it" — and by the
  **pre-agent SHA** the gate reads at: the SHA forecloses self-authorization within the **same** job and
  its own children, but it does **not** stop a later operator or CLI run of the planted flow. Both halves
  hold; neither is undo.
- **A prompt injection in the operator's session can invoke `dispatch_run` — a paid run with no undo, and
  it is NOT money-safe.** `dispatch_run` is a **third** model-callable tool alongside reads and
  `pause`/`resume`, and unlike them it spends money editing a folder in place with no undo — an explicit
  break from the pause/resume "money-safe" framing that governs the other tools. It is bounded in
  blast-radius, not prevented, by **six** independent limits: the folder allowlist `PI_DISPATCH_RUN_ROOTS`
  (realpath + containment); the committed per-flow opt-in (default deny, read at a pre-agent SHA); the
  dirty-tree refusal (no force option); no spend-knob parameters on the tool; a per-hour rate limit; and
  the daily cap (`CONST-BUDGET-BEFORE-TOKENS`). Do not read it as money-safe or reversible — it is neither.

## Operator responsibilities

- **Protect your default branch.** Require a pull-request review, forbid force-pushes. This is not a
  suggestion — it is the only technical control standing between an injected agent and your `main`. The
  worker refuses to run without it, and you should not work around that.
- Set a provider spend limit and a daily job cap.
- Do not blanket-forward host environment into job containers. Pass only the variables the configured
  provider needs. In particular `ANTHROPIC_OAUTH_TOKEN` silently takes precedence over
  `ANTHROPIC_API_KEY`, so a stray variable in the host environment can quietly redirect which credential
  a job spends.
- **`PI_AUTH_FROM_PI` sources the provider key from pi's `~/.pi/agent/auth.json` when the env has none.**
  It is a host-side read env-injected into the container — never a credential file mounted in — and accepts
  **API-key** logins only; an OAuth/subscription login is refused. Prefer an API key with a provider-side
  spend limit for an unattended service; a subscription token is neither refreshable in the container nor
  intended for automation.
- **Treat `.pi/` on your default branch as production code**, because it is: it goes into the agent's
  system prompt. Review changes to it with the same care as `.github/workflows/`.
- **The global pi overlay (`PI_GLOBAL_PI_DIR`) is production code too**, and it must be credential-free. It
  is mounted `:ro` into every job — a container that runs adversarial input — so a secret in it is a secret
  in the box. Stage it with `pi-dispatch import-pi` (it refuses a `models.json` with a literal key and never
  copies `auth.json`) and let `pi-dispatch doctor` re-check it; the provider key belongs in the environment,
  never a mounted file. Overlay **extensions run arbitrary code against adversarial input with open network
  egress** and are not scanned for secrets: keep `PI_GLOBAL_ALLOW_EXTENSIONS` unset until you have vetted
  every one, and never place the admin extension in the overlay (it can enqueue paid jobs — a recursion
  vector; `import-pi` blocks it).
- **The admin surface is not a network service.** It is a pi extension in your own terminal session plus
  a `settings.json` file — it binds no port. Whoever can run pi with the extension loaded, or write
  `PI_SETTINGS_FILE`, holds operator power: the same trust as shell access on the host. Treat it that way.
  It is operator-present, processes no adversarial input, and holds no harness credentials — which is why
  pi running here is scoped out of the container-per-job constraint. Raw job logs are untrusted container
  output, and the extension never routes them into model context.
- Review every PR. Automation opens them; it does not land them.
- Point local-folder jobs only at folders you can restore.
- Keep the pinned pi version current, and let the upgrade tests gate the bump.
