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
#
# Node 24, NOT 22: the suite a spec builds inside this box may be Dugout's own, and `node:sqlite`
# (ADR-0002/0003) is flag-gated on Node 22/23 and crashes those tests with ERR_UNKNOWN_BUILTIN_MODULE
# — `engines.node` is `>=24`. The toolchain in the sandbox must match the runtime the repo ships on.
FROM node:24-bookworm

# Toolchain Sand Castle and the sandboxed suite need: git for the worktree/commits, curl + ca-certs
# for the kiro install. node:24 already ships node + npm + `node --test`. (apt packages come from
# Debian's GPG-signed repos — verified, though not version-pinned; pinning bookworm point releases is
# brittle and low-value for a rebuilt-on-demand dev image.)
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
# Supply chain: the installer itself fetches a SHA-256 manifest and verifies the downloaded binary
# against it, so the binary is checksum-verified end to end; the script is fetched over HTTPS from the
# kiro vendor domain. The installer exposes NO version pin (only `--channel`, always latest), so we
# pin the channel explicitly and take latest-stable — reproducible version pinning needs kiro to
# publish targetable versioned artifacts (hardening follow-up).
# pipefail (via the bash SHELL) so a failed download fails the build rather than piping a truncated
# script into bash; Docker's default /bin/sh (dash) has no pipefail.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN curl -fsSL https://cli.kiro.dev/install | bash -s -- --channel stable \
 && kiro-cli --version

WORKDIR /home/agent/workspace

# Keep the container alive for Sand Castle to exec into (it supplies no keep-alive itself).
ENTRYPOINT ["sleep", "infinity"]
