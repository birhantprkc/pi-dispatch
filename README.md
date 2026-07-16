# pi-dispatch

**Run the [pi](https://github.com/earendil-works/pi) coding agent, in a container, against your own
folders — on your own machine or server.**

> `pi-dispatch` below is `npx pi-dispatch` from the repo (a workspace bin); or `npm link` it onto your PATH.

Point it at a project folder, give it a task, and pi does the work inside a locked-down container:

```
npx pi-dispatch run ./my-project --task "dedupe the imports in src/" --flow tidy
```

pi is an excellent agent. It has no job queue, no concurrency control, no spend limit, and — by its own
README — no permission system. pi-dispatch is that missing layer, and nothing else: a durable queue, a
per-job container boundary, a turn budget, and a daily spend cap. Everything below the container is pi;
everything above it is a few hundred lines of code.

**Your project tells the agent what to do**, using pi's own layout — `.pi/APPEND_SYSTEM.md` for the
persona, `.pi/skills/<name>/SKILL.md` for skills. Not a format we invented; pi's native skills, read
from your committed files. pi-dispatch ships no persona of its own — only a small, immutable safety floor
baked into the image that your instructions add to and cannot remove.

---

## Quickstart (local folders)

You need **Docker** and **Node ≥ 22.19**, and a provider API key (e.g. Anthropic).

```bash
# 1. Build the job image (once)
docker build -f image/Dockerfile -t pi-job:latest .

# 2. Start Valkey (the durable job queue)
docker compose -f deploy/docker-compose.yml up -d

# 3. Configure
cp .env.example .env         # then set ANTHROPIC_API_KEY (or your provider's key)
npm ci

# 4. Run the worker in one terminal
npx pi-dispatch worker       # (or: npm --workspace worker start)

# 5. Queue a job from another
npx pi-dispatch run ./my-project --task "add type hints to utils.py" --flow tidy
```

The worker picks up the job, mounts your folder into a container, and pi edits it **in place**. It
refuses a dirty git working tree unless you pass `--force`, because there is no undo — point it at
folders you can restore, and commit first.

## What runs, and what protects you

```
pi-dispatch run ── enqueue ──▶ Valkey + BullMQ ──▶ worker (on your host)
                               the wait-list          budget check (before any spend)
                                                      docker run: one ephemeral container
                                                          │  --cap-drop=ALL, non-root, no new privileges
                                                          │  /job read-only, /workspace = your folder
                                                          ▼
                                                      pi + Playwright + git + gh
                                                      guardrails + your .pi/  →  edits your folder
```

- **The container is the security boundary.** pi has no permission system, so every job runs
  `--cap-drop=ALL`, non-root, ephemeral, with your instructions mounted read-only. The agent cannot
  rewrite its own guardrails or reach your host.
- **Spend is bounded twice.** A per-job **turn budget** (pi has none of its own) and a **daily cap**
  checked *before* a container starts, so a runaway can't quietly burn your API budget. Also set a spend
  limit on the API key itself.
- **Nothing is dropped.** Fifty jobs at once become fifty queued jobs, drained at a fixed concurrency
  (default 3). Valkey persists them across a reboot.

Read [`SECURITY.md`](SECURITY.md) before you rely on it — it states plainly what is and is not defended.

## Advanced: GitHub automation *(in progress)*

pi-dispatch can also be triggered by GitHub — label an issue, and a container works it on a fresh clone,
opens a PR, and comments back. This path needs a **GitHub App** and is **not yet built** in this
repository; the local-folder path above is complete. When it lands:

- Only a collaborator's label or `@pi` comment starts a job (the label *is* the approval step).
- The agent gets a **1-hour, single-repo token** — and, honestly: that token *can* merge, because GitHub
  gates push and merge behind the same `contents: write` scope. **Branch protection on your default
  branch is the real control**, so the worker will refuse an unprotected repo. `SECURITY.md` has the
  detail.
- A separate **admin panel** on `127.0.0.1` (never on the internet-facing receiver) will turn the queue
  on/off, show jobs, and set the model/budgets. It will not edit your persona or skills — those live in
  your project's `.pi/`, in git, reviewed.

## Should you use this instead of the Claude Code GitHub Action?

For GitHub automation, often no — and you should know that up front.
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) (MIT, ~8.4k stars) is
GA and does label-triggered issue automation for 10% of the effort. pi-dispatch is for a narrower case:
**you run pi, on your own hardware, and you want a real queue, a container boundary, and — the part the
action can't do — to run flows against local folders**, not just GitHub repos, without hosted-runner
minutes.

## Status

The local-folder path (image, worker, `pi-dispatch run` / `worker`) is built and works. The GitHub
webhook path, the admin panel, and scheduled (cron) triggers are in progress. The design is specified in
[`specs/`](specs/) — start with [`specs/constitution.md`](specs/constitution.md) for the non-negotiables
and [`specs/design.md`](specs/design.md) for the decisions and what was rejected.

## Contributing

PRs welcome. Sign off your commits (`git commit -s`) — this project uses the
[DCO](https://developercertificate.org/), not a CLA. If you change behaviour, the spec changes with it:
`specs/` is the source of truth, and a PR that violates a `CONST-*` entry will be asked to justify the
constraint first, not the code.

## License

MIT. See [LICENSE](LICENSE). Built on [pi](https://github.com/earendil-works/pi) by Mario Zechner, which
does the actual hard part.

> **Not affiliated with** the unrelated npm package `pi-dispatch`, a pi extension for rotating ChatGPT
> Codex OAuth accounts. Same name, different thing — this project is not distributed via npm.
