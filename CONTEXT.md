# Dugout — Domain Context

The single source of domain language for Dugout. Use this vocabulary exactly throughout code,
specs, commits, and issues. Decisions here are binding until superseded by an ADR in
`docs/adr/`.

## What Dugout is

A local-first (Electron) desktop app, one per developer, that drives the team's agent workflow
for turning Jira tickets into fully-linked PRs. **Assistive, never autonomous:** it stops at
"PR created," never merges, and never replaces peer review. The developer is the **head coach**
(all decisions); the agent executes.

## Core glossary

- **Story** — a Jira ticket the developer picks up. The top-level unit of work.
- **Spec** — the unit of agent work. **Single-repo.** A story decomposes into one or more
  specs. Each spec restates the relevant acceptance criteria, defines a test-first test plan,
  and maps to exactly one repo → one branch → one PR → one CI run. Specs are **canonical as
  markdown in git**.
- **Fan-out** — the decomposition of a story into its spec set, including order and the repo each
  spec is assigned to (drawn from the story's declared repos). The agent proposes it; the developer
  corrects it at the approval gate, where the developer also designates which spec(s) are replay
  specs (the agent does not — ADR-0008). Reviewed first, because it is the highest-leverage decision.
- **Replay** — data-pipeline reprocessing: a recorded input stream replayed through the entire
  stack, producing gigabytes of output queryable via AWS Athena. The team's primary testing
  method. Output is **human-verified**, never agent-graded.
- **Replay spec** — a story-level spec whose verification is a replay. **Designated by the
  developer at the approval gate** (ADR-0008), not the draft agent. Default `review-required`. In
  v1 the replay is triggered and verified manually outside Dugout.
- **Baseline replay** — one tagged replay run at story start, used as the comparison baseline
  (v1.5+).
- **Draft mode** — executor invocation that reads ticket + code (read-only, **no sandbox**) and
  emits spec markdown. Used for spec generation and the whole review loop.
- **Execute mode** — executor invocation that builds code inside an isolated Sand Castle Docker
  sandbox (read-write), emits code + commits.
- **Story branch** — the per-repo branch onto which green spec branches accumulate locally.
  Stays local until a single end-of-story push.
- **Catalog** — the team-wide list of known repo identities (name + canonical remote). The
  source of repo *suggestions*; team-owned, not machine-specific, and never derived from disk
  layout.
- **Workspace root** — a developer-chosen directory under which Dugout discovers local clones.
  Identity is matched by remote, so no naming or nesting structure is enforced.
- **Declared repo** — a catalog identity the developer puts in scope for a story, bound to their
  local clone. The developer selects them from the (searchable) catalog *before* drafting; no
  agent suggestion. Each spec in the fan-out is then assigned to exactly one declared repo.
- **`review-required`** — a per-spec flag; when set, execution stops after the spec goes green
  for the developer's code review before the next spec stacks on it. Default-on for replay
  specs; the agent recommends it for performance-critical/concurrent specs.
- **`needs-info`** — kickback state when a ticket is too thin to spec; the agent stops rather
  than guess. Also a Jira label.
- **`needs-clarification`** — a *resumable* stop state: the agent **can** spec but is blocked on
  specific, answerable questions. The developer answers and the harness re-drafts — contrast
  `needs-info`, which is terminal-to-Jira (the ticket itself must change). The matched pair of
  "stop, don't guess" outcomes (ADR-0007); the axis between them is whether there is a forward
  move the developer can make in-app.
- **Clarification round** — one completed turn of the `needs-clarification` loop: the questions the
  agent asked paired with the developer's answers (`ClarificationRound`). Draft mode is one-shot
  (no agent session memory), so the harness threads the oldest-first history of rounds back into
  each re-draft to reconstruct continuity.
- **Cascade** — when an earlier change invalidates later specs, whether the agent changing an
  earlier spec or the developer editing foundational code at a stop. v1 policy: **flag** the
  affected downstream specs and let the **developer choose** which to rerun — no magic-rewind,
  no impact-guessing.
- **Stop** — any paused phase (a `review-required` stop, between specs, or at dev-complete)
  during which the **developer is the single writer** on the story branch and may commit
  directly (rename, small refactor, foundational change). Contrast a *running* spec, which only
  the harness writes — the dev never steers a running spec (invariant 1). Ownership of the line
  alternates by phase; "harness-owned" means single-writer-while-running, never human-forbidden.
- **Lifecycle event** — a transition the orchestrator emits as it runs, through the **lifecycle
  port**: a *story-level* status change (`drafted`, `approved`, `executing`, `awaiting-review`,
  `failed`, `dev-complete`, `pr-created`) or a *spec-level* status change (`running`, `green`,
  `merged`, `failed`) emitted per-transition during execution. Fire-and-forget; the renderer
  consumes them to patch its held story by spec id and re-render fluidly (live per-spec progress).
  The core emits a domain event with no wire timestamp; the transport adapter stamps it and
  forwards. Distinct from **metrics**, which are Datadog-bound and **never** reach the UI.
- **Port / adapter** — the interfaces orchestration depends on (executor, env/replay, Jira,
  GitHub, metrics, lifecycle). Adapters swap (local v1 → cloud later); orchestration does not change.

## Core invariants (do not violate without an ADR)

1. **Agents never guess.** Mid-build ambiguity = fail + **clean restart** (not resume). The dev
   never steers a running spec.
   - Exception, not a violation: deliberate, human-directed code-review feedback iterating on
     completed, green code is *not* "resume."
2. **Sandbox only at execution.** Drafting and the review loop use read-only checkouts; no
   sandbox is spun up per edit.
3. **Specs are single-repo.** Cross-repo coordination happens at the story level via
   versioned/back-compat contracts.
4. **Git is canonical for spec content; Jira is a projection.** Content flows git → canonical
   and harness → Jira (status/comments) only. Jira edits never mutate specs.
5. **Human gates are sacred:** spec approval → (v1.5 replay verification) → peer code review →
   merge. Dugout **never auto-merges** and never replaces peer review.
6. **Tests prove logic, not non-functional properties.** Performance and thread-safety are
   verified by humans at `review-required` stops, aided by perf/concurrency directives in the
   methodology prompt and cheap automated checks (e.g. a race detector).
7. **Side-effects are best-effort and non-blocking.** Jira writes and Datadog metrics must
   never wedge the build; they degrade to warnings.
8. **Per-spec green** = the local **full** test suite passing in the sandbox, with pre-existing
   failing tests **baselined**. The real CI on the PR is the final gate.
9. **Metrics are for improvement only** — aggregated by spec/stage/repo/ticket-quality, never
   used to rank developers.

## Persistence

- **Specs:** markdown in git (the relevant repo), version-controlled and diffable.
- **Run-state:** SQLite (ephemeral, rebuildable).
- **Spec ↔ Jira subtask:** subtask id stored in spec frontmatter (idempotent across restarts).

## Scope markers

- **v1:** the loop up to PR creation; replay manual.
- **v1.5:** automatic replay trigger (needs ephemeral envs), tagged baseline replay, prose
  "areas to investigate" guide.
- **Later:** agent-suggested Athena queries, optional auto-execution with cost guards; cloud /
  multi-tenant runtime.
