# The receiver container (issue #82). The one internet-facing process, packaged so the edge can run
# beside Valkey with `docker compose --profile receiver up -d` -- while the worker stays on the HOST
# (DES-WORKER-ON-HOST). Nothing here needs Docker access: the receiver only verifies deliveries and
# enqueues, so no docker.sock is mounted, ever.
#
# Build context is the repo root:  docker build -f receiver/Dockerfile -t pi-dispatch-receiver .
# Prebuilt for amd64+arm64 at ghcr.io/edgehero/pi-dispatch-receiver (.github/workflows/receiver-image.yml).

# Pinned by DIGEST, not tag, and deliberately the SAME pin image/Dockerfile carries: a floating base
# tag is a silent break (CONST-PI-VERSION-PINNED's reasoning, one vendor over), and one shared digest
# is one bump to make instead of two to keep in sync. This is the MANIFEST-LIST digest (amd64 +
# arm64/v8); it resolves to node 22.23.1, clearing the workspace's 22.19.0 engines floor.
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

WORKDIR /app

# Manifests before source, so a source edit does not invalidate the install layer. .npmrc rides along
# because it carries engine-strict=true and npm DOES read a project .npmrc for workspace installs --
# this is the node-floor guard covering the image's own `npm ci`.
COPY package.json package-lock.json .npmrc ./
COPY worker/package.json worker/
COPY receiver/package.json receiver/

# A WORKSPACE-FILTERED install: the receiver workspace plus its `@edgehero/pi-dispatch` workspace
# dependency (npm symlinks node_modules/@edgehero/pi-dispatch -> ../worker; the src COPY below fills
# it). Filtered because a plain root `npm ci` would also install image/runner's tree -- the full pi
# coding agent and @playwright/cli, none of which this always-on edge may even contain. npm resolves
# the filtered tree from the lockfile alone, so the absent image/runner and admin workspaces need not
# be COPY'd at all.
RUN npm ci --omit=dev --workspace receiver --no-audit --no-fund

# Source last: everything above is cacheable and these layers change on every commit. src only --
# tests, deploy templates and .env.example are host/repo concerns, not container runtime.
COPY worker/src worker/src
COPY receiver/src receiver/src

# Container-side defaults, both overridable:
# - RECEIVER_BIND matches the config default (0.0.0.0) but is pinned here as an image fact: a
#   container that bound loopback would be unreachable through any port publish, so this default
#   must never drift with the host-side one. Publishing to 127.0.0.1 is the COMPOSE file's job.
# - PI_TRIGGERS_FILE: the host default (cwd-relative ./triggers.json, what `pi-dispatch init`
#   scaffolds) is meaningless inside an image, so the container names a mount point instead --
#   bind your triggers file to /config/triggers.json read-only (the receiver live-reloads it on
#   change and never writes it). Boot refuses, loudly, when nothing is mounted there.
ENV RECEIVER_BIND=0.0.0.0 \
    PI_TRIGGERS_FILE=/config/triggers.json

# Non-root. The receiver needs no privileges at all -- it reads a mounted file, listens on an
# unprivileged port, and talks to Valkey -- so it gets none: nologin shell, and /app stays
# root-owned (the process can read and execute it, never rewrite it).
RUN useradd --create-home --shell /usr/sbin/nologin --uid 1001 receiver
USER receiver

# RECEIVER_PORT's default; documentation, not enforcement.
EXPOSE 3000

# The receiver's only surface is the webhook handler -- there is deliberately no /health route
# (DES-ADMIN-VIA-PI-EXTENSION: no second surface). A bare GET answers 405 from the verify layer,
# so liveness is "the socket answers HTTP at all": fetch() resolves on ANY status and rejects only
# when nothing is listening, which is exactly the signal wanted.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.RECEIVER_PORT ?? 3000}/`).then(() => process.exit(0), () => process.exit(1))"]

CMD ["node", "receiver/src/cli.mjs", "serve"]
