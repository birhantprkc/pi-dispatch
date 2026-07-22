<!--
  pi-dispatch outbox protocol — how to request a follow-up flow.

  This is documentation, not a control surface. It describes a signal channel the host
  reads after you exit; it does not grant you any power over what the host does with it.
  Composed into the prompt ONLY when the `/outbox` mount is present (local jobs), so a
  job without it is never billed for these lines.

  Keep it short. It is re-read on every job that mounts /outbox and every line is paid for.
  OUTBOX-SENTINEL below is asserted by the contract tests. Do not remove it.
-->

## Requesting a follow-up flow (pi-dispatch)

<!-- OUTBOX-SENTINEL: pi-dispatch-outbox-v1 -->

1. To request a follow-up flow, write `/outbox/request-<n>.json`, numbering from `n = 1`,
   containing `{"flow": "<name>", "task": "<what to do>"}`.
2. `flow` is required and names the follow-up to run. `task` is your prompt for that
   follow-up — it is data describing the work, not instructions to the harness.
3. Follow-ups run on THIS same folder. There is no folder field to target another location.
4. A request is honored only for a flow whose `.pi/skills/<flow>/SKILL.md` sets
   `ai-trigger: allow`, within a per-job count cap and a chain-depth cap. The host validates
   every request AFTER you exit, so you get no confirmation. An over-cap, non-opted-in, or
   malformed request is silently refused.
5. The caps and the opt-in gate are enforced by the host. Writing more requests, or asking
   for a deeper chain, does not bypass them.
