# Building your own job image

Every job runs in a container. By default that is one image for the whole deployment — `PI_JOB_IMAGE`,
usually `pi-job:latest`. A trigger can name its own instead:

```jsonc
{ "on": { "type": "cron", "id": "nightly", "pattern": "0 3 * * *" },
  "run": { "kind": "local", "folder": "/srv/api", "flow": "tidy", "task": "…",
           "image": "my-python:1.2.0" } }
```

`run.image` works on all four trigger kinds. Absent means the deployment default.

## When you need this — and when you don't

You do **not** need a second image for pi *configuration*. Custom models, global skills, a global persona
and staged third-party pi packages all ride the read-only `/opt/pi-global` mount and work with the pulled
prebuilt image — see [global-pi-overlay.md](global-pi-overlay.md).

You need a second image for a **toolchain**: apt packages, a language runtime, system libraries. A
read-only mount cannot deliver those. That is the whole boundary:

> **overlay = pi configuration, mounted, one per deployment.
> image = the operating system the flow needs, built, per flow.**

If two flows want different toolchains, the alternative is one image holding the *union* of both — which
only ever grows, because removing anything might break the other flow.

## Two starting points

**Copy `image/Dockerfile` and add to it.** The honest recommendation: you inherit every property in the
checklist below for free, and the only thing you own is your own `RUN apt-get install …` layer.

**Start from scratch.** Then the next section is a contract, not advice.

## The conformance checklist

The worker assumes all of this and verifies none of it at run time. **Every item fails silently or late**
— that is why the list exists.

| What | What breaks without it | Loud or silent |
|---|---|---|
| Non-root runtime user with a **writable `~/.pi/agent`** | pi cannot write `auth.json`; EACCES inside the container, at run time, on a path no Dockerfile hints at | late, and cryptic |
| `ENTRYPOINT` is the pi-dispatch runner | An image that runs *something else* and exits 0 is recorded by the queue as a **completed job** that never started an agent | **silent** |
| Runner honours the exit-code protocol (0 done / 1 infra / 2 policy) | Node's default exit 1 on a policy failure makes the queue pay to retry work that can never succeed | late, and expensive |
| The **pinned pi version** (`CONST-PI-VERSION-PINNED`) | A stale pi turns every job into a no-op that reports success | **silent** |
| Guardrails at `/opt/pi-dispatch/HARD_RULES.md`, root-owned and agent-unwritable | An agent that can rewrite its own safety floor has none | **silent** |
| `PLAYWRIGHT_BROWSERS_PATH`, `PLAYWRIGHT_MCP_BROWSER`, `PLAYWRIGHT_MCP_SANDBOX` baked in | Frontend flows fail to launch a browser, or launch the wrong one | mixed |
| Fonts installed | Chromium renders tofu boxes: screenshots look plausible and contain no legible text | **silent** |
| The loader flags in `image/runner/src/loader.mjs` | **Security posture is per-image.** A deployment that turned repo-file discovery off for multi-tenancy in one image **has not turned it off in another** | **silent** |

The isolation itself is *not* on this list, and deliberately so: `--cap-drop=ALL`, `no-new-privileges`, the
memory/cpu/pids/shm limits and the four mounts are all applied by the **worker's `docker run` argv**, so
they hold for any image you name. Nothing an image contains can weaken them. What an image decides is
what is *inside* the box, not what the box can do.

## Verify it

The `image` job in `.github/workflows/pi-upgrade-check.yml` is this checklist in executable form. Its
**CORE** steps are the ones any conformant image must pass; its **RUNNER** steps assert things specific to
the runner this repo ships. Run it against your own tag from the Actions tab — *Upstream contract checks →
Run workflow* — and set the `image` input to your tag. With the input set, the build step is skipped and
every assertion runs against what you supply.

## Wire it up

1. **Build or pull it on the machine running the worker.** Jobs launch with `--pull=never`, so the worker
   will **never** fetch an image at job time. This is on purpose: an image name is per-trigger config, and
   a typo must not become a silent pull-and-execute of whatever answers to that name in a registry.
2. **Name it** in `triggers.json` as `run.image`.
3. **Check it**: `pi-dispatch doctor` lists every distinct image your triggers name, fails on one that is
   not present, and warns on one whose entrypoint does not look like the runner.

If the image is missing when a job is picked up, the job is refused **before** it costs anything — no
credential minted, no repo cloned, no budget slot burned — and the refusal names the tag.

Naming an image is an edit to the reviewed `triggers.json`. Neither the `/dispatch` panel nor any
model-callable tool will make that edit for you; the panel shows which image a trigger runs and nothing
more.

## What this project does not check for you

Presence, and only presence. Nothing here inspects an image's contents, and existence is not conformance.
An image you build carries its own pi version, its own runner, its own guardrails floor and its own loader
posture, and none of them are reachable by anything in this repo — see `OQ-012` in
[`specs/open-questions.md`](../specs/open-questions.md) for the honest statement of that gap and what would
close it. Reporting a conformance verdict that had not actually been computed would be worse than reporting
none.
