---
name: operate-pi-dispatch
description: How to operate a pi-dispatch deployment through its tools, and how to use the operator-confirm gates on the write tools (changing limits, adding/editing/deleting triggers).
---

# Operating pi-dispatch

pi-dispatch is a queue that runs paid autonomous agent jobs. The admin extension exposes tools to observe
and operate a deployment. Some tools only read; some turn processing on and off; some change money-affecting
configuration and are gated behind a human confirmation.

## The tools

Observe (no approval needed):
- `dispatch_status` — queue/worker state, today's budget, settings overlay, schedulers.
- `dispatch_runs` — recent run records (PII-free). Raw job logs are never available to tools.
- `dispatch_triggers` — the configured triggers with their array `index` (needed to edit/delete one).

Control (no approval needed — reversible and money-safe):
- `dispatch_pause` — stop starting new jobs (running ones finish). This is "turn dispatch off".
- `dispatch_resume` — re-enable processing. This is "turn dispatch on".

Start a run (paid, already gated producer-side):
- `dispatch_run` — enqueue one agent run against an allowlisted local folder.

## The human confirm gates — how to use them

These tools change money-affecting configuration and **each one asks the operator to approve a confirmation
dialog before it takes effect**:
- `dispatch_set` — change a limit/setting (e.g. `dailyCap`, `weeklyCap`, `maxTurns`, `model`). Omit `value`
  to unset.
- `dispatch_trigger_add` / `dispatch_trigger_edit` / `dispatch_trigger_delete` — manage triggers.
- `dispatch_pause_add` / `dispatch_pause_delete` — manage scheduled pause windows (per folder/repo "quiet
  hours": runs for a scope are deferred between certain times and auto-resume after; `dispatch_pauses` lists
  them). Deferring never drops a job and costs no budget.

Use them like this:

1. **State the change in plain language first**, with the concrete before→after, so the operator reading the
   confirm dialog knows exactly what they are approving (e.g. "I'll raise the daily cap from 25 to 30 — that
   allows more paid jobs per day").
2. **Call the tool.** The operator sees a confirm dialog with the exact change and approves or declines. You
   do not answer it — only the human does.
3. **Respect the answer.** If the result is `applied: false` (`reason: "operator declined"`), the operator
   said no. Accept it and stop — do **not** retry the same change, rephrase it to get a yes, or try to route
   around the confirm. If you believe the change is still needed, explain why and let the operator decide.
4. **If a tool is refused because no interactive operator is available** (headless/print mode), report that
   the change can't be made without an operator at the terminal — it is not a bug to work around.

The confirm is the approval step. Treat a decline as a final, legitimate answer.
