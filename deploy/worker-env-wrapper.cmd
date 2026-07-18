@echo off
REM UNTESTED EXAMPLE -- a starting point for a Windows service, not a shipped, verified unit. Adapt it.
REM
REM pi-dispatch worker launcher for Windows service managers (nssm; see deploy/nssm-install.cmd). Windows
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

node worker\src\cli.mjs worker
exit /b %ERRORLEVEL%
