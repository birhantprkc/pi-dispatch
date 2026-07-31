# Forgejo (and Gitea) triggers

A Forgejo issue labelled by a collaborator starts the same job a GitHub one does: same queue, same
container, same budget, same pause windows, same run history.

```jsonc
{ "on": { "type": "label", "any": ["pi:fix"] },
  "run": { "kind": "forgejo", "flow": "fix" } }
```

The distinguishing fact, and the reason this arm is small: **Forgejo's webhook transport is byte-compatible
with GitHub's.** It signs the raw body with HMAC-SHA256 and sends `X-Hub-Signature-256`,
`X-GitHub-Delivery` and `X-GitHub-Event`. `receiver/src/verify.mjs` — the trust boundary every downstream
gate depends on — needed **zero changes**, and a forged signature still returns 401 through it. Delivery
dedup transfers unchanged for the same reason.

## Set it up

**1. Mint a token.** Use a **repository-scoped** token ("Specific repositories") carrying only
`write:repository` and `write:issue`. That is genuinely narrower than GitLab's equivalent — there is no
all-or-nothing `api` scope to fall back to.

**2. Tell the harness who it is.** A repository-scoped token **cannot call `GET /user`**, because
`read:user` is not among the four permissions such a token may carry. So set the harness account's numeric
id explicitly:

```bash
FORGEJO_URL=https://forgejo.example.com
FORGEJO_TOKEN=...
FORGEJO_BOT_ID=42          # the harness account's numeric id, from its profile page
FORGEJO_WEBHOOK_SECRET=... # a long random string
```

If you use an account-scoped token that *can* read `/user`, leave `FORGEJO_BOT_ID` unset and it is looked
up. What must not happen is neither: the receiver **refuses to boot** without an identity, because the
bot-loop guard compares the sender against it, and an unresolved identity never matches — so it would fail
open silently, and the harness's own status comments would start more jobs.

**3. Point the webhook at `/forgejo`.** Type "Gitea", content type `application/json`, secret as above,
events: Issues, Issue Comment, Pull Request.

The path matters. Forgejo sends `X-Forgejo-*`, `X-Gitea-*` **and** `X-GitHub-*` on every delivery, so a
header cannot tell it apart from GitHub — and a sender that could choose which gate it faced would choose
the weakest one available. You pick the path when you configure the hook; the sender never picks.

## Actions are Forgejo's own words

This is the one that would otherwise cost you an afternoon. Forgejo reports a label change as
`X-GitHub-Event: issues` with `"action": "label_updated"` — GitHub's event name, its own action word.

| GitHub says | Forgejo says |
|---|---|
| `labeled` | `label_updated` |
| `synchronize` | `synchronized` |
| `opened`, `reopened` | the same |

Write Forgejo's words in your triggers file; the loader refuses the other forge's, so a wrong one is a
message at load rather than a trigger that never fires.

**`label_cleared` fires nothing, ever.** Removing a label must not start a paid run, and it has no GitHub
counterpart to inherit that rule from. It drops under its own reason, so you can see it was recognised and
refused rather than not understood.

## Who can trigger a job

The actor's repository permission is resolved from
`GET /repos/{owner}/{repo}/collaborators/{user}/permission`, and must be `admin` or `write` — for **every**
trigger type, labels included.

Labels on Forgejo very probably *are* self-gating, as they are on GitHub: applying one needs write access.
The gate deliberately does not rest on that. It has not been verified against a running instance across
versions, and the cost of being wrong is a stranger starting paid jobs — so if the label really is the
approval, this check is redundant rather than wrong, which is the cheaper direction to be wrong in.

A lookup that **could not be completed** — a 5xx, a dead socket, a revoked token — answers **503**, not
204. Forgejo redelivers, and the stable delivery GUID dedups the retry. Answering 204 there would drop real
work during an outage behind a response indistinguishable from a stranger being correctly refused.

## The scope trade-off

`CONST-TOKEN-SCOPED-PER-JOB` wants a credential that is repo-scoped, minimally-permissioned **and**
short-lived. Forgejo gives you the first two and **cannot give you the third**: there is no App, no
installation token, no automatic expiry. You mint it by hand and it lives until you revoke it.

Unlike GitHub, there is no stronger path to prefer, so rotation is the whole mitigation. Rotate it, and
scope it to the repositories this deployment actually services.

## What runs in the container

`tea`, not `gh`. The envelope instructs the agent in `tea` prose, because `gh` implements the GitHub API
and a Forgejo job following the GitHub envelope fails at its first `gh pr create` on every run. Forgejo's
*nouns* being GitHub's — issue, pull request, `#n` — is exactly what would make that failure look like a
bad agent rather than a missing tool.

`tea` is pinned to an exact version and verified against a per-architecture sha256, like `glab` and unlike
`gh`. `image/verify-image.sh` checks it is present and that the image's `dev.pi-dispatch.forges` label
agrees.

## What is not supported

- **Gogs.** Same header family, different and less-maintained project.
- **Forgejo Actions.** pi-dispatch is the trigger and the box; CI stays the repo's business.
- **A GitHub App equivalent**, because none exists — see the scope trade-off above.
- **Inferring the author gate from the payload.** Permission comes from the API, or the trigger does not
  fire.

The residual risk this arm shares with GitLab's — a gate that depends on a lookup that can fail — is
`OQ-013` in [`specs/open-questions.md`](../specs/open-questions.md).
