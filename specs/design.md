# Design

Decisions and their rationale. Non-negotiables live in `constitution.md`; what the system must do lives
in `requirements.md`. Each entry records what was chosen, **why**, and what was rejected — so the
question does not come back.

Evidence convention as in `constitution.md`: `Evidence (upstream)` is authoritative, `Reference` is not.

## Architecture

```
GitHub repo(s)
  │  webhooks: issues [opened, labeled], issue_comment [created]   (HMAC-signed)
  ▼   ── PUBLIC EDGE ──────────────────────────────────────────────
┌──────────────────────────────┐
│ receiver  (always-on, tiny)  │  verify signature → filter (label allowlist,
│ Node + Express               │  trusted-sender check) → enqueue job
│ binds 0.0.0.0 — MUST be      │  NO dashboard, NO admin surface here.
│ internet-reachable           │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ Valkey + BullMQ  "pi-jobs"   │◀──────▶│ panel  (admin)               │
│ THE WAIT-LIST: 50 triggers   │        │ binds 127.0.0.1 by default   │
│ = 50 pending jobs, drained   │        │ on/off (pause/resume),       │
│ at fixed concurrency; dedup  │        │ settings, model, flows,      │
│ by delivery GUID; retries;   │        │ Bull Board, setup            │
│ daily budget cap             │        │ ── NEVER on the public edge  │
└──────────────┬───────────────┘        └──────────────┬───────────────┘
               ▼  one job per worker slot              │ reads/writes
┌──────────────────────────────┐        ┌──────────────▼───────────────┐
│ worker (BullMQ Worker proc)  │───────▶│ data volume                  │
│ fresh clone → docker run     │  reads │ config.json + flows/*.md     │
└──────────────┬───────────────┘        └──────────────────────────────┘
               ▼
┌─────────────────────────────────────────────┐
│ pi-job container (ephemeral, per job)       │
│  • pi (SDK runner) + git + gh               │
│  • Playwright + headless Chromium           │
│  • /job:ro  = flow + issue payload          │
│  • persona BAKED INTO THE IMAGE             │
│    (hard rules; unreachable from panel      │
│     or from /job — see INT-CONTAINER-       │
│     JOB-INPUTS)                             │
│  edit → screenshot → iterate → commit →     │
│  push branch → gh pr create → issue comment │
└─────────────────────────────────────────────┘
```

Everything above the container is a few hundred lines of TypeScript. Everything below is pi.

**Architectural style: a queue-worker pipeline with a hard isolation boundary.** Explicitly **not
MACH** — that model scores 0/4 here and adopting its vocabulary would mislead every future reader.
Not *microservices*: three processes on one box is a pipeline, and splitting a few hundred lines into
independently-deployable services would be parody. Not *API-first*: there is no public API; the only
inbound contract is a webhook whose shape GitHub owns. Not *cloud-native*: actively rejected —
systemd on owned hardware, hosted runners declined (see `DES-BUILD-NOT-EXTEND-PI-ROUTINES` and the
rejected alternatives below). *Headless* only vacuously, which is not a commitment.

Everything follows from two constraints, both of which exist because pi provides neither: the agent is
unrestricted against adversarial input (`CONST-ISOLATION-CONTAINER-PER-JOB`), and every job spends real
money with no upstream turn limit (`REQ-RUNNER-TURN-BUDGET`).

---

## DES-NAME-KEEP-PI-DISPATCH

- **Decision**: Keep the name `pi-dispatch`. Do not publish to npm.
- **Why**: `pi-dispatch` **is** taken on npm — `pi-dispatch@1.0.3`, a pi *extension* that rotates
  ChatGPT Codex OAuth accounts to maximise quota. It does not bind us: it is functionally unrelated
  (it runs *inside* a pi session; this project runs pi inside *itself*), it was published once on
  2026-04-06 with no release since, and its GitHub repository returns 404. **We do not need the npm
  name** — distribution is docker-compose and container images, not `pi install npm:`, because this is
  not a pi package. GitHub namespaces by owner, so there is no conflict there either.
  Recorded because the collision is real and the question will otherwise return every time someone
  searches npm.
- **What would change this**: wanting to publish *any* npm artifact under this name — a management CLI,
  a client library. At that point rename; `pi-foreman` and `pi-onduty` were verified available.
- **Evidence (upstream)**: `registry.npmjs.org/pi-dispatch` — versions 1.0.2 and 1.0.3 both published
  2026-04-06; `time.modified` 2026-07-06 is a metadata touch, not a release; `repository.url` →
  `github.com/vincenthopf/pi-dispatch` → HTTP 404
- **Traces to**: `README.md` (disambiguation note)

## DES-TRIGGER-OUTSIDE-PI

- **Decision**: The trigger layer is a separate always-on process. It is not a pi extension.
- **Why**: pi's event system observes a *running session* — `session_start`, `before_agent_start`,
  `tool_call`, and so on. There are **no cron, webhook, or external-trigger event types**. An extension
  *can* drive turns programmatically (`pi.sendUserMessage()` always triggers a turn), so a webhook
  listener inside an extension is technically possible — but **the triggers would die with the
  session**, which contradicts the always-on goal outright and reproduces the exact structural flaw that
  made the closest existing tool unusable ("always-on / laptop closed: no"). This decision is why the
  repository exists at all; without it there is nothing to build.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → packages/coding-agent/docs/extensions.md`
  (event type union; no external-trigger types)
- **Rejected**: webhook listener inside a pi extension — session-bound lifetime.
- **Traces to**: `REQ-QUEUE-BURST-NO-DROP`

## DES-QUEUE-BULLMQ-OVER-CUSTOM

- **Decision**: Redis + BullMQ.
- **Why**: BullMQ supplies priorities, a rate limiter, a dedup window, stalled-job recovery, retry
  policy, and a dashboard — each of which is an independent requirement here, not a bonus. Building five
  mechanisms to avoid one dependency is precisely how a solo-maintainer project drowns in maintenance.
  Redis persistence (AOF) is what makes `REQ-QUEUE-BURST-NO-DROP` survive a reboot; an in-memory queue
  would lose the wait-list on the first restart.
- **Evidence (upstream)**: BullMQ is MIT (`taskforcesh/bullmq → LICENSE`, © BullForce Labs AB)
- **Rejected**:
  - *Hand-rolled Redis list* — reimplements the five mechanisms above, badly, forever.
  - *GitHub Actions `concurrency:` groups* — claude-code-action's own docs concede the action has no
    queue either; concurrency groups cancel or serialise, they do not hold a wait-list.
  - *The existing tool's depth-3 FIFO* — see `DES-BUILD-NOT-EXTEND-PI-ROUTINES`.
- **Deployment note**: default the compose file to **Valkey** (BSD-3, Linux Foundation) rather than
  Redis. Redis ≥8.0 is tri-licensed AGPLv3 / SSPLv1 / RSALv2; the AGPL does not reach this project —
  we speak RESP over a socket and do not link Redis — but Valkey means the conversation never happens
  for downstream self-hosters either.
  **Valkey status — good enough to proceed, not proven.** BullMQ's own marketing page lists Valkey among
  supported backends, but its compatibility *documentation* commits only to *"full Redis™ compliant with
  version 6.2.0 or newer… not all the alternatives are going to work properly"*. The widely-repeated
  claim that BullMQ's test suite runs against Valkey is **UNVERIFIED** — it traces to secondary sources,
  not to BullMQ, and must not be cited as fact. What *is* solid: BullMQ talks RESP through ioredis with no
  Redis-specific handshake, and the only Valkey-related upstream issues are feature requests for a
  Valkey **Glide** adapter — not bug reports about basic compatibility. No Lua incompatibility reports
  exist, which matters because BullMQ is Lua-heavy. Proceed on Valkey; **keep Redis 8 as the documented
  fallback** and treat any queue weirdness as a Valkey suspect first.
- **Consequences worth knowing before sizing anything** — all source- or doc-verified:
  - **The rate limiter is global, not per worker.** *"The rate limiter is global, so if you have for
    example 10 workers for one queue with the above settings, still only 10 jobs will be processed by
    second."* Do **not** multiply `limiter.max` by worker count. `concurrency` is the opposite — it is
    per-Worker-instance. Two adjacent options with opposite scoping is a trap worth writing down.
  - **`queue.pause()` is durable and global**, implemented as a Redis-side rename of the `wait` key to
    `paused` — so it survives a restart, which is what makes it usable as the panel's on/off switch.
    New jobs are still accepted while paused (they land in `paused`); in-flight jobs run to completion.
    That is the correct semantics for `DES-PANEL-SEPARATE-FROM-RECEIVER`'s switch: **off means "stop
    starting work", not "start dropping work"** — dropping would violate `REQ-QUEUE-BURST-NO-DROP`.
  - **Stalled-job recovery re-runs paid jobs by default** — see `CONST-RETRY-INFRA-ONLY`.
- **Reference** (no authority): `docs.bullmq.io/guide/rate-limiting`, `/guide/workers/pausing-queues`,
  `/guide/redis-tm-compatibility`.

## DES-PERSONA-VIA-APPEND-SYSTEM-MD

- **Decision**: Bake the persona into the image at `~/.pi/agent/APPEND_SYSTEM.md`, **and** pass per-flow
  additions via **`appendSystemPromptOverride`** — never via bare `appendSystemPrompt`.
- **Why**: The obvious reading of these two mechanisms is that they compose. **They do not.** Passing
  `appendSystemPrompt` **replaces** file discovery — the `??` means the baked `APPEND_SYSTEM.md` is
  never looked for. The persona vanishes with **no error, no warning, and a job that completes
  successfully**. `appendSystemPromptOverride` receives the *discovered* content as `base`, so
  `(base) => [...base, perFlowText]` preserves both. This is the single most dangerous trap in the
  integration and is why `REQ-UPSTREAM-CONTRACT-TESTS` asserts both strings reach the assembled prompt:
  no other mechanism would ever tell us.
  The **global** path is chosen over the project path because `~/.pi/agent/` has **no trust gate**,
  while project `.pi/*` resources are gated by `isProjectTrusted()` and headless modes ignore them
  absent saved trust — nondeterministic inside a container is unacceptable for the file that carries our
  standing rules. Requires coding-agent ≥ v0.46.0; confirmed present at the pin.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → resource-loader.ts:480-482` —
  `const appendSources = this.appendSystemPromptSource ?? (this.discoverAppendSystemPromptFile() ? [...] : [])`
  · `→ resource-loader.ts:156 → appendSystemPromptOverride?: (base: string[]) => string[]` ·
  `→ resource-loader.ts:979-991 → discoverAppendSystemPromptFile` (global path ungated) ·
  `→ CHANGELOG.md [0.46.0] - 2026-01-15` ("Support `APPEND_SYSTEM.md`…")
- **Rejected**:
  - *`SYSTEM.md`* — replaces pi's default prompt entirely, losing its built-in tool guidance. We want to
    add to pi's behaviour, not supplant it.
  - *Project-level `.pi/APPEND_SYSTEM.md`* — trust-gated; headless ignores it without `--approve`.
  - *`AGENTS.md`* — **forbidden**, not merely unused. See `CONST-NO-CONTEXT-FILES-MANDATORY`: it is not
    trust-gated, so it is an injection vector, and `-nc` disables it anyway.
  - *Extension returning `systemPrompt` from `before_agent_start`* — genuinely works and is
    cache-friendly when deterministic (the original pi-caveman demonstrates this). Rejected for moving
    parts: load-order chaining, per-prompt re-return, extension loading in headless mode. Reserve for
    prompt logic that cannot be expressed as a file.
  - *Per-message injection* — see `CONST-PERSONA-IN-CACHED-PREFIX`.
- **Traces to**: `CONST-PERSONA-IN-CACHED-PREFIX`, `INT-SDK-SESSION-OPTIONS`, `REQ-UPSTREAM-CONTRACT-TESTS`

## DES-BUILD-NOT-EXTEND-PI-ROUTINES

- **Decision**: Build fresh rather than extend the existing `pi-routines` community project.
- **Why**: Adding the missing GitHub event types to its poller would be a small PR — but the blockers
  are **structural, not featural**: execution is session-bound (routines run as turns inside a live
  interactive session, single-flighted), the overflow queue is depth 3, and the trigger server hard-binds
  to `127.0.0.1` with no config. Fixing those means replacing the core while inheriting the name and its
  users' expectations. Two of its ideas were adopted instead of its code: **budget-before-tokens**
  (`CONST-BUDGET-BEFORE-TOKENS`) and **fire dedup** (`REQ-DEDUP-BY-DELIVERY-GUID`).
- **Evidence (upstream)**: `Davidcreador/pi-routines @ 6d2aa64 (v0.5.1) → src/types.ts:105` (event union:
  `pull_request.opened|closed`, `issues.opened`, `push` — no `issues.labeled`, no `issue_comment`) ·
  `→ src/types.ts:423 → MAX_QUEUE_DEPTH = 3` · `→ src/guard.ts → isRoutineTurnActive` ·
  `→ src/server.ts` (hard `127.0.0.1:7424` bind)

## DES-CONCURRENCY-3

- **Decision**: Default worker concurrency 3, exposed as `PI_CONCURRENCY`.
- **Why**: Two soft limits, and 3 is their conservative intersection. RAM (~1.5–2.5 GB/job against a
  16 GB box) suggests 3 — but RAM is probably **not** the binding constraint: the provider's tier
  throttles concurrent streams and tokens-per-minute long before Docker runs out of memory. A **config
  knob rather than a constant** because one of the two inputs is an unmeasured guess (`OQ-002`), so
  re-tuning after measurement should be a deploy, not a code change.
- **Traces to**: `OQ-002`, `REQ-QUEUE-BURST-NO-DROP`

## DES-CRON-VIA-BULLMQ-SCHEDULER

- **Decision**: Scheduled triggers use BullMQ **Job Schedulers** (`upsertJobScheduler`). We do not build a
  cron, and we do not use the deprecated `repeat:` API. **A schedule is a trigger, not a job kind** — it
  produces an ordinary job aimed at either a GitHub repo or a local folder.
- **Why**: pi has no cron (`DES-TRIGGER-OUTSIDE-PI`), and hand-rolling one means reimplementing cron
  parsing, persistence, missed-tick policy and overlap control — four mechanisms, the exact drowning
  `DES-QUEUE-BULLMQ-OVER-CUSTOM` refused. BullMQ's scheduler is a **Redis object, not a JS timer**
  (`ZADD repeat <nextMillis> <id>` + `HMSET`), so it survives a worker restart with nothing to lose and a
  Redis restart under the AOF we already require. Three of its properties are exactly what a
  money-spending harness needs, and all three are verified rather than assumed:
  - **No backfill.** Six hours down with an hourly schedule costs **one** paid run on restart, not six —
    the `every` path aligns forward to a single next slot; the `pattern` path asks cron-parser for one
    `next`. Neither loops. This is the difference between a reboot and a bill.
  - **No overlap, structurally.** The next job is only created when the current one *starts processing*,
    so a 30-minute flow on a 10-minute schedule yields one job every 30 minutes rather than three
    concurrent agent runs. The cost is silent under-firing — actual cadence degrades below the configured
    one under load, so the panel should surface `next` drift rather than let it look healthy.
  - **Deterministic `jobId`** — `repeat:<schedulerId>:<nextMillis>` — so scheduler jobs get
    `REQ-DEDUP-BY-DELIVERY-GUID`-equivalent dedup for free, with no GUID to supply.
  **Legacy `repeat:` is deprecated and slated for removal in v6** — starting on it would be adopting a
  known-dead API.
- **Evidence (upstream)**: `taskforcesh/bullmq @ v5.80.4 → src/classes/queue.ts:468-495 → upsertJobScheduler`
  · `→ queue.ts:651` — `@deprecated … will be removed in v6. Use removeJobScheduler instead` ·
  `→ src/commands/includes/getJobSchedulerEveryNextMillis.lua` — `nextMillis = prevMillis + every` then,
  verbatim, `-- check if we may have missed some iterations`, resolving to a **single** aligned slot ·
  `→ src/commands/addJobScheduler-11.lua:144` — `local jobId = "repeat:" .. jobSchedulerId .. ":" .. nextMillis`
  · `→ addJobScheduler-11.lua:164,191` — returns `-11` `SchedulerJobSlotsBusy` / `-10`
  `SchedulerJobIdCollision` · `→ src/commands/includes/storeJobScheduler.lua` (Redis-resident schedule) ·
  `→ src/classes/queue.ts:603-696` — `getJobScheduler` / `getJobSchedulers(start,end,asc)` /
  `getJobSchedulersCount` / `removeJobScheduler`
- **Rejected**: a hand-rolled cron (four mechanisms, see above) · the legacy `repeat:` API (deprecated,
  v6 removal) · an in-process timer (dies with the process; the flaw that made the closest existing tool
  unusable — `DES-BUILD-NOT-EXTEND-PI-ROUTINES`)
- **Must handle**: `-10` / `-11` return codes. Swallowing them makes a schedule edit **silently no-op**,
  which looks identical to success.
- **Carve-out that is not optional**: scheduler jobs **bypass `maxStalledCount`** — see
  `CONST-RETRY-INFRA-ONLY`. This is the one place BullMQ's stall protection does not hold, and it is
  precisely the trigger that runs while nobody is watching.
- **Traces to**: `CONST-RETRY-INFRA-ONLY`, `CONST-BUDGET-BEFORE-TOKENS`, `REQ-RUNNER-TURN-BUDGET`,
  `REQ-QUEUE-BURST-NO-DROP`

## DES-CLI-TRIGGER-FOR-LOCAL

- **Decision**: Local-folder jobs are triggered by a **CLI** (`pi-dispatch run <folder> --task … [--flow …]`)
  as the first interface, in addition to the panel that `DES-PANEL-SEPARATE-FROM-RECEIVER` describes. Both
  are producers that call one `enqueueLocalJob`; the CLI is the leaner, dev-native path and the panel
  reuses the same enqueue.
- **Why**: For a self-hosted tool that mostly runs on people's own machines, the terminal is the natural
  first interface — no web server, no bigger build before anything runs — and it is what makes the local
  path usable ahead of the panel. The spec build order reaches a usable *local* experience only at the
  panel, which sits after the receiver; a CLI closes that gap without the GitHub-webhook receiver a local
  user does not need.
- **Consistency check** (this was verified, not assumed): the CLI trigger violates no constraint.
  `CONST-TRIGGER-AUTHOR-GATE` is webhook/comment-scoped by construction, and local jobs are ungated by
  design (`SECURITY.md`: panel/CLI access *is* the trust boundary for local). Critically,
  **`CONST-BUDGET-BEFORE-TOKENS` still holds**: the cap is checked and incremented in the *worker's
  processor*, immediately before the container starts — never in the trigger. A producer that enqueues a
  job cannot bypass the budget, because the budget gate lives on the consumer side, after prepare and
  before `runContainer`. The CLI is only a producer; it spends nothing.
- **Safety**: a local job edits the folder in place with no undo, so the CLI refuses a **dirty git working
  tree** unless `--force` — a cheap guard the panel should mirror.
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `DES-PANEL-SEPARATE-FROM-RECEIVER`,
  `REQ-LOCAL-JOB-VISIBILITY`

## DES-WORKER-ON-HOST

- **Decision**: The worker runs **on the host** (a Node process, `pi-dispatch worker` / `npm start`), not
  in a container. It launches job containers by shelling out to the real `docker` CLI.
  `docker-compose` runs **only Valkey**; the worker is a host process alongside it.
- **Why**: This is the reversal of `DES-JOB-FILES-VIA-VOLUME-SUBPATH` (below, superseded), forced by two
  findings and the local-first target.
  **(1) The `docker` CLI translates host paths; the daemon does not.** On Docker Desktop the daemon is a
  *Linux* daemon behind a Windows named pipe (`docker context` shows `npipe://…` with `docker info`
  reporting `linux/x86_64`), so `C:\Users\…` is not a path a Linux kernel can bind-mount. Translation is
  client-side — corroborated by compose's `COMPOSE_CONVERT_WINDOWS_PATHS` rewriting paths even against a
  remote non-Windows daemon. So a **containerised** worker calling the Engine API must construct the
  VM-internal path itself, and **that prefix has already moved between Docker Desktop versions**
  (`/host_mnt/c/…` → `/run/desktop/mnt/host/c/…`). Pinning bespoke path math to an undocumented,
  *moving* internal is `CONST-PI-VERSION-PINNED`'s failure class with a different vendor — it would break
  on a silent Docker Desktop auto-update. A host worker shelling out to `docker` inherits Docker's own
  cross-platform-tested translation for free. This is `library-first` one level up: do not reimplement
  Docker Desktop's path translation.
  **(2) Local-folder jobs *require* a host bind mount.** The named-volume trick in the superseded entry
  dissolves the path problem only because no host path crosses the boundary — which is exactly what a
  local-folder job cannot do: the operator's own folder must be bind-mounted as `/workspace`, edited in
  place. There is no volume to hide behind. Since local folders are the primary self-hosted experience,
  the deployment model must support the bind mount, and the host worker does so with zero path math.
  **Isolation is unaffected.** `CONST-ISOLATION-CONTAINER-PER-JOB` is about the **job** container being
  the boundary — pi still never runs on the host. And a container holding `/var/run/docker.sock` is
  already root-equivalent on the host, so containerising the worker bought *no* isolation; it only bought
  deployment tidiness, which is what this trades away.
- **What this deletes**: the named-volume + `volume-subpath` machinery, the `≥26.1.0` Engine floor, the
  socket mount, and the `docker-socket-proxy`. The worker binds `/job:ro` and `/workspace` (the folder)
  directly.
- **Accepted cost, stated plainly**: Node on the host, not only Docker. `docker compose up` alone no
  longer runs everything; the operator also runs `pi-dispatch worker`. That is the honest price of
  local-folder jobs working on Windows/macOS/Linux without fragile path math. The receiver and panel are
  Node too, so it is one install story (`npm ci`), with Docker running Valkey and the job containers.
- **Evidence**: verified first-hand this session — `docker context` (`npipe` endpoint, `linux/x86_64`
  daemon) · `moby/for-win#14271` (VM prefix `/run/desktop/mnt/host/…`) and `docker/compose#5563`
  (older `/host_mnt/…`), i.e. the prefix moved · `docker/compose#4240`
  (`COMPOSE_CONVERT_WINDOWS_PATHS` is unconditional client-side rewriting) · a constructed `docker run`
  argv launched the real job image with a host-native folder path, cross-platform, with no translation.
- **Rejected**: containerised worker + `volume-subpath` (cannot bind-mount a local folder; pins moving
  path math) — see the superseded entry for its full reasoning, kept as the record of why it was tried.
- **Traces to**: `INT-CONTAINER-JOB-INPUTS`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `CONST-ISOLATION-CONTAINER-PER-JOB`

## DES-JOB-FILES-VIA-VOLUME-SUBPATH

- **Status**: **SUPERSEDED by `DES-WORKER-ON-HOST`.** Kept in place because IDs are permanent and its
  research (subpath semantics, the socket-proxy hardening) stays relevant if a GitHub-only deployment
  ever re-containerises the worker. The decision below is **not** what the code does: the worker runs on
  the host and bind-mounts directly.
- **Decision**: The worker hands `/workspace` and `/job` to the job container via a **plain named volume
  per job** plus `--mount type=volume,…,volume-subpath=…`. Never a host bind mount. Docker Engine
  **≥26.1.0**. A `tecnativa/docker-socket-proxy` sits between the worker and the Docker socket.
- **Why**: The worker is containerised and launches **sibling** containers through the Docker socket, so
  every bind-mount path it passes to `docker run` is resolved in the **daemon's** filesystem namespace,
  not its own. `-v ${JOB_DIR}/workspace:/workspace` therefore mounts an empty directory or the wrong one
  — silently. This is the classic docker-out-of-docker footgun and it was this project's largest named
  unknown for cross-platform support.
  **A named volume dissolves the problem rather than managing it**: a volume is a daemon-side handle, so
  no host path string ever crosses the boundary and there is nothing to translate. Every competing option
  manages the mismatch per-platform instead of removing it, and each breaks somewhere: *same-path bind
  mounts* work on Linux and mostly on macOS but **break on native Windows**, where the daemon lives in a
  VM with a POSIX namespace and drive-letter paths are translated rather than passed through — they only
  hold if the whole stack runs inside WSL2, which is a discipline, not a guarantee. *Worker on the host*
  is technically fine but abandons the compose deployment model and reintroduces "install Node correctly
  on three operating systems" as a support burden. *`docker cp`* avoids paths too but cannot give `/job`
  a kernel-enforced read-only mount, which `INT-CONTAINER-JOB-INPUTS` depends on — it is the viable
  fallback, not the default.
  **Two constraints are not optional.** The volume must be **plain**: a "parameterized" named volume that
  is a disguised bind (`driver_opts: {type: local, o: bind, device: …}`) mis-concatenates the subpath into
  the mount options and fails. And the subpath **must already exist inside the volume** before the
  container starts — there is no auto-create; the worker creates `workspace/` and `job/` as job prep.
  The socket makes the **worker** the root-equivalent asset — not the agent, which never receives it. That
  residual risk is supply-chain, not injection (worker code never reads issue text, per
  `CONST-ISSUE-TEXT-IS-DATA`), and the socket proxy bounds it: allowlist `CONTAINERS`/`IMAGES`/`POST`,
  leave `EXEC`, `SECRETS`, `SWARM`, `PLUGINS` denied by default.
- **Evidence (upstream)**: `moby/moby#45687` ("volumes: Implement subpath mount", Engine **26.0.0**;
  symlinks cannot escape the volume base; TOCTOU-protected) · `docker/cli#4331` (CLI flag) ·
  `moby/moby#47842` (subpath **must pre-exist**; fails `lstat …: no such file or directory`) ·
  `moby/moby#47711` (subpath dropped in Swarm; fixed **26.1.0** — hence the ≥26.1.0 floor even though we
  do not use Swarm) · `forums.docker.com/t/volume-subpath-in-docker-compose/143463` (bind-backed named
  volume breaks subpath: `invalid mode: rw,nocopy,tftp`; reproduced on 26.0.1–27.1.2) ·
  Docker Desktop FAQ: *"Mac and Windows WSL 2 users can connect via Unix socket at
  `unix:///var/run/docker.sock`"* · `Tecnativa/docker-socket-proxy` README (per-API-section allowlist;
  `POST`/`AUTH`/`SECRETS` revoked by default)
- **Rejected** *(at the time of this superseded entry)*: same-path bind mount (breaks on native Windows) ·
  worker-on-host — **this rejection was itself reversed by `DES-WORKER-ON-HOST`**, which found that
  local-folder jobs make a host bind mount unavoidable and that the containerised alternative pins moving
  path math · `docker cp` (cannot enforce read-only `/job`; kept as fallback)
- **Open**: `readonly` combined with `volume-subpath` is documented as an orthogonal field but **no worked
  example was found combining them** — smoke-test it in CI before relying on it, because
  `INT-CONTAINER-JOB-INPUTS` is a security boundary, not a convenience. Likewise `--rm` is believed not to
  touch named volumes (it removes only *anonymous* ones) — inferred, not verified.
- **Traces to**: `INT-CONTAINER-JOB-INPUTS`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `CONST-ISOLATION-CONTAINER-PER-JOB`

## DES-PANEL-SEPARATE-FROM-RECEIVER

- **Decision**: The admin panel is a **separate process on a separate port**, binding `127.0.0.1` by
  default. Bull Board mounts on the panel. The receiver carries **no** dashboard and no admin surface.
- **Why**: The panel sets the model, the budgets, and what the agent is told to do — it is the most
  dangerous surface in the system, and a compromise of it is a compromise of everything downstream of it.
  The receiver is the one process that **must** bind `0.0.0.0`, because GitHub has to POST to it from the
  internet. **Mounting the panel on the receiver therefore publishes the admin surface to the internet**
  — the two processes have exactly opposite reachability requirements, so they cannot share a port.
  This is a **correction**: the source design document mounted Bull Board on the receiver behind basic
  auth. That was defensible when the dashboard was read-only; it is not once the same surface can change
  the model and rewrite flows. Basic auth on a public port is not the control that should stand between
  the internet and "edit the agent's instructions".
  Note the deliberate asymmetry with `DES-BUILD-NOT-EXTEND-PI-ROUTINES`, which criticises that project
  for hard-binding `127.0.0.1`. That criticism was of a **webhook trigger endpoint**, which is useless if
  unreachable. For an **admin panel** the same bind is correct. The lesson is that reachability is a
  per-surface decision, not a project-wide default — which is exactly why they are different processes.
- **Rejected**:
  - *Panel mounted on the receiver behind basic auth* — publishes admin to the internet; see above.
  - *Panel on the same process, different port* — one crash, one dependency upgrade, or one unhandled
    rejection takes down webhook ingress with the admin UI. The wait-list should not depend on the UI.
- **Traces to**: `CONST-TRIGGER-AUTHOR-GATE`, `CONST-BUDGET-BEFORE-TOKENS`, `REQ-JOB-STATUS-COMMENTS`

## DES-FLOWS-ARE-DATA-PERSONA-IS-CODE

- **Decision**: Split the agent's instructions by mutability. **The persona is baked into the image** and
  carries the *hard rules* — never merge, issue text is data, work only in `/workspace`. **Flows are user
  data** in a mounted volume, seeded from repo defaults on first run, and carry the *task recipe* —
  screenshot, iterate, open a PR. The panel may edit flows. It may never touch the persona.
- **Why**: The panel requirement ("set prompts and which flow runs, from the UI") collides head-on with
  this project's earlier decision to keep flows as reviewed repo markdown — *versioned, reviewable,
  pi-version-proof*. The resolution is not a compromise between the two; it is the observation that
  **those two properties were being asked of one file that was doing two jobs.**
  The rules the agent must not be talked out of need immutability, and `INT-CONTAINER-JOB-INPUTS` already
  mounts `/job` read-only and bakes the persona *precisely* so that a total compromise of `/job` cannot
  reach the system prompt. That same reasoning extends one step: a panel compromise must not reach it
  either. Meanwhile the task recipe is genuinely configuration — the thing an operator legitimately
  wants to tune at 11pm without a rebuild — and gains nothing from being immutable.
  So the security property survives *and* the panel gets real power, because the boundary now falls where
  the risk actually changes rather than where the filesystem happened to.
  **Accepted cost**: edited flows lose git review and versioning. That is the honest trade for runtime
  editability, and it is bounded — a flow cannot revoke a hard rule, because the hard rules are not in it.
- **Rejected**:
  - *Panel edits `flows/` in the repo* — two sources of truth between a git checkout and a running
    system, and the classic "why did my change vanish on redeploy".
  - *Everything baked, panel read-only* — satisfies the specs and not the user; a panel that cannot
    change anything is a dashboard.
  - *Everything panel-editable including hard rules* — makes `CONST-MERGE-NEVER-AUTOMATIC` and
    `CONST-ISSUE-TEXT-IS-DATA` runtime-mutable state. They are constitutional precisely because they are
    not negotiable at runtime.
- **Traces to**: `CONST-ISSUE-TEXT-IS-DATA`, `CONST-MERGE-NEVER-AUTOMATIC`, `INT-CONTAINER-JOB-INPUTS`,
  `DES-PERSONA-VIA-APPEND-SYSTEM-MD`, `DES-PANEL-SEPARATE-FROM-RECEIVER`

## DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS

- **Decision**: `@playwright/cli` with Chromium bundled in the job image, with
  `PLAYWRIGHT_BROWSERS_PATH` set at **both** build and run.
- **Why**: `@playwright/cli` is headless by default and built for agents, so it works in a container
  with no display server. The `PLAYWRIGHT_BROWSERS_PATH` detail is not incidental — it resolves a direct
  collision between two of our own constraints. Installing Chromium as root at build time puts it in
  `/root/.cache/ms-playwright`; the non-root runtime user that `CONST-ISOLATION-CONTAINER-PER-JOB`
  requires has a different `$HOME` and **cannot see it**. Setting the variable at both stages makes
  install and lookup agree. Note pi-playwright itself has no browser-resolution logic — it delegates
  entirely to standard Playwright resolution — so this is ours to get right.
  **`@playwright/cli` does not install browsers.** Verified from the published tarball: it is a 115-line
  wrapper with `bin: {"playwright-cli": …}` and no browser-fetch code; its own `install` subcommand
  installs *agent skill files*, not binaries. Browsers come from the standard installer —
  `npx playwright install --with-deps chromium`. Note it depends on `playwright@1.62.0-alpha-1783623505000`
  — **an alpha, pinned exactly by the package itself**; treat that as another upstream pin to watch.
  **Chromium must run `--no-sandbox`** — see `INT-CONTAINER-RUNTIME-CONTRACT`. The alternative is
  re-granting `CAP_SYS_ADMIN` or widening seccomp, which trades the container boundary for Chromium's
  internal one against adversarial input. The container is the sandbox.
- **Evidence (upstream)**: `guwidoe/pi-playwright @ 7d3eeeda` — `PLAYWRIGHT_BROWSERS_PATH` appears
  nowhere in the repo; `scripts/pw.js` is a passthrough to `@playwright/cli` ·
  `npm @playwright/cli@0.1.17` — `bin: {"playwright-cli": "playwright-cli.js"}`, deps pin
  `playwright@1.62.0-alpha-1783623505000`; no installer code in the tarball
- **Reference** (no authority): Playwright docs — default Linux browser path `~/.cache/ms-playwright`;
  Chromium sandbox needs custom seccomp (`clone`/`setns`/`unshare`) or `SYS_ADMIN` when non-root;
  Chromium download ~281 MB, with `--only-shell` documented as a smaller headless-only variant (a real
  trade with feature gaps, not a free win — evaluate against `REQ-FRONTEND-VISUAL-VERIFY` before taking).
- **Rejected**: *pi-chrome-dev-tools* — drives the **system Chrome with a persistent profile**. There is
  no system Chrome in the container, and a persistent profile contradicts
  `CONST-ISOLATION-CONTAINER-PER-JOB` directly. It is a desktop tool.
- **Traces to**: `REQ-FRONTEND-VISUAL-VERIFY`, `INT-CONTAINER-RUNTIME-CONTRACT`

---

## Rejected alternatives (whole-project)

Considered and declined. Recorded so they are not re-proposed.

- **Claude Code GitHub Action** — MIT, ~8.4k stars, GA. Already does this trigger spec: `issues:
  [opened, assigned, labeled]` with a dedicated label trigger, `issue_comment`, cron, and skill
  invocation from a prompt. **It remains the honest 90%-for-10%-effort fallback and the README says so.**
  Declined because it ties execution to GitHub-hosted runners and their minutes, gives less control over
  the browser environment and model choice, and — the actual point — this project is about running *pi*.
  Note it validates every pattern here, including having no queue of its own.
- **OpenHands resolver** — a second proof of the label-trigger pattern (`fix-me` label → agent attempts
  the issue). Different agent; documented reliability issues.
- **GitHub Actions + a self-hosted runner invoking pi headlessly** — genuinely attractive: GitHub absorbs
  the burst, our hardware runs the work, zero queue infrastructure. A legitimate v2 direction. Declined
  for v1 because webhook→BullMQ is easier to debug than runner plumbing, and because the queue semantics
  we want (priorities, budget cap, dashboard, dedup) are exactly what Actions does not give.
- **`pi-harness`** (`zosmaai/openzosma`) — the closest prior art: *"the top-level harness for the Pi
  ecosystem… run pi-coding-agent headlessly as a background HTTP/SSE server."* It solves the
  run-pi-headlessly half and nothing else — no triggers, no queue, no container-per-job. It is a server;
  this is a job system. Single publish at 0.1.1 (2026-04-26), no releases since.
- **`pi-sentry`** — an in-process permission/impact gate extension for pi, classifying tool calls
  low/medium/high. Does **not** change `CONST-ISOLATION-CONTAINER-PER-JOB`: it runs inside the agent
  process, custom extension tools execute on the host regardless, and it documents a "YOLO" level that
  bypasses classification. It is a useful interactive UX guard, not a boundary against adversarial
  input.
- **Gondolin micro-VM** — see `CONST-ISOLATION-CONTAINER-PER-JOB`. Routes only built-in tools.

## Repo layout

```
pi-dispatch/
  specs/          ← this directory: the source of truth
  receiver/       # Express webhook ingress. Public edge. No dashboard.
  panel/          # Admin UI + Bull Board. Localhost-bound. See DES-PANEL-SEPARATE-FROM-RECEIVER
  worker/         # BullMQ worker, docker orchestration, GitHub token minting
  image/          # Dockerfile + entrypoint + /runner (SDK job runner)
  flows/          # frontend-fix.md, bug-fix.md, triage.md — DEFAULTS, seeded into the data volume
  persona/        # hard rules; baked into the image. Not runtime-editable
  deploy/         # docker-compose runs Valkey only; worker/receiver/panel are host Node processes
                  #   (DES-WORKER-ON-HOST). systemd units ship as untested examples.
  .env.example    # provider key, spend/concurrency knobs, VALKEY_URL, PI_JOB_IMAGE
  docs/
```

**`flows/`, not `skills/`.** "Skill" already means three different things in this ecosystem: pi's
installable packages (`pi install npm:…`), a package's *registered* skill (pi-playwright's
`playwright-browser`), and our per-label job definitions. Renaming the one we control costs nothing and
removes the ambiguity at its root — the alternative is a glossary that explains a collision we could
simply not have.

**Build order**: image + runner + persona (headless pi proven in isolation) → worker → receiver → flows
→ panel → deploy + hardening. The first step is deliberately the one that needs no queue and no GitHub:
it is where the SDK traps in `INT-SDK-SESSION-OPTIONS` live, and they are cheapest to find with nothing
else in the frame.

**Platform**: Windows, macOS and Linux, wherever Docker runs. `docker-compose` is the supported
deployment; systemd units ship as untested examples. Two consequences are not incidental and are tracked
where they bite: a containerised worker talking to the Docker socket resolves bind-mount paths in the
*daemon's* namespace, not its own; and a home machine behind NAT cannot receive GitHub webhooks without
a tunnel.

---

## Revision History

| Date | Change |
|---|---|
| 2026-07-15 | Initial. Extracted from `DESIGN.md` v0.1 (2026-07-14, local, uncommitted) §2, §3, §4, §5, §9, §11. That document recorded "50 claims adversarially verified: 48 confirmed, 2 refuted" — **verified against documentation**. Source-verification at `earendil-works/pi @ 5e336cf` subsequently corrected ~7 points. `DES-PERSONA-VIA-APPEND-SYSTEM-MD` is materially rewritten: the source doc's decisions #1 and #2 were mutually exclusive as written. `DES-NAME-KEEP-PI-DISPATCH` is new. `pi-harness` and `pi-sentry` were absent from the source doc's alternatives and are added. §5.7's "caches roll at midnight" caveat is **dropped** — 0.80.7 removed the date from the default system prompt. |
| 2026-07-15 | An admin panel and cross-platform (Windows/macOS/Linux + Docker) added to scope. Two new decisions and one **security correction**. `DES-PANEL-SEPARATE-FROM-RECEIVER`: the source doc mounted Bull Board on the receiver — defensible for a read-only dashboard, **not** once the same surface sets the model and rewrites flows, because the receiver is the one process that must be internet-reachable. The panel and the receiver have opposite reachability requirements and cannot share a port. `DES-FLOWS-ARE-DATA-PERSONA-IS-CODE`: the panel requirement collided with keeping flows as reviewed repo markdown; resolved by observing that one file was carrying two jobs — hard rules need immutability, task recipes need editability. Architecture diagram and repo layout updated; the public edge is now drawn explicitly. Build order extended with panel and deploy. |
| 2026-07-16 | **Resolved a spec/code contradiction.** `DES-WORKER-ON-HOST` added and `DES-JOB-FILES-VIA-VOLUME-SUBPATH` marked SUPERSEDED: the worker runs on the host (the `docker` CLI translates host paths, the daemon does not, and the VM prefix moved between Docker Desktop versions; local-folder jobs also *require* a host bind mount a named volume cannot give). The committed spec had rejected worker-on-host while the code already did it -- caught by a spec-conformance scan. `DES-CLI-TRIGGER-FOR-LOCAL` added: the CLI producer was built (user-directed) but unspecified; recorded with the check that `CONST-BUDGET-BEFORE-TOKENS` still holds because the cap is enforced in the processor, not the trigger. Repo-layout `deploy/` line corrected (compose runs Valkey only). |
