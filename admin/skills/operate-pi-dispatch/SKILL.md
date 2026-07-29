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
- `dispatch_pause_add` / `dispatch_pause_edit` / `dispatch_pause_delete` — manage scheduled pause windows
  (per folder/repo "quiet hours": runs for a scope are deferred between certain times and auto-resume after;
  `dispatch_pauses` lists them with their index). `dispatch_pause_edit` is a partial change — pass the index
  plus only the fields to alter. Deferring never drops a job and costs no budget.

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

## Staged packages — `run.packages`, and why you cannot set it

When a trigger fires, the job loads the third-party **pi packages the operator staged** into their global
overlay dir (`PI_GLOBAL_PI_DIR`, under `packages/`, pinned by version). `run.packages` is an **opt-out**:
absent and `true` both load them, and only an explicit `run.packages: false` withholds them from that one
trigger. So the question to answer for a user is never "is this trigger armed" — it is "did this trigger
decline".

It matters because a loading trigger runs pinned third-party code against adversarial input (issue/PR/comment
text) with open network egress. So the panel makes it visible: a loading trigger is badged `[packages]` in
the trigger list, and its trust-model drill-in names the staged `name@version` set.

**Which packages are staged, and whether a trigger declines them, are both operator edits to reviewed files
— never a panel action and never a tool call.** This is deliberate, not a gap:

- `dispatch_triggers` shows you *whether* a trigger loads them. The `/dispatch` panel displays it too, and
  has no key that sets it.
- `dispatch_trigger_add` and `dispatch_trigger_edit` **have no `packages` parameter**. You can change it in
  neither direction — you cannot make a trigger load packages and you cannot make one decline them — the
  same reason `dispatch_run` withholds the provider and model from you.

So if a user asks you to change a trigger's packages flag, or to stage a package: **say plainly that you
cannot, and that it is an edit they make to `triggers.json` (and to their overlay dir) themselves.** Do not
attempt it through `dispatch_trigger_edit`, do not write the triggers file by another route, and do not treat
the missing parameter as a bug to work around. Reporting which triggers load the staged set and explaining
the change they would make is the whole of your part.
