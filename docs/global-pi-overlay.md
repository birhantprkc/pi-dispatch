# Reuse your existing pi setup — the global overlay

If you already run `pi`, you have a configured `~/.pi/agent`: custom models, global skills, a global persona.
Point pi-dispatch at a **credential-free copy** of it and every job gets it — **layered under each repo's own
`.pi/`**, so a repo can still override or add on top. It works with the **pulled** prebuilt image: this is a
read-only mount, not an image rebuild.

## Enable it

```bash
pi-dispatch import-pi          # stage the safe subset of ~/.pi/agent into ./pi-global
# then in .env:
PI_GLOBAL_PI_DIR=/absolute/path/to/pi-global
pi-dispatch doctor             # verifies the overlay is credential-free
```

`import-pi` reads your host agent dir (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`) and copies a **curated,
credential-free** subset into the overlay dir. Re-run it whenever you change your host setup. Flags:
`--with-extensions` (see below), `--with-packages` / `--packages-file <path>` (see below),
`--from <agentDir>`, `--to <overlayDir>`.

## What layers, and who wins

Four tiers, most-trusted first; each refines but never removes the one above:

| Tier | Source | Trust | Mutable? |
|---|---|---|---|
| 1. Safety floor | baked `HARD_RULES.md` | image, root-owned | no (immutable) |
| 2a. **Global overlay** | `PI_GLOBAL_PI_DIR` → `/opt/pi-global:ro` | **operator, deploy-time** | re-run `import-pi` |
| 2b. **Staged packages** | `<overlay>/packages/<dir>` — armed per trigger | **third-party**, operator-pinned | re-run `import-pi --with-packages` |
| 3. Per-repo `.pi/` | repo's committed `.pi/` (default-branch SHA) | trusted-by-merge | per PR |
| 4. Task/issue text | the webhook / CLI input | **adversarial — never instructions** | — |

- **Skills**: repo skills are listed **first**, so a repo skill **overrides** a global one of the same name
  (pi is first-path-wins); names that don't collide all load.
- **Persona**: the assembled prompt is `guardrails → global persona → repo persona`. The floor is always
  first and cannot be removed; global is your baseline; the repo's `.pi/APPEND_SYSTEM.md` is most specific.
- **Models**: the overlay's `models.json` makes a **custom provider/model** resolvable. Definitions only —
  the credential still comes from the environment, never the overlay.

## What is copied — and what never is

| Copied into the overlay | Never copied |
|---|---|
| `models.json` (definitions; **refused if it embeds a literal key**) | `auth.json` — your credential stays in env/auth.json |
| `skills/<name>/` | `settings.json`, `sessions/`, `themes/`, `prompts/` |
| `APPEND_SYSTEM.md` (global persona) | anything holding a secret |
| `extensions/` — only with `--with-extensions` | the admin extension (hard-blocked) |
| `packages/<dir>/` — only with `--with-packages`, exact-pinned, staged from npm on **your host** | any package whose name looks like the dispatch admin (hard-blocked) |

The overlay is mounted **read-only** into a container that runs adversarial input, so it must hold **no
secret**. `import-pi` refuses a `models.json` with a literal `apiKey` (move it to `auth.json`, or reference
the environment as `"$MY_KEY"`), and `doctor` re-checks the overlay for `auth.json` and literal keys.

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

## Extensions (the sharp edge — opt-in and armed separately)

Extensions run **code against adversarial input with open network egress**, and host extensions often carry
MCP-server credentials. They are therefore **doubly gated**:

1. `pi-dispatch import-pi --with-extensions` copies them (verbatim — they are **not** scanned for secrets;
   the admin extension is refused).
2. They load **only** when you set `PI_GLOBAL_ALLOW_EXTENSIONS=1`. Unset = present but dormant.

Vet every extension before arming, and never place the admin extension in the overlay (it can enqueue paid
jobs — a recursion vector; `import-pi` blocks it, but treat it as a rule).

## Packages (pinned, per-trigger)

A **pi package** is third-party code from npm that contributes extensions, skills, prompts and themes. Jobs
run with **no network**, so a package cannot be installed at job time — you stage it on **your host**, into
the overlay, and a trigger opts in.

```jsonc
// pi-packages.json — scaffolded empty by `pi-dispatch init`; also honours PI_PACKAGES_FILE / --packages-file.
// "version" must be EXACT; "dir" is optional and defaults to `scope__name`.
{ "packages": [ { "name": "@acme/pi-house-skills", "version": "1.4.2", "dir": "house-skills" } ] }
```

```bash
pi-dispatch import-pi --with-packages     # installs each pin into <overlay>/packages/<dir>/
pi-dispatch doctor                        # shows what is staged, and whether anything arms it
```

Then arm it on the triggers that need it — `"packages": true` on a trigger's `run`, on **any** of the four
kinds (`cron`, `label`, `comment`, `pull_request`):

```jsonc
{ "on": { "type": "cron", "id": "nightly", "pattern": "0 3 * * *" },
  "run": { "kind": "local", "folder": "/srv/site", "flow": "tidy", "task": "…", "packages": true } }
```

**Four gates, not two.** Extensions are your *own* code and are doubly gated. A package is *someone else's*
code, so it is gated four times, and each gate refuses a different mistake:

| # | Gate | What it stops |
|---|---|---|
| 1 | An **exact** version in `pi-packages.json` (no `^`, `~`, `*`, `latest`) | a silent upstream minor turning every queued job into a no-op that still reports success |
| 2 | `import-pi --with-packages` stages it on your host | a live `npm install` of third-party code inside a job container, every run |
| 3 | `"packages": true` on a trigger | the whole deployment inheriting a package one flow needed |
| 4 | The runner validates paths and enforces skill precedence | a package that did not mount (refused before any spend), and a package skill taking a repo or overlay skill's name (the repo's stays in force) |

Gate 3 is the reason there is no `PI_GLOBAL_ALLOW_PACKAGES` env flag: arming is **per trigger**, so one
flow can use a package while every other flow runs without it. Nothing loads a staged package otherwise —
staging alone does nothing, which is exactly what `doctor` is there to tell you.

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
