#!/bin/sh
# UNTESTED EXAMPLE -- a starting point for a non-systemd daemon, not a shipped, verified unit. Adapt it.
#
# pi-dispatch worker launcher for daemon managers that have NO EnvironmentFile mechanism. systemd reads
# `.env` for you via `EnvironmentFile=` (see deploy/worker.service); launchd (macOS) has no equivalent --
# a plist's ProgramArguments cannot name a `.env`. This wrapper closes that gap: launchd execs THIS
# script, which loads the explicit `.env` from the repo root and then hands off to node.
#
# It sources ONLY the declared `.env` (see `.env.example`), never the host login shell: the
# container-boundary rules require an explicit, auditable variable set, not whatever the operator's
# profile happens to export. Nothing here contains a credential -- the secrets live in `.env`, which is
# gitignored and read at runtime.
#
# TRAP: inside pi, `ANTHROPIC_OAUTH_TOKEN` silently takes precedence over `ANTHROPIC_API_KEY`. Set exactly
# one in `.env`; this wrapper only ADDS the `.env` vars on top of the current environment, it does not
# clear a stray pre-existing one, so a leaked host `ANTHROPIC_OAUTH_TOKEN` would still win.
#
# `exec` is load-bearing: it REPLACES this shell with node, so SIGTERM (e.g. from `launchctl bootout`)
# reaches node directly for a graceful drain instead of dying at the shell and orphaning the worker.
#
# One worker per host (DES-CONCURRENCY-3): parallelism is PI_CONCURRENCY inside the single process, not
# multiple daemons. Requires the AOF-enabled Valkey from deploy/docker-compose.yml.

# Resolve repo root relative to this script (deploy/ is one level down).
cd "$(dirname "$0")/.." || exit 1
if [ ! -f .env ]; then echo "worker-env-wrapper: .env not found in $(pwd)" >&2; exit 1; fi
set -a; . ./.env; set +a
exec node worker/src/cli.mjs worker
