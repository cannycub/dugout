# Dugout

A local-first (Electron) desktop app that encapsulates the team's preferred agent workflow:
Jira ticket → test-first single-repo specs → human-approved → executed in isolated sandboxes →
fully-linked PRs. Assistive, never autonomous — the developer is the head coach and makes every
final call. See the v1 PRD in the issue tracker.

## Read first

- **`CONTEXT.md`** — the domain glossary and core invariants. Use this vocabulary exactly.
  Do not violate the listed invariants without an ADR.
- **`docs/adr/`** — architecture decision records. Respect them; add a new one when you make a
  decision that changes an invariant or a port contract.
- **`docs/design/`** — the design-grilling session behind the PRD (background, not binding).

## Issue tracker

Issues and PRDs live as GitHub issues in `cannycub/dugout` (personal account; will migrate to
the company org later).

## Triage labels

`needs-info` (under-specified, kicked back), `ready-for-agent` (triaged, ready to pick up).

## Working agreements

- Build against the **ports** (executor, env/replay, Jira, GitHub, metrics); keep adapters thin
  and swappable. Orchestration depends only on interfaces.
- Test **external behaviour** through the ports with fakes; use real git on throwaway temp
  repos for git mechanics. The orchestration state machine is the highest-value test target.
- Side-effects (Jira, Datadog) are best-effort and must never block the build.
- Keep the React renderer behind the IPC/HTTP abstraction — never call Electron APIs directly
  from components.
- **All UI work MUST use the `frontend-design` skill** — any time you build or change web
  components, pages, or app layout, invoke `frontend-design` first. This is a standing rule,
  not a one-off.
- **Spec content is canonical in git** (the `SpecStore` seam); **SQLite holds only ephemeral,
  rebuildable run-state** (lifecycle status, sandbox/branch bookkeeping). Never persist spec
  content as run-state.

## Testing — the pyramid

Three tiers. Put each piece of behaviour at the lowest tier that can actually prove it.

1. **Unit** — discrete logic through the ports with fakes (the orchestration state machine is the
   highest-value target); real git on throwaway temp repos for git mechanics. The default
   `npx vitest run` suite.
2. **End-to-end** — drives the **UI** and runs **against the fakes** (deterministic). Proves the
   wiring/plumbing through real Electron IPC, not external correctness. `npm run test:e2e`.
3. **Agent integration** — runs against the **real** agent (e.g. real kiro), because ordinary APIs
   fake cleanly but **agent (LLM) responses do not** — only a real run proves the agent behaves
   correctly. The agent is **stateless**, so these are parallel-safe. They **do NOT run in CI**
   (slow, billable, non-deterministic, need secrets) but **MUST be runnable locally as a suite**.
   Suite: `*.agent.test.ts`, run via `npm run test:agent`. They are **structurally excluded** from
   the default `npm test`/CI (a vitest `exclude`), not gated by a runtime flag — a flag silently
   skips and reports green, giving false confidence the agent was tested. They consume
   `KIRO_API_KEY` (and optional `KIRO_BIN`) as inputs and **fail loudly** if absent — never skip.
