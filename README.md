# Dugout

> The head coach's command post for agent-assisted development.

Dugout is an internal, local-first desktop app that encapsulates our team's preferred
workflow for working with coding agents — from "I picked up a Jira ticket" to "here is a
fully-linked PR ready for peer review."

The metaphor: **the developer is the head coach.** All strategy and every final call — the
spec, the corrections, the `review-required` stops, the merge — live with them. The agent is
the players executing the plays on the field (isolated sandboxes). Dugout never steps onto the
field for you: it is **assistive, never autonomous** — it stops at "PR created, fully linked,"
and never merges or replaces peer review.

## The v1 loop

1. **Pull** the developer's assigned Jira tickets; the dev selects one and **declares the
   repos** in scope.
2. **Draft** — the agent analyses the ticket + code, asks clarifying questions up front, and
   drafts **single-repo specs** that restate the acceptance criteria, insist on test-first
   development, and flag the story's **replay spec(s)**. Too-thin tickets are kicked back as
   `needs-info`.
3. **Review & approve** — the dev iterates on the specs in a PR-review-style feedback loop,
   approves the set as a unit, and marks which specs are **`review-required`** (default-on for
   replay specs).
4. **Execute** — specs run one-by-one in isolated sandboxes seeded from the story-branch HEAD:
   red→green TDD, full-suite green with pre-existing reds baselined, accumulating on a local
   story branch. `review-required` specs stop for code review. Mid-build ambiguity fails the
   spec for a clean restart — agents never guess, never block.
5. **PR** — a single push opens fully-linked PR(s), one per repo, for peer review. Never
   auto-merged.
6. **Coordinate** — Jira stays in sync (status, a subtask per spec, completion comments,
   ID-stamped commits and PR titles) as a best-effort, non-blocking projection.
7. **Measure** — agent-correction and adoption metrics flow to Datadog, for improvement only.

In v1 the **replay** is triggered and verified manually by the developer; v1.5 automates the
trigger once ephemeral environments are available.

## Architecture at a glance

Built around **ports** so the local v1 survives the eventual cloud move (~80% reuse — only the
adapters swap):

- **Executor port** — `draft()` (kiro, read-only, no sandbox) and `execute()` (kiro in a
  [Sand Castle](https://github.com/mattpocock) Docker sandbox). v1 = headless kiro; later =
  cloud worker.
- **Env / replay port** — `provision()` / `runReplay()`. Stubbed in v1.
- **Jira port** — read assigned tickets; write status/subtasks/comments.
- **GitHub port** — push + PR creation.
- **Metrics port** — emits to Datadog.

Specs are **canonical as markdown in git**; only ephemeral run-state lives in SQLite. Jira is a
**projection, not the source of truth.** The React renderer talks to an abstraction (IPC today,
HTTP later), never to Electron directly.

## Tech

Electron · React · headless kiro (executor) · Sand Castle (sandboxes) · SQLite (run-state) ·
Jira · Datadog · AWS Athena (replay output, v1.5+).

## Testing

`npm test` runs the unit suite; `npm run test:e2e` drives the UI against the fakes. The agent
integration tier (`npm run test:agent`) runs against real kiro and is excluded from CI. Execute-mode
agent tests additionally need a running Docker daemon and the Sand Castle sandbox image — build it
once with `npm run build:sandbox` (which disables buildx provenance/SBOM attestations so the image
tag resolves under Docker Desktop's containerd store; see `sandbox/Dockerfile`).

## Status

Early design. The v1 PRD is [issue #1](https://github.com/cannycub/dugout/issues/1).

## Documentation

- **[CONTEXT.md](./CONTEXT.md)** — domain language and core invariants. Read this first.
- **[docs/adr/](./docs/adr/)** — architecture decision records.
- **[docs/design/](./docs/design/)** — the design-grilling session that produced the PRD.
- **[CLAUDE.md](./CLAUDE.md)** — instructions for agents working in this repo.
