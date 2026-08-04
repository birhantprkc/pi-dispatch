# Reuse your existing pi setup — the global overlay

If you already run `pi`, you have a configured `~/.pi/agent`: custom models, global skills, a global persona.
Point pi-dispatch at a **credential-free copy** of it and every job gets it — **layered under each repo's own
`.pi/`**, so a repo can still override or add on top. It works with the **pulled** prebuilt image: this is a
read-only mount, not an image rebuild — and the same is true of a per-trigger image (`run.image`), because
any conformant image gets the overlay. What the overlay cannot deliver is a **toolchain** (apt packages, a
language runtime, system libraries); that is what [job-image.md](job-image.md) is for.

## Enable it

```bash
pi-dispatch import-pi          # stage the safe subset of ~/.pi/agent into ./pi-global
# then in .env:
PI_GLOBAL_PI_DIR=/absolute/path/to/pi-global
pi-dispatch doctor             # verifies the overlay is credential-free
```

`import-pi` reads your host agent dir (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`) and copies a **curated,
credential-free** subset into the overlay dir. Re-run it whenever you change your host setup. Flags:
`--no-extensions` (see below), `--with-packages` / `--packages-file <path>` (see below),
`--from <agentDir>`, `--to <overlayDir>`. `--with-extensions` is still accepted as a documented no-op
(extensions come along by default now), so an older setup script keeps working and keeps meaning what it
always meant.

## What layers, and who wins

Four tiers, most-trusted first; each refines but never removes the one above:

| Tier | Source | Trust | Mutable? |
|---|---|---|---|
| 1. Safety floor | baked `HARD_RULES.md` (from **whichever image the trigger names** — `run.image`) | image, root-owned | no (immutable) |
| 2a. **Global overlay** | `PI_GLOBAL_PI_DIR` → `/opt/pi-global:ro` | **operator, deploy-time** | re-run `import-pi` |
| 2b. **Staged packages** | `<overlay>/packages/<dir>` — per-trigger opt-out | **third-party**, operator-pinned | re-run `import-pi --with-packages` |
| 3. Per-repo `.pi/` | repo's committed `.pi/` (default-branch SHA) | trusted-by-merge | per PR |
| 3b. Repo `AGENTS.md` + `.pi/extensions` | the checkout, which is always the **default-branch SHA** | trusted-by-merge; **extensions execute** | per PR |
| 4. Task/issue text | the webhook / CLI input | **adversarial — never instructions** | — |

- **Skills**: repo skills are listed **first**, so a repo skill **overrides** a global one of the same name
  (pi is first-path-wins); names that don't collide all load.
- **Persona**: the assembled prompt is `guardrails → outbox protocol → global persona → repo persona`. The
  floor is always first and cannot be removed; global is your baseline; the repo's `.pi/APPEND_SYSTEM.md` is
  most specific. The outbox tier is **local jobs only**: it is read only when the `/outbox` mount exists, so
  a forge job's prompt never carries it.
- **Models**: the overlay's `models.json` makes a **custom provider/model** resolvable. Definitions only —
  the credential still comes from the environment, never the overlay.
- **The repo's own files load too** (tier 3b). A job's checkout is always the base repo at its
  **default-branch SHA** — never a PR branch — so its `AGENTS.md` becomes part of the agent's context and
  its `.pi/extensions` are **executed**, which is pi's normal behaviour with one subtraction: the loader's
  recursion guard silently drops any extension whose name looks like the dispatch admin **or** that registers
  a `dispatch_*` tool, logging `extension_dropped`, so a serviced repo's own `dispatch_*` tool is lost inside
  job containers (rename it). Repo *skills*, though, still arrive by the `/job/pi` route above rather than by
  discovery: same files, read from the pinned SHA onto a read-only mount the agent cannot rewrite mid-run. See
  [`SECURITY.md`](../SECURITY.md) for what that posture costs and how to turn it off if you service repos you
  do not control.

## What is copied — and what never is

| Copied into the overlay | Never copied |
|---|---|
| `models.json` (definitions; **refused if it embeds a literal key**) | `auth.json` — your credential stays in env/auth.json |
| `skills/<name>/` | `settings.json`, `sessions/`, `themes/`, `prompts/`, `tools/` |
| `APPEND_SYSTEM.md` (global persona) | anything holding a secret |
| `extensions/` — by default; skip with `--no-extensions`, each one printed by name | the admin extension (hard-blocked) |
| `packages/<dir>/` — only with `--with-packages`, exact-pinned, staged from npm on **your host** | any package whose name looks like the dispatch admin (hard-blocked) |

The overlay is mounted **read-only** into a container that runs adversarial input, so it must hold **no
secret**. `import-pi` refuses a `models.json` with a literal `apiKey`, and equally with a literal value
under an auth-ish provider **header** (a header name carrying `auth`, `api-key`, `token`, `secret` or
`bearer`); move it to `auth.json`, or reference the environment as `"$MY_KEY"`. `doctor` re-checks the
overlay for `auth.json` and literal keys.

A `models.json` that is not valid **JSON** is a different case, and a quieter one: it is **skipped**, with a
`models.json  SKIPPED — not valid JSON` row in the import's output, and the import still **succeeds**. The
overlay then carries no custom model definitions, so read that row.

### Custom providers

If your model uses a provider whose key variable pi's built-in table doesn't know, forward it explicitly:

```bash
# .env
PI_FORWARD_ENV=MY_PROVIDER_KEY      # comma-separated NAMES; forwarded by exact -e NAME=VALUE, never a pass-through
```

### The key is already in pi (on by default)

Logged into pi already? You don't have to restate the key in `.env`. When the provider key is absent from
the worker's environment, the worker reads it **host-side** from `~/.pi/agent/auth.json` and env-injects it
under the variable pi expects — a host-side read of a host-held secret, injected via env exactly like `.env`,
**never a file mounted into the container**. This is **on by default**; the environment still wins when
present. Set `PI_AUTH_FROM_PI=0` to force env-only (fail loudly on a missing env key instead of falling back).

**API-key logins only.** An OAuth/subscription login (`pi login`) is refused: those tokens expire and the
container can't refresh them, and a subscription isn't the credential for an unattended paid service —
configure an API key (with a spend limit) instead.

## Extensions (the sharp edge — staged and loaded by default)

Extensions run **code against adversarial input with open network egress**, and host extensions often carry
MCP-server credentials. They are staged and loaded **by default**, because by the time one reaches the
overlay you have vetted it twice — once by running it in your own `~/.pi/agent`, once by staging it here —
and a third switch is friction rather than safety. The failure the old opt-in caused was quiet: an overlay
present but dormant is a deployment missing the setup its flows were written against, with nothing to read.

1. `pi-dispatch import-pi` copies `extensions/` (verbatim — they are **not** scanned for secrets; the admin
   extension is refused) and **prints every extension it staged, by name**. That printed list is the
   vetting step: read it. Pass `--no-extensions` to skip the directory entirely.
2. They load in every job unless you set `PI_GLOBAL_ALLOW_EXTENSIONS=0`, which keeps them staged but
   dormant. Unset, empty and the legacy `1` all mean load, so an existing `.env` keeps working and still
   says what it always said. **Any other value fails loudly** — the worker refuses to boot, `doctor`
   reports it, the runner refuses the job — because the damaging misreading is now "I thought I had turned
   these off", where before a typo merely left them dormant.

**Three sources of extension code reach a job, and only one of them is this overlay.** Worth stating in one
place, because two of them are easy to forget and #58 originally called the third a non-goal:

| Source | Where it comes from | How to withhold it |
|---|---|---|
| the overlay's `extensions/` | your own host setup, staged here by `import-pi` | `PI_GLOBAL_ALLOW_EXTENSIONS=0` |
| a staged package's extensions | pinned third-party code under `packages/` | `"packages": false` on the trigger |
| the serviced repo's `.pi/extensions` | the repo being worked on, discovered natively by pi | nothing here: it is the repo's own tree |

The third one surprises people, and it is deliberate. pi's normal discovery posture is on
(`noExtensions: false`), and `/workspace` holds the **base repo's default-branch sha**, so what loads is
merge-gated content and never a fork's branch on a pull-request job — which is why this does not reopen the
fork-adversarial hole #58 closed. Precedence runs repo mount, then overlay, then staged packages, then
whatever discovery finds under `/workspace`, first path wins, so a discovered repo extension is last of all
and shadows nothing you staged. The recursion guard drops any extension named like the admin console or
registering a `dispatch_*` tool, wherever it came from.

The rule of thumb inverted with the default: what you would not want running in a job container should not
be in the overlay. Never place the admin extension there (it can enqueue paid jobs — a recursion vector;
`import-pi` blocks it, but treat it as a rule).

## Packages (pinned, per-trigger)

A **pi package** is third-party code from npm that contributes extensions, skills, prompts and themes. This
is also the road a **workflow extension** takes into a job, and what a workflow can and cannot keep across
jobs is its own reference: [`workflows.md`](workflows.md). Every
job runs with `PI_OFFLINE=1`, which makes pi's resolver **refuse to shell out to npm**, so a package cannot
be installed at job time: you stage it on **your host**, into the overlay, and a trigger opts in. Note what
is doing the work here. The container's network is **not** cut off (egress is open, as above, and
[`SECURITY.md`](../SECURITY.md) says so plainly); offline mode is the thing that closes the job-time
install, and the worker sets it on every job while the runner re-asserts it before the loader is built.

```jsonc
// pi-packages.json — scaffolded empty by `pi-dispatch init`; also honours PI_PACKAGES_FILE / --packages-file.
// "version" must be EXACT; "dir" is optional and defaults to `scope__name`.
{ "packages": [ { "name": "@acme/pi-house-skills", "version": "1.4.2", "dir": "house-skills" } ] }
```

```bash
pi-dispatch import-pi --with-packages     # installs each pin into <overlay>/packages/<dir>/
pi-dispatch doctor                        # shows what is staged, and how many triggers have opted out
```

That is all it takes: once staged, packages load for **every** job. If one flow must run without them,
withdraw them on that trigger with `"packages": false` — available on **any** of the four kinds (`cron`,
`label`, `comment`, `pull_request`):

```jsonc
{ "on": { "type": "cron", "id": "nightly", "pattern": "0 3 * * *" },
  "run": { "kind": "local", "folder": "/srv/site", "flow": "tidy", "task": "…", "packages": false } }
```

**Four gates — three that refuse by default, and one you can withdraw.** Extensions are your *own* code.
A package is *someone else's*, so it passes four checks, and each stops a different mistake:

| # | Gate | Default | What it stops |
|---|---|---|---|
| 1 | An **exact** version in `pi-packages.json` (no `^`, `~`, `*`, `latest`) | refuses | a silent upstream minor turning every queued job into a no-op that still reports success |
| 2 | `import-pi --with-packages` stages it on your host | refuses | a live `npm install` of third-party code inside a job container, every run |
| 3 | `"packages"` on a trigger | **loads** | one flow that must not see the staged set — `"packages": false` withdraws it for that trigger alone |
| 4 | The runner validates paths and enforces skill precedence | refuses | a package that did not mount (refused by the runner at container start, before any model call; the daily-cap slot is still taken), and a package skill taking a repo or overlay skill's name (the repo's stays in force) |

Gate 3 is the reason there is no `PI_GLOBAL_ALLOW_PACKAGES` env flag: the decision is **per trigger**, so
one flow can run without a package while every other flow has it — a granularity no env flag can express.
It defaults open for the same reason gates 1 and 2 exist at all: you pinned the version and staged it
deliberately, so the staged set is the set your jobs get. `doctor` shows you what is staged and **how many**
triggers have opted out: a count, never their names, so which flow it was is a question for the triggers
file.

**`--ignore-scripts` is on, and it cuts both ways.** Staging never runs a package's lifecycle scripts —
without that flag, the `install`/`postinstall` of the package **and of every transitive dependency** would
run **as you, on your host**, at stage time. The honest cost: a package that needs a build step, or an
optional dependency, is staged **INCOMPLETE** and may fail at run time. `import-pi` prints a `WARN` line
naming any package that declares one, so you learn it at stage time instead of mid-job.

Two more things worth knowing before you arm one:

- **A staged skill cannot take a repo or overlay skill's name.** The rule on this page holds for packages
  too: repo beats overlay beats package. It takes work, though — pi loads a package's skill paths *first*
  and keeps the first of each name, so left alone the package's version would win. The runner puts the
  protected skill back in force after the load, and logs that the attempt happened. Your job still runs;
  the package's own flow may quietly do less than it claims, because it was written against the procedure
  it shipped. Rename one of them.
- **Staging is all-or-nothing.** If any pin fails to install, fails its version check, is missing a
  dependency, contributes no pi resources, or carries a manifest path that leaves its own directory,
  **nothing is staged at all** — a half-staged set would load some packages and silently skip the rest.

The overlay is mounted read-only and jobs run with `PI_OFFLINE=1` on **every** job (opted in or not), so a
package source can never become a network install from inside a container.

## Reference

`REQ-GLOBAL-PI-OVERLAY` ([requirements](../specs/requirements.md)),
`DES-OPERATOR-GLOBAL-OVERLAY` ([design](../specs/design.md)),
`INT-CONTAINER-RUNTIME-CONTRACT` / `INT-SDK-SESSION-OPTIONS` / `INT-PI-PACKAGES-FILE-CONTRACT` /
`INT-TRIGGERS-FILE-CONTRACT` ([interfaces](../specs/interfaces.md)).
