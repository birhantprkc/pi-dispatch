# Azure DevOps triggers

An Azure DevOps work item tagged by a project member, or a pull request opened in one, starts the same job
GitHub does: same queue, same container, same budget, same pause windows, same run history.

```jsonc
{ "on": { "type": "label", "any": ["pi:fix"] },
  "run": { "kind": "azure", "flow": "fix", "repository": "widgets", "image": "pi-job:azure" } }
```

Two fields there are Azure-only, and both are explained below: `repository`, because a work item does not
name one, and `image`, because Azure's CLI does not fit in the default one.

## Read this first: the transport is the weakest of the four

**Azure DevOps Service Hooks offer no HMAC.** A subscription can carry HTTP Basic credentials or a static
custom header, and nothing else. That means the credential proves *the sender knew a secret* and says
**nothing about whether the body arrived as it was sent** — anyone holding it can compose any delivery.

Three consequences, none of which pi-dispatch can engineer away:

1. **HTTPS is mandatory.** Over plain HTTP the credential is on the wire in base64, which is not
   encryption. Azure requires HTTPS for Basic auth; do not work around it.
2. **The delivery id comes from the body**, because Azure sends no delivery-id header at all. That is the
   one departure the GitLab arm explicitly refuses — and it refuses it *there* because GitLab has a header,
   which Azure has not. A delivery with no `id` is rejected rather than run undeduplicated.
3. **There is no replay window.** Azure signs no timestamp, so unlike GitLab there is no second line of
   defence: once a job key ages out of the 31-day retention, a captured delivery replays as new paid work.

What still holds: the author gate runs on every delivery, so holding the secret does not let a stranger
name themselves a project member; and every money gate — budget cap, pause windows, branch policies —
applies to a forged delivery exactly as to a real one.

The full reasoning is `OQ-015` in [`specs/open-questions.md`](../specs/open-questions.md). If you are not
comfortable with it, this is the arm not to enable.

## Set it up

```bash
AZURE_ORG_URL=https://dev.azure.com/your-org
AZURE_TOKEN=...                  # a PAT for a dedicated identity -- see the scope trade-off
AZURE_WEBHOOK_MODE=basic         # or: header
AZURE_WEBHOOK_SECRET=...         # for basic: the base64 of "user:password" you set on the subscription
# AZURE_WEBHOOK_HEADER=X-Pi-Secret   # required only when MODE=header
```

`AZURE_WEBHOOK_MODE` is **required** and deliberately not defaulted. Both modes are shared-secret compares
that cover no bytes, so which header carries the secret is something somebody has to have decided — a
default would let you arm an endpoint without ever noticing what its gate does and does not prove.

Then create Service Hook subscriptions (Project Settings → Service hooks → Web Hooks) pointing at
**`/azure`**, for the events you want:

| Event | What it drives |
|---|---|
| Work item created / updated | the tag trigger |
| Work item commented on | the comment trigger |
| Pull request created / updated | the pull_request trigger |
| Pull request commented on | the comment trigger, on a PR |

## Tags are the label analogue, and the DIFF is the trigger

Azure has no `labeled` event. A tag change arrives as `workitem.updated` carrying a before/after pair, and
the set your rule is tested against is **what was added** — not the tags the item currently has.

That distinction is the difference between a working trigger and a runaway bill. If the current set
matched, every later edit of any field on a tagged work item — a retitle, a reassignment, a typo fix —
would start another paid run, forever.

Practical consequences:

- Adding `pi:fix` to a work item fires. Editing its title afterwards does not.
- **Removing** a tag never fires.
- A work item **created** already carrying the tag fires: it changed from having none.
- Tags are one semicolon-separated string on the wire (`"performance;urgent"`); spacing is trimmed, so
  `a; b` and `a;b` behave the same.

## A work item does not name a repository

Azure work items belong to a **project**, and a project may hold many repositories — so nothing in the
delivery says where the agent should work. `run.repository` supplies it, and is **required** on azure
`label` and `comment` triggers and **refused** on every other forge's. A pull request names its own
repository and needs none.

## Who can trigger a job

The actor's **project membership** is resolved from the Graph API. Two calls, not one: the actor is
resolved to a subject descriptor, then that descriptor's memberships are checked against the project's
group. Either can go indeterminate, and either does **503**, never 204.

The actor arrives in two different shapes depending on the event, and this is the sharpest edge on this
forge:

- a **pull request** names them by GUID;
- a **work item** names them only as `"Display Name <email>"`, with no id anywhere.

So the address is matched **anchored** to the trailing `<...>`, never as a substring. The display half is
attacker-settable: someone who names themselves `pi-bot@example.com is not me` must not read as the
harness, or as anyone else.

Your `AZURE_TOKEN` needs to be able to read the Graph (`vso.graph`). If it cannot, every delivery answers
503 rather than silently admitting or refusing anyone.

## The scope trade-off

`CONST-TOKEN-SCOPED-PER-JOB` wants a credential that is repo-scoped, minimally-permissioned **and**
short-lived. Azure is the mirror image of Forgejo: it gives you a real **expiry** (operator-chosen, up to a
year, and your organization can cap it by policy) and **cannot scope below the organization** —
`vso.code_write` grants write to every repository in the org, and there is no per-repository token scope.

So the bound has to come from the **identity**, not the token. Mint the PAT for a dedicated account or
service principal, and set that identity's permissions per repository in Project Settings → Repositories →
Security. The token's scopes select a capability class; the identity's permissions decide where it reaches.

## Branch policies, not a protected flag

Azure has no "protected" boolean. `pi-dispatch` reads the branch **policy** list and treats the default
branch as protected when any policy is both **enabled and blocking** and its scope covers the ref. Two
things that surprise people:

- an **advisory** policy (enabled, not blocking) does not count — it does not stop a push;
- a **prefix**-scoped policy protects branches it does not name: `refs/heads/releases/` covers
  `refs/heads/releases/1.0`.

A policy lookup that fails is a **retry**, never "unprotected" — a token that cannot read policies would
otherwise silently disarm the guard that stops the agent pushing to a protected branch.

## The container needs its own image

Every other forge's CLI is one static binary. Azure's is the Azure CLI plus its `azure-devops` extension:
roughly a gigabyte, with a Python runtime. Putting that in the image every job runs would make the
majority pay for the minority, so it lives in a variant:

```bash
docker build -f image/Dockerfile.azure -t pi-job:azure \
  --build-arg BASE=ghcr.io/edgehero/pi-job:latest .
```

Name it on the trigger with `run.image`. If you forget, the job is **refused before it costs anything**:
the image declares which forges it can serve (`dev.pi-dispatch.forges`) and the pre-spend preflight reads
that label on the inspect it already runs. Without it, the job would run, find no `az`, and fail at step 3
inside a paid container — on every single delivery, looking exactly like a bad agent run.

## What is not supported

- **Azure Pipelines integration.** pi-dispatch is the trigger and the box; CI stays the project's business.
- **TFVC.** Git repositories only.
- **Completing a pull request**, ever (`CONST-MERGE-NEVER-AUTOMATIC`).
- **A label predicate on an azure `pull_request` trigger.** Azure attaches tags to work items and never to
  pull requests, so `any`/`all`/`none` could never match; the loader refuses it rather than letting the
  rule load clean and never fire.
- **Inferring the author gate from the payload.** Membership comes from the API, or the trigger does not
  fire.
