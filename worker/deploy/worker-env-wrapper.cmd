@echo off
REM UNTESTED EXAMPLE -- a starting point for a Windows service, not a shipped, verified unit. Adapt it.
REM
REM pi-dispatch launcher for Windows service managers (nssm; see deploy/nssm-install.cmd). Windows
REM services have no `.env` mechanism, so this wrapper loads `.env` from the repo root itself, then
REM launches node. It reads ONLY the declared `.env` (see `.env.example`), never the host user profile:
REM the container-boundary rules require an explicit, auditable variable set. Nothing here contains a
REM credential -- the secrets live in `.env`, which is gitignored and read at runtime.
REM
REM TRAP: inside pi, ANTHROPIC_OAUTH_TOKEN silently takes precedence over ANTHROPIC_API_KEY. Set exactly
REM one in `.env`.
REM
REM `.env` FORMAT for this loader: KEY=VALUE, one per line. Values MUST be UNQUOTED -- cmd's `set` keeps
REM surrounding quotes as part of the value. `eol=#` skips `#` comment lines; blank lines are ignored.
REM `tokens=1,* delims==` splits on the FIRST `=` only, so values containing `=` (base64, API keys)
REM survive intact.
REM
REM One worker per host (DES-CONCURRENCY-3): parallelism is PI_CONCURRENCY inside the single process, not
REM multiple services. Requires the AOF-enabled Valkey from deploy/docker-compose.yml.

setlocal

REM Resolve repo root relative to this script (deploy\ is one level down).
cd /d "%~dp0.." || exit /b 1

if not exist ".env" (
  echo worker-env-wrapper: .env not found in "%CD%" 1>&2
  exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"

REM One wrapper serves both daemons (see the .sh twin): no argument runs the worker; `receiver`
REM (passed by `pi-dispatch service --receiver`) runs the webhook receiver.
if "%~1"=="receiver" (
  node receiver\src\start.mjs
) else (
  node worker\src\cli.mjs worker
)
set "RC=%ERRORLEVEL%"

REM Exit 2 is EXIT_POLICY (worker\src\exit-code.mjs): a determinate config/budget refusal. nssm's
REM `AppExit 2 Exit` already refuses to restart it, but converting to a clean 0 here keeps ANY service
REM manager pointed at this wrapper from relaunch-looping a refusal into a provider bill (mirrors the
REM .sh twin, which exists for launchd's KeepAlive that cannot exclude a single exit code).
if "%RC%"=="2" (
  echo worker-env-wrapper: policy refusal, exit 2: not restarting; fix the config and start the service again 1>&2
  exit /b 0
)
exit /b %RC%
