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
not whether that happens, but what it costs when it does. The intended answer: **one wasted job budget
and one garbage pull request that a human declines to merge.**

## Trust boundaries

| Zone | Trust | Why |
|---|---|---|
| Issue/comment text | **None** | Anyone can write it |
| A cloned third-party repo's contents | **None** | Anyone who can land a PR there controls it |
| The job container | **None** — it is the untrusted side | It runs the agent |
| Receiver, worker, queue | Trusted | They never execute agent-authored content |

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
- **Credential scope.** A GitHub App installation token minted per job: one repository, one hour. The
  expiry *is* the blast-radius bound for the case where an agent is induced to exfiltrate its
  environment.
- **System-prompt integrity.** Jobs run with `--no-context-files`. A cloned repo's `AGENTS.md` /
  `CLAUDE.md` are **not** trust-gated by pi and would otherwise be auto-loaded into the system prompt —
  letting anyone who can land a PR in a serviced repo write our agent's standing instructions. The
  prompt inputs are mounted read-only, so the agent cannot rewrite the instructions it was given.
- **No automatic merge.** Ever, including on green CI — the tests live in the same repository the agent
  is allowed to edit. Human review is the last line and is not optional.
- **Spend.** A daily cap checked *before* tokens are spent, plus a per-job turn budget. An agent that
  concluded "I can't fix this" is a success and is never blind-retried.

## What is NOT defended (v1)

Stated openly rather than discovered later:

- **Network egress from the job container is unrestricted.** There is no allowlist proxy in v1. A job
  can reach the internet. If an agent is successfully induced to exfiltrate its environment, egress
  filtering will not stop it — the scoped token's one-hour expiry is what bounds the damage. Run this on
  hardware where that is acceptable, or put an egress policy on the Docker network yourself.
- **The provider API key is broad.** Unlike the GitHub token it cannot be meaningfully scoped per job —
  the agent needs it to function. It is the one broad secret inside the container. **Set a spend limit
  on it.**
- **Prompt injection is not prevented, only bounded.** Untrusted text is kept out of the trusted region
  of the prompt by *placement*, not by filtering — content-filtering natural language is not a security
  boundary and this project does not pretend otherwise. The bound is the container, the scoped token,
  and the human merge gate.
- **The host Docker daemon is trusted.** A container escape is a full compromise. Keep Docker patched;
  do not run this on a host you care about.
- **No multi-tenancy.** This is a single-operator tool. Nothing isolates one operator's jobs from
  another's, because there is only meant to be one.

## Operator responsibilities

- Set a provider spend limit and a daily job cap.
- Do not blanket-forward host environment into job containers. Pass only the variables required. In
  particular `ANTHROPIC_OAUTH_TOKEN` silently takes precedence over `ANTHROPIC_API_KEY`, so a stray
  variable in the host environment can quietly redirect which credential a job spends.
- Review every PR. Automation opens them; it does not land them.
- Keep the pinned pi version current, and let the upgrade tests gate the bump.
