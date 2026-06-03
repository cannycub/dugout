# ADR 0001 — Local-first Electron app built around swappable ports

- **Status:** Accepted
- **Date:** 2026-06-03

## Context

Dugout encapsulates an agent workflow whose unique, hard parts (replay / ephemeral
environments) depend on infrastructure another team is still building. We want to deliver value
quickly without building a multi-tenant cloud platform first, while not painting ourselves into
a corner that forces a rewrite when the cloud version is justified.

The workflow needs to: drive headless kiro for both spec drafting and code execution, run
isolated sandboxes, touch the filesystem (checkouts), spawn subprocesses, and send native
notifications for asynchronous pass/fail.

## Decision

1. **Ship v1 as a local-first Electron app**, one per developer. Electron fits because the
   harness spawns subprocesses (kiro, git, Docker/Sand Castle), touches the filesystem, and
   needs OS notifications — and ships as a single installable.
2. **Build around ports.** Orchestration depends only on interfaces:
   - **Executor** — `draft()` (kiro, read-only, no sandbox) and `execute()` (kiro in a Sand
     Castle sandbox, read-write).
   - **Env/replay** — `provision()`, `runReplay()` (stubbed in v1).
   - **Jira**, **GitHub**, **Metrics (Datadog)**.
3. **The React renderer talks to an abstraction** (IPC → main process today, HTTP → backend
   later), never to Electron APIs directly.
4. **Specs are canonical as markdown in git**; only ephemeral run-state lives in SQLite.

## Consequences

- ~80% of what we build (orchestration state machine, spec model, UI, Jira/CI integration,
  metrics) survives the eventual cloud move; only the executor and env/replay **adapters** swap.
- The cloud version (remote-worker executor, ephemeral-env provisioning, hosted/multi-tenant
  backend) is deferred behind the same ports — see the v1.5 / Later scope markers.
- Drafting reuses headless kiro (not metered API) for cost; continuity is reconstructed by the
  harness re-assembling the prompt each turn (kiro is one-shot per call).
- Electron-specific shell code is the main disposable part; the renderer and core logic are
  portable, contingent on keeping the IPC/HTTP abstraction clean.
