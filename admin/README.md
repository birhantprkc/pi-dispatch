<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/banner.png" alt="pi-dispatch — run the pi coding agent as a self-hosted service" width="880">
</p>

# @edgehero/pi-dispatch-admin

The **operator console** for [**pi-dispatch**](https://github.com/edgehero/pi-dispatch) — a
[pi](https://github.com/earendil-works/pi) extension that adds a `/dispatch` command (a live TUI overlay +
model-callable tools) for running the pi coding agent as a self-hosted service.

> This is a **companion** to a running pi-dispatch deployment. It reads that deployment's Valkey queue and
> run-history — install it in your own pi, alongside the pi-dispatch service. On its own it will show
> "queue unreachable".

## What it gives you

- A `/dispatch` overlay: live queue state, day/week/month **spend meters** + a daily token counter, run
  history with per-job token & cost, and a unified **triggers** pane (cron / label / comment / pull_request).
- **Editable** triggers and **scheduled pause windows** ("quiet hours" per folder/repo), applied live.
- **Confirm-gated** model tools so an agent can operate the deployment (change limits, manage triggers/pauses)
  with **a human approving each change** — fail-closed when no operator is present.
- The bundled `operate-pi-dispatch` **skill** documenting those human-in-the-loop gates.

## Install

```bash
pi install npm:@edgehero/pi-dispatch-admin
```

Then run pi and use `/dispatch`. Point it at your deployment with `VALKEY_URL` / `PI_LOGS_DIR` /
`PI_SETTINGS_FILE` / `PI_TRIGGERS_FILE` / `PI_PAUSE_WINDOWS_FILE` (the same values your pi-dispatch worker uses).

## The service

The queue, worker, container image, and GitHub receiver live in the main repo:
**https://github.com/edgehero/pi-dispatch** — start there. MIT. Read
[`SECURITY.md`](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md) before you rely on it.
