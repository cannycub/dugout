# Sand Castle sandbox image for Dugout execute mode (#7): a JS toolchain + headless kiro.
#
# Sand Castle bind-mounts the worktree and runs the container as a non-root `agent` user
# (home /home/agent, worktree at /home/agent/workspace) — the provider's convention. The agent then
# runs the spec's suite (here `node --test`) and builds red→green. kiro authenticates headlessly via
# KIRO_API_KEY, injected by the kiro agent provider at run time (never baked into the image).
#
# Build:  docker build -t dugout-sandbox:local sandbox/
#
# The container UID/GID must match what docker() runs as. Sandcastle defaults containerUid/Gid to the
# HOST uid/gid; if yours isn't 1000, either rebuild with --build-arg AGENT_UID/AGENT_GID, or pass
# docker({ imageName, containerUid, containerGid }) in the wiring. Validate end to end with
# `npm run test:agent` (Docker up + KIRO_API_KEY) — the execute agent test fails loudly otherwise.
FROM node:22-bookworm

# Toolchain Sand Castle and the sandboxed suite need: git for the worktree/commits, curl + ca-certs
# for the kiro install. node:22 already ships node + npm + `node --test`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Create the `agent` user at the expected uid/gid. The base image already owns uid/gid 1000 (the
# `node` user); drop it first so `agent` can take 1000 cleanly.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN userdel -r node 2>/dev/null || true \
 && groupadd -g ${AGENT_GID} agent \
 && useradd -m -u ${AGENT_UID} -g ${AGENT_GID} -s /bin/bash agent

USER agent
ENV HOME=/home/agent
ENV PATH=/home/agent/.local/bin:${PATH}

# Headless kiro CLI (kiro.dev/docs/cli/headless). Installs to ~/.local/bin (already on PATH above).
RUN curl -fsSL https://cli.kiro.dev/install | bash \
 && kiro-cli --version

WORKDIR /home/agent/workspace
