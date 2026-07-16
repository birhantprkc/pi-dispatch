# pi-dispatch

**A containerized job harness for the [pi](https://github.com/earendil-works/pi) coding agent — triggered
by GitHub, by a schedule, or by you.**

Label an issue `pi:fix`. A container spins up, pi works the issue on a fresh clone, opens a PR, and
comments back. Fifty labels at once become fifty queued jobs, drained at a fixed concurrency, with
nothing dropped.

pi is an excellent agent. It has no trigger layer, no job queue, no concurrency control, and — by its
own README — no permission system. pi-dispatch is that missing layer, and nothing else. Everything
below the container is pi; everything above it is a few hundred lines of TypeScript.

**Your project tells the agent what to do**, using pi's own layout — `.pi/APPEND_SYSTEM.md` for the
persona, `.pi/skills/<name>/SKILL.md` for the flows. Not a format we invented; pi's native skills, read
from your default branch at a pinned commit. pi-dispatch ships no persona of its own — only a small,
immutable safety floor baked into the image that your instructions add to and cannot remove.

---

## Why this exists

pi runs where you put it. To use it as an unattended worker you need four things it does not provide:

| Need | pi's answer | pi-dispatch's answer |
|---|---|---|
| **Trigger** | Extension events observe a *running session*; there are no webhook/cron event types, and a listener inside a session dies with it | An always-on receiver outside pi, plus schedules and manual runs |
| **Queue** | The only queueing is intra-session message delivery. Nothing coordinates across sessions | Valkey + BullMQ. 50 triggers → 50 durable jobs |
| **Concurrency** | None | Fixed worker concurrency, rate limiter, daily budget cap |
| **Spend control** | **None whatsoever** — the agent loop is a bare `while (true)` bounded only by an abort signal; there is no max-turns, step limit or iteration cap anywhere in pi | A turn budget in the runner that aborts at N |
| **Isolation** | *"Pi does not include a built-in permission system… If you need stronger boundaries, containerize or sandbox Pi."* | One ephemeral container per job |

That last row is not a nice-to-have. GitHub issue text is untrusted, adversarial input, and it drives
an unrestricted agent holding your credentials. **The container is the security model**, not hardening
on top of one.

## Should you use this instead of the Claude Code GitHub Action?

Often, no — and you should know that before you install anything.

[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) (MIT, ~8.4k stars)
already does label-triggered issue automation, is GA, and is 90% of this for 10% of the effort. If it
fits, use it.

pi-dispatch is for a narrower case: **you run pi, on your own hardware, and you want a real queue and a
container boundary.** You want to choose the model and control the browser environment. You do not want
your automation metered by hosted-runner minutes. If that is not you, the action is the better tool.

## How it works

```
 TRIGGER                             TARGET
 ───────                             ──────
 webhook   label / @pi comment  ┐
 panel     you, manually        ├──▶  a GitHub repo   → clone → branch → PR → comment
 cron      a schedule           ┘     a local folder  → edited in place

        │
        ▼
 receiver ──▶ Valkey + BullMQ ──▶ worker ──▶ pi-job container
 HMAC-verify   the wait-list       branch-protection check    pi + Playwright + gh
 label gate    concurrency N       budget cap (before spend)  guardrails + your .pi/
 author gate   dedup + schedules   1h single-repo token       edit → screenshot → PR
```

Run it with `npm start` plus Docker for Valkey and the job containers. The worker drives the `docker`
CLI directly — which is what lets a local folder on Windows, macOS or Linux be mounted into a job
without any path guesswork.

**pi-dispatch never merges a pull request.** Note the honest version of that promise: no code here calls
a merge API, but the agent's own token *can* — GitHub gates push and merge behind the same `contents:
write` scope, with no finer split. **Branch protection on your default branch is the real control**, so
the worker refuses to run without it. Read [`SECURITY.md`](SECURITY.md) before you decide that is fine.

## The panel

A small local UI on `127.0.0.1`, separate from the webhook receiver — deliberately, since the receiver
has to face the internet and the panel must not. It turns the queue on and off, shows what is waiting
and what failed, sets the model, concurrency, turn budget, daily cap and schedules, and runs a flow
against a folder on demand.

It does **not** edit your persona or your skills. Those live in your project's `.pi/`, in git, reviewed —
because a UI that rewrites what a paid agent is told, with no history and no review, is a worse version
of a commit.

## Burst behaviour

Fifty triggers, concurrency 3, ~10 minutes per job → the queue drains in about 2.8 hours. **That is the
wait-list working, not a failure.** The alternative — dropping triggers past a shallow queue depth, or
running fifty agents at once — is worse in both directions: one loses work, the other loses money.

## Cost

Every job is a real autonomous agent run against a paid API. Assume real money per job and set:

- a **daily job cap** (enforced *before* tokens are spent, so a junk-trigger storm costs nothing);
- a **turn budget** in the runner (pi has no max-turns of its own — the harness must impose one);
- a **spend limit on your API key**, which is the one broad secret a job container has to hold.

## Status

Early. The design is specified in [`specs/`](specs/) — start with
[`specs/constitution.md`](specs/constitution.md) for the non-negotiables and
[`specs/design.md`](specs/design.md) for the decisions and what was rejected.

## Security

It executes untrusted input by design. Read [`SECURITY.md`](SECURITY.md) before deploying it, including
what is explicitly **not** defended in v1.

## Contributing

PRs welcome. Sign off your commits (`git commit -s`) — this project uses the
[DCO](https://developercertificate.org/), not a CLA.

If you change behaviour, the spec changes with it. `specs/` is the source of truth; the constitution's
`CONST-*` entries are non-negotiable and a PR that violates one will be asked to justify the constraint
first, not the code.

## License

MIT. See [LICENSE](LICENSE).

Built on [pi](https://github.com/earendil-works/pi) by Mario Zechner, which does the actual hard part.

> **Not affiliated with** the unrelated npm package `pi-dispatch`, a pi extension for rotating ChatGPT
> Codex OAuth accounts. Same name, different thing — this project is not distributed via npm.
