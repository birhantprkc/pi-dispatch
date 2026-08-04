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

`pi-dispatch doctor` reports the store whenever a trigger arms the flag, and fails that check when
`PI_SESSIONS_DIR` is unset. Treat it as your only signal, because a trigger that sets `"resume": true`
with no store configured is **not** refused today: `resolveSession` returns null, the container gets no
`/session` mount, and the job runs cold and completes green, indistinguishable from a job that never set
the flag.

> **Known gap.** `REQ-RESUMABLE-SESSION` specifies this one case as fail-closed: an armed trigger with
> `PI_SESSIONS_DIR` unset should be a pre-spend policy refusal, precisely so it cannot run unpersisted and
> look like it worked. That refusal is **not implemented**. The worker's pre-spend policy returns are the
> image, forge and replica preflights, branch protection and the daily token cap; there is no session gate
> among them, and two comments in `worker/src/session-store.mjs` point at a processor refusal that does not
> exist. Until it lands, run `doctor` rather than assuming a missing store announces itself. Tracked in the
> repo's issues.

## Read this before you enable it

**A transcript is the most sensitive thing this system stores.** It holds the issue text, the contents of
every file the agent read, its tool output, and its own reasoning. That is strictly more than
`logs/<jobId>.log` holds — and that one is opt-in and off by default for exactly this reason. Unlike the
raw log, a transcript has to exist for the feature to work at all.

Put the store outside every git repository. The shipped `.gitignore` covers the conventional layout
(a `sessions/` directory) and cannot cover a path it has never seen.

**Who can be handed one.** Sessions are keyed by `(forge, repository, branch)`, and a branch name is chosen
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
| `pi-dispatch run`, chained `/outbox` jobs | nothing — these never resume |

The issue and pull-request cases converge because they are the same branch: issue #7's job opens PR #8 on
`pi/issue-7`, and a later comment on PR #8 resolves that same branch. That join is why a branch is the key
and not a number.

**Cron resume is not wired up yet.** `run.resume` is accepted on a cron trigger at config load and rides
onto the job's data, but the session store is handed only to the forge preparers: a `kind: "local"` job
returns from `prepareWorkspace` before that point, so nothing ever resolves a key for it. A nightly job
that arms the flag is therefore accepted and then silently ignored, with no `/session` mount and nothing in
the run record to say so. A key for it exists in principle (the trigger's own `on.id`, operator-authored
and stable across fires), which is what makes this a gap rather than a decision. It is tracked as one, like
the missing fail-closed refusal in the Known gap above.

## When it silently doesn't resume

Every one of these is a **cold start, never a failed job**, and every one is named in the run record's
`session.reason` so you can tell them apart:

| reason | meaning |
|---|---|
| `absent` | first run for this key, or the previous one produced nothing |
| `expired` | older than `PI_SESSIONS_TTL_DAYS` |
| `too-large` | over `PI_SESSION_MAX_BYTES` |
| `unparseable` | the first line is not a pi session header. Nothing is quarantined: the canonical file stays where it is and is re-read and re-rejected on every run, until the TTL reaper sweeps the key or a completed run promotes a replacement over it |
| `not-a-regular-file` | ignored, not refused: the check is an `lstat`, so a symlink planted in `/session` is never followed, and the job runs cold |
| `pi-version-changed` | the job image ships a different pi than wrote the transcript |

`pi-version-changed` is the one that surprises people. A transcript can outlive the pi that wrote it, and
an older session's stored tool-call arguments may not match a newer pi's tool schema. Rather than fail
mid-run, the resume is refused. **Upgrading the job image costs every key one cold start**, by design:
nothing is deleted, each key simply cold-starts the first time its stamped version fails to match, and its
next completed run rewrites both the transcript and the stamp.

One further reason reaches `session.reason` without being a read-path outcome at all: `locked`. Only
`promoteSession` produces it, on a **completed** run whose key was already held by another job's exclusive
promotion lock. That run discards its own copy rather than clobbering the other's, and the reason is
recorded to explain why the next run for the key will not see this run's work. Two jobs on one pull request
inside one runtime is a real shape (`REQ-QUEUE-BURST-NO-DROP`), and last-write-wins there would interleave
two agents' turns into one transcript.

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
<PI_SESSIONS_DIR>/<hash>/lock            the one-writer promotion lock; absent when free
```

The directory name is a hash, not a readable path, so a branch name never becomes a filesystem path and a
listing of the store names none of your repositories.

The store itself is **never mounted into a container**. Each job gets its own copy, and only a job that
completed successfully has its copy promoted back — so a failed or retried job leaves the stored
transcript exactly as it was.

Deleting the whole directory is always safe: every key degrades to a cold start and nothing else breaks.
