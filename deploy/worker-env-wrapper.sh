#!/bin/sh
# pi-dispatch launcher for daemon managers that have NO EnvironmentFile mechanism. systemd reads
# `.env` for you via `EnvironmentFile=` (see deploy/worker.service); launchd (macOS) has no equivalent --
# a plist's ProgramArguments cannot name a `.env`. This wrapper closes that gap: launchd execs THIS
# script, which loads the explicit `.env` from the repo root and then runs node. Its exit-code
# conversion and signal forwarding are exercised under `sh` by worker/test/service.test.mjs.
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
# One worker per host (DES-CONCURRENCY-3): parallelism is PI_CONCURRENCY inside the single process, not
# multiple daemons. Requires the AOF-enabled Valkey from deploy/docker-compose.yml.

# Resolve repo root relative to this script (deploy/ is one level down).
cd "$(dirname "$0")/.." || exit 1
if [ ! -f .env ]; then echo "worker-env-wrapper: .env not found in $(pwd)" >&2; exit 1; fi
set -a; . ./.env; set +a

# One wrapper serves both daemons, because the gap it closes (no EnvironmentFile under launchd/nssm)
# is identical for both: no argument runs the worker; `receiver` (passed by the derived receiver
# units `pi-dispatch service` renders) runs the webhook receiver.
if [ "$1" = "receiver" ]; then
	set -- node receiver/src/start.mjs
else
	set -- node worker/src/cli.mjs worker
fi

# `exec` is deliberately GONE here (it used to hand this shell's pid straight to node): intercepting
# the exit code needs a parent still alive after node exits. launchd's KeepAlive/SuccessfulExit=false
# relaunches ANY nonzero exit -- including EXIT_POLICY (2, worker/src/exit-code.mjs), the determinate
# config/budget refusal that systemd (RestartPreventExitStatus=2) and nssm (AppExit 2 Exit) both
# deliberately never retry. A relaunch loop against a paid provider is a bill, so the conversion at
# the bottom turns exit 2 into the clean exit KeepAlive leaves stopped.
#
# SIGTERM still reaches node without exec: the trap forwards TERM/INT to the child, and `wait` (unlike
# a foreground command in sh, which blocks trap delivery) is interruptible by a trapped signal, so the
# forwarding is immediate and node gets its full graceful drain.
signaled=0
trap 'signaled=1; kill -TERM "$child" 2>/dev/null' TERM INT
"$@" &
child=$!
wait "$child"
rc=$?
# The double wait is load-bearing: a trapped signal interrupts the FIRST wait early (rc = 128+signum)
# while node is still draining, so a SECOND wait is needed to collect node's real exit code. Guarded
# on both conditions so a normal exit never waits twice -- re-waiting on an already-reaped pid would
# read as 127, clobbering the true code.
if [ "$signaled" -eq 1 ] && [ "$rc" -ge 128 ]; then
	wait "$child"
	rc=$?
fi

if [ "$rc" -eq 2 ]; then
	echo "worker-env-wrapper: policy refusal (exit 2): not restarting; fix the config and start the service again" >&2
	exit 0
fi
exit "$rc"
