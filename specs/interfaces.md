# Interfaces

The five contracts that cross a process or container boundary. These are the seams where a mistake is
expensive, because both sides ship separately and nothing type-checks across the gap.

Note what makes this file worth having at a project this size: **these cross a trust boundary, not just
a process boundary.** The container is the untrusted side. Two of these contracts are the *mechanism* by
which a constitutional constraint is enforceable rather than aspirational, and one of them fails
completely silently.

There is deliberately **no data-design document**: there is no database. Redis holds BullMQ's schema,
which is BullMQ's to specify, not ours.

Evidence convention as in `constitution.md`.

---

## INT-SDK-SESSION-OPTIONS

**runner → pi SDK.** The most valuable block in this file — the only contract here that fails
*invisibly*.

- **Contract**:
  ```typescript
  createAgentSession({
    model: getModel("anthropic", "<pinned>"),
    sessionManager: SessionManager.inMemory(),
    appendSystemPromptOverride: (base) => [...base, perFlowText],
  })
  ```
  **`appendSystemPrompt` is forbidden.** The smoke path is `pi -p`, **not** `pi --mode print` — that
  does not exist; `--mode` accepts `text|json|rpc` only. The internal mode union is
  `interactive|print|json|rpc` — there is no `tui`.
- **Why**: `appendSystemPrompt` **replaces** file discovery rather than composing with it, silently
  dropping the persona baked at `~/.pi/agent/APPEND_SYSTEM.md`. No error, no warning, the job succeeds,
  and the only symptom is an agent that quietly ignores its standing rules. `appendSystemPromptOverride`
  receives the discovered content as `base` and is the only path that preserves both. This is written
  down rather than left as a code comment precisely because nothing at runtime will ever tell you it
  broke — see `REQ-UPSTREAM-CONTRACT-TESTS`.
  `SessionManager.inMemory()` because the container is ephemeral: session storage would write to a
  filesystem that is about to cease existing.
  The complete option set is `cwd`, `agentDir`, `modelRuntime`, `model`, `thinkingLevel`, `scopedModels`,
  `noTools`, `tools`, `excludeTools`, `customTools`, `resourceLoader`, `sessionManager`,
  `settingsManager`, `sessionStartEvent` — note `appendSystemPromptOverride` is a *resource-loader*
  option, not a session option.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → packages/coding-agent/src/core/sdk.ts:33-80`
  (option set) · `→ resource-loader.ts:480-482` (the `??`) · `→ resource-loader.ts:156`
  (`appendSystemPromptOverride`) · `→ session-manager.ts:1479 → static inMemory()` ·
  `→ args.ts:10 → type Mode = "text" | "json" | "rpc"` · `→ args.ts:140` (`--print`/`-p` is a separate
  boolean) · `→ project-trust.ts:12` (`AppMode`)
- **Traces to**: `DES-PERSONA-VIA-APPEND-SYSTEM-MD`, `CONST-PERSONA-IN-CACHED-PREFIX`,
  `REQ-UPSTREAM-CONTRACT-TESTS`, `OQ-005`
- **Acceptance**: The assembled system prompt contains both the persona sentinel and the per-flow
  sentinel.

## INT-RUNNER-EXIT-CODE-PROTOCOL

**container → worker.**

- **Contract**:
  | Code | Meaning | Queue behaviour |
  |---|---|---|
  | `0` | Agent completed — **including** concluding "I cannot fix this" | Success. Never retried |
  | `1` | Infrastructure failure (container died, network, provider 5xx/429) | Retryable |
  | `2` | Budget or policy refusal (cap exhausted, turn budget hit) | Not retried |
- **Why**: This exit code **is** the mechanism `CONST-RETRY-INFRA-ONLY` is implemented by. The worker
  has no other channel to distinguish "the agent ran and said no" from "the container died" — collapse
  them and you either burn money blind-retrying determinate outcomes, or you silently swallow real infra
  failures as if the agent had decided something. The counter-intuitive part is load-bearing: **`0` on
  "can't fix"** is correct, because from the queue's perspective the work was done. The agent's verdict
  is the product, not the failure.
- **Traces to**: `CONST-RETRY-INFRA-ONLY`, `REQ-RUNNER-TURN-BUDGET`, `REQ-JOB-STATUS-COMMENTS`
- **Acceptance**: Given a runner that exits 0 after concluding no fix is possible, the job records
  success and does not re-run.

## INT-CONTAINER-JOB-INPUTS

**worker → container.**

- **Contract**: `/job` mounted **read-only**, containing `prompt.md` (flow + issue payload) and
  `event.json` (raw payload). `/workspace` is the only writable mount. **The persona is baked into the
  image**, not mounted.
- **Why**: Read-only because the container is the **untrusted side**. The agent must not be able to
  rewrite the instructions it was handed — that filesystem permission is what makes
  `CONST-ISSUE-TEXT-IS-DATA` *enforceable* rather than merely asked-for. The persona is baked rather than
  mounted so that even a total compromise of `/job` cannot reach the system prompt: the trusted prefix
  is not reachable from the untrusted side at all.
- **Traces to**: `CONST-ISSUE-TEXT-IS-DATA`, `CONST-ISOLATION-CONTAINER-PER-JOB`,
  `DES-PERSONA-VIA-APPEND-SYSTEM-MD`
- **Acceptance**: A write to any path under `/job` fails from inside the container.

## INT-CONTAINER-RUNTIME-CONTRACT

**worker → docker daemon.**

- **Contract**:
  - Flags: `--rm --cap-drop=ALL --security-opt no-new-privileges --memory=4g --cpus=2 --pids-limit=512`
  - User: non-root
  - Env: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` (scoped, 1h), `PI_JOB_ID`,
    `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, `PI_CODING_AGENT_DIR` (if not `$HOME/.pi/agent`)
  - Mounts: `/job:ro`, `/workspace:rw`
  - No TTY (`-it` absent)
- **Why**: This is the enforcement surface of `CONST-ISOLATION-CONTAINER-PER-JOB` — every flag is
  load-bearing and none is decoration. `--cap-drop=ALL` removes the capabilities pi would otherwise
  inherit from the launching user (pi has no permission system of its own to do this).
  `--pids-limit` bounds a fork bomb. `--memory` bounds an OOM to one job rather than the host.
  `PLAYWRIGHT_BROWSERS_PATH` resolves the collision between non-root execution and root-installed
  Chromium — see `DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS`.
  **Env is an allowlist, never a pass-through**: `ANTHROPIC_OAUTH_TOKEN` silently takes *precedence*
  over `ANTHROPIC_API_KEY`, so a stray variable in the host environment would quietly redirect which
  credential every job spends. Pass exactly these.
  Absence of `-it` is worth knowing rather than relying on: with no TTY, pi enters print mode
  automatically. Pass `-p` explicitly anyway — inferring behaviour from TTY presence is fragile.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → packages/ai/src/api/env-api-keys.ts:69-71`
  (OAuth token precedence) · `→ packages/coding-agent/src/core/config.ts:515-521 → getAgentDir()`
  (respects `$HOME`; override var is `PI_CODING_AGENT_DIR`; no hardcoded `/root`) ·
  `→ main.ts:99-108` (no TTY → print mode)
- **Traces to**: `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-TOKEN-SCOPED-PER-JOB`,
  `DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS`
- **Acceptance**: Chromium launches as the non-root user; `capsh --print` inside the container shows no
  capabilities.

## INT-WEBHOOK-PAYLOAD-SUBSET

**GitHub → receiver.**

- **Contract**:
  - Headers consumed: `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`
  - Body fields consumed: `action`, `issue.number`, `issue.title`, `issue.body`, `issue.labels[].name`,
    `comment.body`, `comment.author_association`, `sender.id`, `repository.full_name`
  - **Everything else is ignored.**
- **Why**: Naming the subset **is** the contract. Because everything else is ignored by construction, an
  upstream schema addition cannot change our behaviour — and a reviewer can see the entire attack
  surface as one list, instead of inferring it from destructuring scattered across a handler. Every
  field here is attacker-controlled except the headers and `sender.id`, and the headers are only
  trustworthy *after* `CONST-HMAC-OVER-RAW-BODY` has run.
- **Traces to**: `CONST-HMAC-OVER-RAW-BODY`, `REQ-TRIGGER-AUTHOR-GATE`, `REQ-DEDUP-BY-DELIVERY-GUID`
- **Acceptance**: Given a payload with unknown extra fields, behaviour is unchanged.

---

## Revision History

| Date | Change |
|---|---|
| 2026-07-15 | Initial. Extracted from `DESIGN.md` v0.1 §5.1, §5.3, §5.4, §5.5. `INT-SDK-SESSION-OPTIONS` is **new** — the source doc left the SDK option set unverified (its §10) and was wrong about the print-mode flag shape and the mode union. `PLAYWRIGHT_BROWSERS_PATH` added to the runtime contract: the source doc's Dockerfile was broken as written for non-root execution. The source doc's code sketches are deliberately **not** carried over — the real Dockerfile and handler are the truth, and a spec that mirrors them drifts on the first commit. |
