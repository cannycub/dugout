# Execute-mode boundary: local clones are canonical, the sandbox is a transient pull-back copy, story-branch ownership alternates by phase

Dugout is local-first and operates on the developer's **own local clones** of declared repos.
The local clone is the canonical home for branches (the story branch stays local until one
end-of-story push), so the execute-mode Sand Castle sandbox is seeded **from** the local clone's
story-branch HEAD and its green spec branch is **pulled back into** the local clone by Dugout —
Dugout is the only thing that ever writes to the developer's machine. To keep the developer's
working tree untouched while a story is in flight, Dugout drives the story branch in a
**dedicated `git` worktree**, and ownership of that branch **alternates by phase**: the harness
is the single writer while a spec is running; the developer is the single writer at every stop.

This pins the seam that ticket #3 (declare repos) feeds: a **declared repo must resolve to a
local clone path/handle** (identity discovered by matching `origin` against the catalog under
developer-chosen workspace roots — see `CONTEXT.md`), which execute mode will later pass into the
sandbox. `ExecuteInput` will gain that local-clone handle when execute mode lands.

## Considered Options

- **Live bind-mount of the working tree into the container** — rejected: not isolated (invariant
  2), unsafe against the developer editing concurrently, and would let a failed build leave the
  working tree dirty (breaks clean-restart, invariant 1).
- **Seed the sandbox from the true remote (GitHub)** — rejected: the story branch is local-only,
  so the remote doesn't have it.
- **Container pushes the green branch into the local clone** — rejected in favour of Dugout
  *pulling* (fetch / git bundle), so the orchestrator controls every mutation to the developer's
  machine and nothing reaches in from inside the container (head coach makes every call).
- **Auto-merge / rebase when the base moved underneath a running spec** — rejected: that is the
  agent steering and silently resolving conflicts. Divergence → **fail + clean restart**
  (invariant 1), reseed from the new HEAD.

## Consequences

- The developer can keep working in the same clone freely: Dugout and the developer operate on
  **different branches in different worktrees**, so there is no mechanical collision with their
  checkout or uncommitted changes.
- The story branch is single-writer-by-phase, not human-forbidden. At any **stop** the developer
  edits AI-written code in place (Dugout opens the worktree in their editor); the commit is
  **human-attributed** and the next spec seeds from their new HEAD — no agent round-trip for a
  rename or small refactor.
- A developer's **foundational** edit at a stop is a **Cascade** trigger: Dugout flags the
  affected downstream specs and the **developer chooses** which to rerun (v1 — no impact-guessing,
  no auto-rewind).
- Human and agent commits must be **distinctly attributed** in history so the developer sees their
  fingerprints on the branch — ownership is felt in the `git log`.
