# The job container. One per job, ephemeral, non-root, cap-dropped.
#
# CONST-ISOLATION-CONTAINER-PER-JOB: pi has no permission system, the input is
# adversarial, and this container is therefore the ONLY real security control.
#
# Build context is the repo root:  docker build -f image/Dockerfile .

# Pinned by DIGEST, not tag. CONST-PI-VERSION-PINNED's reasoning is not about pi
# specifically -- a floating base tag is the identical silent break from a different
# vendor. This is the MANIFEST-LIST digest (pinning a per-arch manifest would break
# multi-arch); it resolves to node 22.23.1 and carries amd64 + arm64/v8, so Apple
# Silicon works. 22.23.1 clears pi's 22.19.0 floor.
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ENV DEBIAN_FRONTEND=noninteractive

# Fonts are not cosmetic. bookworm-slim ships none, so Chromium renders tofu boxes:
# screenshots that look plausible and contain no legible text. That would silently gut
# REQ-FRONTEND-VISUAL-VERIFY -- the requirement full Chromium is here for -- while every
# test still passed. fontconfig + a base font set + fc-cache is the fix.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      jq \
      ca-certificates \
      wget \
      fontconfig \
      fonts-liberation \
      fonts-dejavu-core \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# gh CLI, per cli/cli/docs/install_linux.md. No sudo: build stage is already root.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -nv -O /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && mkdir -p -m 755 /etc/apt/sources.list.d \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# The workspace .npmrc's engine-strict does NOT reach a global install: `npm i -g` reads
# only $HOME/.npmrc and $PREFIX/etc/npmrc, never a project file. Set it explicitly or the
# node-floor guard silently does not cover the one install that matters most.
ENV NPM_CONFIG_ENGINE_STRICT=true

# Exact versions, no ranges. pi breaks between MINORS -- a past regression silently dropped
# sendUserMessage after newSession, and the package was renamed mid-flight.
RUN npm install -g --no-fund --no-audit \
      @earendil-works/pi-coding-agent@0.80.7 \
      @playwright/cli@0.1.17

# Set BEFORE the browser install so root-time install and non-root-time lookup agree.
# Root installs would otherwise land in /root/.cache/ms-playwright, which the non-root
# runtime user cannot see -- a direct collision between two of our own constraints.
# @playwright/cli does NOT install browsers; it is a thin wrapper. The standard installer does.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@1.62.0-alpha-1783623505000 install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Non-root. CONST-ISOLATION-CONTAINER-PER-JOB.
RUN useradd --create-home --shell /bin/bash --uid 1001 pi

# pi lazily creates ~/.pi/agent (0700) and writes auth.json (0600) on the FIRST credential
# operation -- ensureParentDir/ensureFileExists run inside withLock. Root-owned means the
# job dies EACCES at runtime, inside the container, on a path nothing here hints at.
#
# `COPY --chown` alone does NOT fix this: it does not apply to parent directories COPY
# auto-creates, so /home/pi/.pi would still be born root:root. The trap survives the
# obvious fix. Create and chown explicitly.
RUN mkdir -p /home/pi/.pi/agent \
    && chown -R pi:pi /home/pi/.pi \
    && chown -R pi:pi /ms-playwright

# The safety floor. Deliberately NOT at ~/.pi/agent/APPEND_SYSTEM.md: a trusted project's
# .pi/APPEND_SYSTEM.md shadows that path via an early return in discoverAppendSystemPromptFile,
# which would delete these rules from the prompt with no error and a job that succeeds. The
# runner reads this path explicitly instead, so discovery cannot shadow it.
COPY --chown=pi:pi guardrails/HARD_RULES.md /opt/pi-dispatch/HARD_RULES.md

COPY --chown=pi:pi image/runner /runner
COPY --chown=pi:pi image/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER pi
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
