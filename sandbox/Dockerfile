# Sand Castle sandbox image for Dugout execute mode (#7): a JS toolchain + headless kiro.
#
# This is a PRODUCT artifact, not test-only: it's the image the live app launches containers from
# (orchestrator-host wires docker({ imageName: DUGOUT_SANDBOX_IMAGE ?? "dugout-sandbox:local" })).
# Dugout does NOT create containers — Sand Castle's docker() provider does (docker run/exec/teardown,
# bind-mounting the worktree). We only supply the image. Sand Castle requires that image to:
#   - contain the agent CLI (kiro) + the toolchain the spec's suite needs, and
#   - keep itself alive via `ENTRYPOINT ["sleep", "infinity"]` — Sand Castle relies on the image's
#     entrypoint and injects no keep-alive of its own. (A plain `node:22` entrypoint exits at once,
#     so the container dies before Sand Castle can set it up.)
# kiro authenticates headlessly via KIRO_API_KEY, injected by the kiro agent provider at run time
# (never baked in). Build:  docker build -t dugout-sandbox:local sandbox/
#
# Sand Castle bind-mounts the worktree at the repo dir and overrides the working dir to it at start,
# so WORKDIR is only the pre-start default. Validate end to end with `npm run test:agent` (Docker up
# + KIRO_API_KEY) — the execute agent test fails loudly otherwise.
FROM node:22-bookworm

# Toolchain Sand Castle and the sandboxed suite need: git for the worktree/commits, curl + ca-certs
# for the kiro install. node:22 already ships node + npm + `node --test`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Rename the base image's existing `node` user to `agent` and align UID/GID (Sand Castle convention:
# a non-root `agent` user with home /home/agent). `-o` allows reusing a uid/gid if it already exists.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g ${AGENT_GID} node \
 && usermod -o -u ${AGENT_UID} -g ${AGENT_GID} -d /home/agent -m -l agent node

USER ${AGENT_UID}:${AGENT_GID}
ENV HOME=/home/agent
ENV PATH=/home/agent/.local/bin:${PATH}

# Headless kiro CLI (kiro.dev/docs/cli/headless). Installs to ~/.local/bin (already on PATH above).
RUN curl -fsSL https://cli.kiro.dev/install | bash \
 && kiro-cli --version

WORKDIR /home/agent/workspace

# Keep the container alive for Sand Castle to exec into (it supplies no keep-alive itself).
ENTRYPOINT ["sleep", "infinity"]
