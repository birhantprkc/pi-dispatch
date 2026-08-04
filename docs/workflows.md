# Workflows: flows, skills, and staged pi extensions

Three different things get called a workflow, and mixing them up is how a deployment ends up running
third-party code it never vetted. This file separates them.

pi-dispatch is the **trigger and the box**. It decides *when* a job runs, *what image* it runs in, and
*what it may spend*. What the agent actually does inside is pi's business, and pi's unit of instruction is
the **skill**. So a workflow here is never a pi-dispatch feature: it is either a skill that calls other
skills, or a pi extension that orchestrates them.

| Term | What it is | Who owns it |
|---|---|---|
| **trigger** | one `{ on, run }` entry in `triggers.json`: what fires, and which flow it runs | you, in a reviewed file |
| **flow** | the skill a trigger names, at `.pi/skills/<flow>/SKILL.md` on the target repo's **default branch** | the target repo |
| **skill** | pi's unit of instruction; a flow is just the entry one | the target repo, or the overlay |
| **workflow extension** | a pi extension that chains skills into stages, with its own state and routing | a third party, staged by you |
| **staged package** | the pinned directory a workflow extension lives in, inside the global overlay | `import-pi --with-packages` |

## The simple case: a flow that calls skills

Nothing to configure. A flow is a skill, and a skill may call other skills, so a two-stage or five-stage
sequence written as prose in `SKILL.md` is already a working workflow. It costs one job, one container and
one budget slot, and the whole chain is visible in that job's transcript.

Reach for more only when you need what prose cannot give you: typed hand-offs between stages, validation
that a stage produced what the next one expects, resumability, or an audit trail separate from the
transcript.

## The structured case: stage a workflow extension

**Nothing installs at job time.** Job containers run with `PI_OFFLINE=1` and, on the shipped image, no
package manager reachable path to the registry — a job that tried to `npm install` a workflow package
would fail on every delivery. So third-party pi packages are installed **on the host, once**, into the
global overlay, and mounted into every job read-only. That is what staging is.

```jsonc
// pi-packages.json, beside your .env
{ "packages": [
  { "name": "@juicesharp/rpiv-workflow", "version": "2.4.0" }
] }
```

```bash
pi-dispatch import-pi --with-packages     # stage into ./pi-global/packages/
pi-dispatch doctor                        # confirms what is staged, and that it is credential-free
```

Versions are **exact** — no `^`, `~`, `*` or `latest`, refused at load. A floating range is the worst
failure this project has: an upstream minor lands, every queued job quietly loses a tool, and the queue
still reports success. Pinning turns that into an edit you make on purpose.

What `--with-packages` does, per entry:

1. `npm install <name>@<version>` in a private staging dir, with `--ignore-scripts` (so no lifecycle script
   of the package or of any dependency runs as you, on your host), `--omit=peer`, and a nested install
   strategy.
2. **Asserts the result rather than trusting the flags**: the staged `package.json` must carry the exact
   pinned version, and every declared dependency must sit inside the package directory. A dependency npm
   hoisted out is a refusal, not a warning, because the staged copy could never import it at run time.
3. Renames the staging dir into place as `packages/<dir>`, defaulting to `scope__name`.
4. Writes `packages/packages.json`, the receipt: what is staged, at which version, in which directory.

Set `PI_GLOBAL_PI_DIR` to the overlay and the staged set lands at `/opt/pi-global/packages/<dir>` in every
container, named by `PI_PACKAGES`. No new mount and no new trust boundary: staged packages ride the same
`:ro` overlay mount the feature already had.

## A worked example, staged and inspected

`@juicesharp/rpiv-workflow@2.4.0` describes itself as chaining skills into typed multi-stage workflows with
audited JSONL state, predicate routing and per-stage output validation. It is a useful example precisely
because pi-dispatch does **nothing special** for it. Staged against this repo's own tooling, the result is:

| What | Result |
|---|---|
| staged directory | `packages/juicesharp__rpiv-workflow`, 8.7 MB |
| `pi` manifest | `{ "extensions": ["./extension.ts"] }`, so it contributes one extension and no skills |
| entry format | TypeScript, which pi loads through jiti; the staged copy carries its own `jiti` |
| dependencies | all three (`@juicesharp/rpiv-config`, `jiti`, `typebox`) nested **inside** the package dir, so the completeness assertion passes and it resolves with egress denied |
| lifecycle scripts | none beyond `test`, so `--ignore-scripts` left nothing unbuilt |
| peers | `@earendil-works/pi-coding-agent` and `@standard-schema/spec`, both omitted by staging, and both referenced only as `import type` in the package, so nothing imports them at run time |
| `dispatch_*` tools | none, so the recursion guard below leaves it alone |

What that establishes is the **staging and loading path**, which is the part this repo owns. It is not a
claim that the extension's own workflows have been run end to end in a job container here, and it is not an
endorsement: it is third-party code that will load in every job. Read its source, or pin an older version
you have read. The list `import-pi` prints is the vetting step.

Any package with a `pi` manifest works the same way, and one staged directory may contribute **extensions,
skills, prompts and themes** at once.

## What the loader does with a staged package

| Property | Behaviour | Why it is that way |
|---|---|---|
| **extension order** | staged package extensions load **last**, after the repo's and the overlay's | first-path-wins, so nothing a package ships can shadow something you wrote |
| **skill collisions** | the **repo's** skill wins a name collision against a package's | pi puts package skill paths first, so precedence is re-imposed after the load rather than merely asserted |
| **the recursion guard** | any extension named like the admin console, or registering a `dispatch_*` tool, is **dropped** and logged | a staged package must not be able to hand the agent the deployment's own control surface |
| **the overlay is `:ro`** | a package that writes beside itself fails | the overlay is deploy-time config mounted into an adversarial-input container |
| **secrets** | the overlay must hold none; `doctor` fails if it does | `:ro` is not confidentiality, and job input is untrusted |
| **per-trigger withdrawal** | `"packages": false` on a trigger withholds the whole staged set from its jobs | changing which flows run third-party code is a reviewed file edit |

`doctor` reports the staged set by `name@version`, fails when a declared directory is missing, fails when a
trigger says `"packages": true` and nothing is staged (that flow would run without its tools and still
exit 0), and fails when a trigger requires packages while `PI_GLOBAL_PI_DIR` is unset.

**One knob does not cover this, and the distinction matters.** `PI_GLOBAL_ALLOW_EXTENSIONS=0` makes the
overlay's own `extensions/` directory dormant. It is not the off switch for staged packages: those are
withheld per trigger with `"packages": false`. If you want neither, do both.

## Where a workflow's state lives

This is the part that decides whether a multi-job workflow is possible at all, and it depends on the
trigger kind. A workflow extension writes its state relative to the working directory, and in a job that
directory is `/workspace`:

| Trigger kind | `/workspace` is | So state | Watch out for |
|---|---|---|---|
| `cron` / CLI (`local`) | **your folder**, bind-mounted read-write | **persists** between runs, on your host | the agent edits in place, so a state directory shows up in your tree |
| forge (`github`, `gitlab`, `forgejo`, `azure`) | an **ephemeral clone** of the default-branch sha | **dies with the container** | it is untracked, so a flow told to commit everything can commit it into a pull request |

Add the extension's state directory to the repo's `.gitignore` before you arm a forge trigger. For
`@juicesharp/rpiv-workflow` that is `.rpiv/`.

Two supported ways to continue work **across** jobs:

- **`"resume": true`** on the trigger continues the pi session the previous job for the same key produced.
  It persists the whole transcript to host disk, which is a real disclosure and refuses to run at all when
  no store is configured. Read [`sessions.md`](sessions.md) first.
- **Job chaining** through `/outbox`: a finished job may request a follow-up job. It is **local jobs only**
  (a forge parent gets no `/outbox` mount), depth-bounded, and gated on the target flow carrying
  `ai-trigger: allow`.

## What is not supported

- **Installing anything at job time.** No network for the registry, by design.
- **A package that needs a build step.** `--ignore-scripts` means a `prepare`/`postinstall` never ran;
  `import-pi` warns that the staged copy is incomplete, and it may fail at run time. Stage a package that
  publishes its built output.
- **Runtime imports of omitted peers.** pi aliases its own package at load, so a pi peer is fine. Any other
  peer that is imported as a **value** will not resolve in the container. Type-only peers are erased and
  cost nothing.
- **Editing the packages flag from the panel or an AI tool.** Both deliberately refuse: the panel displays
  each trigger's packages state and the staged `name@version` set, and changing it stays a file edit.
- **GitHub Actions, GitLab CI, Azure Pipelines.** pi-dispatch is the trigger and the box; CI stays your
  repo's business. If you meant a CI workflow rather than a pi workflow, nothing here applies.

The overlay itself, including how `import-pi` decides what is safe to copy, is
[`global-pi-overlay.md`](global-pi-overlay.md). The trust posture for third-party code in a job container
is in [`../SECURITY.md`](../SECURITY.md).
