# Resumable sessions

When a pull request a pi-dispatch job opened gets feedback, the follow-up job is a cold start: new
container, fresh clone, empty transcript. The agent re-explores the repository and re-derives the
decisions it made an hour ago before it can act on a two-line comment.

A trigger can opt into continuing that conversation instead.

```jsonc
{ "on": { "type": "comment", "phrase": "@pi" },
  "run": { "kind": "github", "flow": "fix", "resume": true } }
```

Off by default. A deployment that sets nothing writes nothing to disk and its containers are launched
with exactly the arguments they were before this feature existed.

## Setup

`PI_SESSIONS_DIR` has **no default**, deliberately — unlike `PI_LOGS_DIR`, which falls back to your OS
temp dir. That directory is mode `1777` on POSIX and is not where this belongs.

```bash
mkdir -p ~/.pi-dispatch/sessions && chmod 700 ~/.pi-dispatch/sessions
```

```bash
PI_SESSIONS_DIR=/home/you/.pi-dispatch/sessions
PI_SESSIONS_TTL_DAYS=14        # default 14; 0 = keep forever
PI_SESSION_MAX_BYTES=8388608   # default 8 MiB; 0 = no cap
```

A trigger that sets `"resume": true` while `PI_SESSIONS_DIR` is unset is **refused before it costs
anything**, rather than running unpersisted and looking like it worked. `pi-dispatch doctor` reports the
store whenever a trigger arms the flag.

## Read this before you enable it

**A transcript is the most sensitive thing this system stores.** It holds the issue text, the contents of
every file the agent read, its tool output, and its own reasoning. That is strictly more than
`logs/<jobId>.log` holds — and that one is opt-in and off by default for exactly this reason. Unlike the
raw log, a transcript has to exist for the feature to work at all.

Put the store outside every git repository. The shipped `.gitignore` covers the conventional layout
(a `sessions/` directory) and cannot cover a path it has never seen.

**Who can be handed one.** Sessions are keyed by `(repository, head branch)`, and a branch name is chosen
by anyone who can push to your repository. It is tempting to reason that `pi/issue-7` names issue 7's
work forever — it does not. That branch name is something the agent was *asked* to use; nothing verifies
it, and branches, unlike issue numbers, can be deleted and re-created by someone else. So the population
that can receive a transcript is your repository's **push-access** population.

That is one step wider than the population pi-dispatch already trusts to put code in a job container, and
what they gain is short: the model's own reasoning, and anything a credential-bearing command echoed.
It is worth being concrete about how small that step is: pi-dispatch already lets anyone who can land a
commit on your default branch **run code inside a job container**, with the job token and open network
egress. This lets a slightly wider group **read a transcript**. Wider population, much narrower capability.

**So: do not enable this if you service repositories whose push access you do not control.** If your
deployment is your own repos, or your team's, the people who could be handed a transcript are people who
can already push code the agent will run — and refusing them a transcript would be a lock on the wrong
door. If you run pi-dispatch for repositories belonging to others, `run.resume` is not for you, in the
same way context discovery is not (`SECURITY.md`). Nothing enforces this: no code here can tell the two
situations apart, which is exactly why it is written down in three places. `specs/open-questions.md`
records the full reasoning as `OQ-014`.

**A fork pull request never resumes.** No key is resolved, no mount is created, and the job is identical
to one run before this feature. That is what stops a stranger forking your repo, naming a branch
`pi/issue-7`, and being handed issue 7's history.

**A `run.resume` job refuses to start under `GITHUB_AUTH_SOURCE=gh`.** That source is your whole `gh`
login: full-scope and non-expiring. An env var dies with the container; a transcript is a **file**, and any
command that echoed an auth header put your token in it, permanently. The refusal happens at mint time, so
it costs no budget slot.

Use `GITHUB_AUTH_SOURCE=app` or a short-expiry fine-grained PAT, so the exposure is bounded by an expiry
rather than by whether an agent ever ran a verbose curl. If you want the trade anyway, take it explicitly:

```bash
PI_SESSIONS_ALLOW_GH_SOURCE=1
```

It is a refusal rather than a warning because the asymmetry decides it: a warning is read once at setup,
and the disclosure is permanent and silent.

## What actually gets resumed

| trigger | key |
|---|---|
| issue label / comment on an issue | the `pi/issue-<n>` branch the job is told to push to |
| comment / activity on a pull request | the PR's head branch, read from the forge API |
| cron | the trigger's own `on.id` |
| `pi-dispatch run`, chained `/outbox` jobs | nothing — these never resume |

The issue and pull-request cases converge because they are the same branch: issue #7's job opens PR #8 on
`pi/issue-7`, and a later comment on PR #8 resolves that same branch. That join is why a branch is the key
and not a number.

Cron is the safest case here and worth knowing about on its own: a nightly job that remembers what it did
last night, keyed on an id you wrote yourself.

## When it silently doesn't resume

Every one of these is a **cold start, never a failed job**, and every one is named in the run record's
`session.reason` so you can tell them apart:

| reason | meaning |
|---|---|
| `absent` | first run for this key, or the previous one produced nothing |
| `expired` | older than `PI_SESSIONS_TTL_DAYS` |
| `too-large` | over `PI_SESSION_MAX_BYTES` |
| `unparseable` | the file is not a valid pi session; it is quarantined and a fresh one started |
| `not-a-regular-file` | refused — the store only ever reads regular files |
| `pi-version-changed` | the job image ships a different pi than wrote the transcript |
| `locked` | another job holds this key; this one runs cold rather than interleaving |

`pi-version-changed` is the one that surprises people. A transcript can outlive the pi that wrote it, and
an older session's stored tool-call arguments may not match a newer pi's tool schema. Rather than fail
mid-run, the resume is refused. **Upgrading the job image resets every transcript**, by design.

## Cost

A resumed job starts with the whole prior conversation in its context, so its per-turn token cost is
*higher* even though it should need fewer turns. `PI_MAX_TOKENS` counts that replayed prefill on the first
call, so a long-running key can breach a per-job budget before doing any work.

The run record's `tokens` field already measures this per job. Measure it on your own repository before
assuming resume is cheaper — it is a real trade, not a free win, and `PI_SESSIONS_TTL_DAYS` is the knob
that bounds how long a conversation accumulates.

## What is stored

```
<PI_SESSIONS_DIR>/<hash>/current.jsonl   the transcript
<PI_SESSIONS_DIR>/<hash>/pi-version      which pi wrote it
```

The directory name is a hash, not a readable path, so a branch name never becomes a filesystem path and a
listing of the store names none of your repositories.

The store itself is **never mounted into a container**. Each job gets its own copy, and only a job that
completed successfully has its copy promoted back — so a failed or retried job leaves the stored
transcript exactly as it was.

Deleting the whole directory is always safe: every key degrades to a cold start and nothing else breaks.
