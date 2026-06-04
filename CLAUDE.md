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
