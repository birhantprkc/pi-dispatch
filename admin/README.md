<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/banner.png" alt="pi-dispatch — run the pi coding agent as a self-hosted service" width="880">
</p>

# @edgehero/pi-dispatch-admin

**The operator console for [pi-dispatch](https://github.com/edgehero/pi-dispatch) — run the [pi](https://github.com/earendil-works/pi) coding agent as a self-hosted service, and drive the whole thing from `/dispatch`.**

pi is a superb coding agent, but it has no job queue, no spend limit, and — by its own README — no permission system. **pi-dispatch** is the operational layer that adds them: every job runs in an ephemeral, container-isolated box; spend is capped *before* a single token is spent; and the same job runs whether you trigger it from the CLI, a cron schedule, or a GitHub issue. **This package is the pi extension you install to run that deployment.**

> **Companion, not standalone.** It reads your pi-dispatch deployment's queue and run history — point it at yours with `VALKEY_URL`, `PI_LOGS_DIR`, and friends. On its own it just says "queue unreachable."

## `/dispatch` — the whole deployment in one command

- **Live panel.** Queue and worker state, day/week/month **spend meters** + a daily token counter, and a run-history table with per-job token & cost.
- **Triggers, editable in place.** cron / label / comment / pull_request, with colored drill-ins showing what fires each one, what it runs, and its trust model — added, edited, and deleted live, no restart.
- **Scheduled pause windows.** "Quiet hours" per folder or repo: defer a scope's runs **between certain times** — recurring daily, weekday- and date-bounded, timezone-aware — and resume automatically. Deferred, never dropped, at zero budget cost.
- **AI-operable, with a human gate.** Model-callable tools let an agent change limits and manage triggers and pause windows — but **every write pops an operator confirmation the model can't answer**, and is refused when no operator is present. The bundled `operate-pi-dispatch` skill teaches the agent to use those gates.
- **Logs stay put.** Raw container output renders only in the overlay viewer, never into model context.

## Why run pi this way

- **The container is the boundary.** Every job is ephemeral, `--cap-drop=ALL`, non-root, instructions mounted read-only. That's pi's missing permission system, enforced by Docker.
- **Spend is bounded before tokens.** A per-job turn budget plus daily/weekly/monthly caps, checked before a container even starts. A runaway costs you a refusal, not a bill.
- **Three triggers, one job.** CLI, cron, or a GitHub issue/PR — same queue, same box, same budget. Cron is the unattended one: recurring work on your own hardware, in an image you control.

## Install

```bash
pi install npm:@edgehero/pi-dispatch-admin
```

Then run pi and open `/dispatch`. Set `VALKEY_URL` / `PI_LOGS_DIR` / `PI_SETTINGS_FILE` / `PI_TRIGGERS_FILE` / `PI_PAUSE_WINDOWS_FILE` to match your deployment.

## The service

The queue, worker, container image, and GitHub receiver live in the main repo — **start there:** **https://github.com/edgehero/pi-dispatch**. MIT, self-hosted. Read [`SECURITY.md`](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md) before you rely on it — it states plainly what is and isn't defended.
