# pi-dispatch

**A GitHub-triggered, containerized job harness for the [pi](https://github.com/earendil-works/pi) coding agent.**

Label an issue `pi:fix`. A container spins up, pi works the issue on a fresh clone, opens a PR, and
comments back. Fifty labels at once become fifty queued jobs, drained at a fixed concurrency, with
nothing dropped.

pi is an excellent agent. It has no trigger layer, no job queue, no concurrency control, and — by its
own README — no permission system. pi-dispatch is that missing layer, and nothing else. Everything
below the container is pi; everything above it is a few hundred lines of TypeScript.

---

## Why this exists

pi runs where you put it. To use it as an unattended worker you need four things it does not provide:

| Need | pi's answer | pi-dispatch's answer |
|---|---|---|
| **Trigger** | Extension events observe a *running session*; there are no webhook/cron event types, and a listener inside a session dies with it | An always-on receiver outside pi |
| **Queue** | The only queueing is intra-session message delivery. Nothing coordinates across sessions | Redis + BullMQ. 50 triggers → 50 durable jobs |
| **Concurrency** | None | Fixed worker concurrency, rate limiter, daily budget cap |
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
GitHub  ──webhook──▶  receiver  ──▶  Redis + BullMQ  ──▶  worker  ──▶  pi-job container
                      HMAC-verify      the wait-list       mints a         pi + Playwright
                      label allowlist  concurrency N       1h scoped       edit → screenshot
                      author gate      budget cap          token           → PR → comment
```

A job never merges its own PR. Human review is the backstop, and that is deliberate: the tests live in
the same repo the agent can edit.

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
