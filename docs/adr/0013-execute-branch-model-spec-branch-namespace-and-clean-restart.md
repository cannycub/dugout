# Execute-mode branch model: spec-branch namespace, story-HEAD seed, clean restart (amends ADR-0011)

ADR-0011 built execute mode (#7) for a **single spec** and explicitly deferred story-branch creation
and accumulation to #8. The #7 code review surfaced three latent defects in how the per-spec branch is
**named and seeded** — harmless while nothing creates the story branch, but they **break the moment #8
accumulates specs**. This ADR settles the branch model so #8 can build accumulation on a correct
foundation (issue #34). It does **not** implement accumulation, the real `merge()`, or scheduling —
those remain #8.

The three defects (all in `KiroExecuteAdapter` / the orchestrator):

1. **D/F ref collision.** The spec branch was `${storyBranch}/${specId}`, nesting *inside* the
   story-branch ref. Git stores refs as files, so a branch `story/DUG-1` cannot coexist with a branch
   `story/DUG-1/s1` (a path is a file or a directory, not both). Once the story branch exists, every
   execute against it dies with `cannot lock ref … exists`.
2. **Never seeded from the story branch.** `storyBranch` was used only to *name* the branch;
   `branchStrategy` passed no `baseBranch`, so the sandbox forked from the clone's checked-out HEAD.
   `ExecuteInput.storyBranch`'s doc — "the HEAD the sandbox is seeded from" — was a false comment.
3. **Restart resumed, not restarted.** On retry the spec branch still existed from the failed attempt;
   Sand Castle ignores `baseBranch` when the branch exists, so it checked out the abandoned commits and
   built on them — violating invariant 1 (clean restart, never resume).

## Decision

**A spec-branch namespace that is a sibling of the story branch, a base branch resolved by the
orchestrator, and adapter-owned spec-branch freshness.**

1. **Branch naming (sibling prefixes, lowercase).** Story branch `story/<key>`; spec branch
   `spec/<key>/<specId>` (e.g. `story/DUG-1`, `spec/DUG-1/s1`). They differ at the *first* path
   segment, so neither is ever a path-prefix of the other — no D/F collision, now or once #8
   materialises the story branch. The **repo segment is dropped** from both: each declared repo is a
   distinct git repository, so the repo name bought no disambiguation within a repo. The `dugout/`
   prefix is dropped too (nothing globs it; `story/`/`spec/` are distinctive enough). The **adapter
   composes the spec-branch name** from the story key + spec id it is handed.

2. **Base branch resolved by the orchestrator: "story branch if it exists, else the repo default."**
   The orchestrator resolves a concrete `baseBranch` per spec and passes it into `execute()`. Today —
   no story branch yet — it always resolves to the repo's default branch (via
   `GitWorkspace.defaultBranch()`, ADR introduced in #7), so behaviour is identical to single-spec #7
   and nothing regresses. When **#8** starts creating and accumulating `story/<key>`, the *same*
   resolver automatically seeds spec N from the accumulated story HEAD — **#8 changes no adapter code**,
   it only makes the branch exist. The orchestrator owns this because it owns the story-branch
   lifecycle.

3. **Clean restart is adapter-owned.** Before `sandcastle.run()`, the adapter deletes any existing
   `spec/<key>/<specId>` in the clone (pruning a stale worktree first if one is pinned to it), so Sand
   Castle re-forks the branch fresh from `baseBranch` every run. The failed attempt's commits are
   **discarded**, not preserved (invariant 1). This happens on *every* run, not just restarts, so the
   adapter needs no "is this a retry" signal and `restartStory` needs no git change.

4. **Ownership split.** The orchestrator decides the **base** (a domain decision tied to the
   story-branch lifecycle); the adapter owns the **spec branch** end to end — its name *and* its
   freshness. This **amends ADR-0011 §1's "the adapter is a thin Sand Castle wrapper"**: the adapter now
   performs one direct git operation on the clone (delete-branch-if-exists / prune-worktree) rather than
   delegating *all* git to Sand Castle. The widening is small and well-scoped; everything else still
   rides Sand Castle.

5. **`ExecuteInput` contract.** `storyBranch: string` is replaced by `storyKey: string` (the raw Jira
   key) plus `baseBranch: string` (the orchestrator-resolved seed). The adapter builds
   `spec/<storyKey>/<specId>` and seeds from `baseBranch`; it no longer round-trips a `story/`-prefixed
   string only to strip it. The orchestrator constructs `story/<key>` itself where it needs the
   story-branch *name* (PR head; #8's `merge()`).

6. **Companion fixes (same review, same area).**
   - **Canonical clone paths.** `GitWorkspace` normalises discovered clone paths via `realpath()` at
     the source, so every consumer gets a canonical path. (The agent test had to `realpath()` the clone
     itself — macOS `tmpdir()` is `/var`→`/private/var` — or Sand Castle's bind-mounted gitdir is
     unmounted. The product seam had the same latent bug.)
   - **Stale-cache rescan.** `RepoScope.declare()` caches its catalog+clone index; a clone deleted or
     moved since app start reads as `not-cloned`. The execute path **rescans once** (`refresh()`) before
     concluding a clone is missing.
   - **A truly-missing clone is an operational error, not a `red` spec outcome.** Per ADR-0011 §4,
     environment failures *throw*; `red` means "the agent ran without ambiguity but the green gate isn't
     met." A missing clone means the agent never ran — grading it `red` would corrupt the term. The
     orchestrator **wraps `execute()`** so an operational throw unwinds the story+spec out of the
     `running`/`executing` limbo into a clean recoverable state and surfaces the error, instead of
     aborting the spec loop mid-flight and escaping as an unhandled rejection. Recovery is: fix the
     environment (re-clone), re-run.
   - The green unit test that asserted the exact no-`baseBranch` `branchStrategy` shape **pinned the
     bug**; it is updated alongside the fix.

## Considered Options

- **Nest the spec branch under the story branch** (`story/<key>/<specId>`, or the issue's own
  `dugout/<key>/<repo>/specs/<specId>`). Rejected: both nest under the story-branch ref and reproduce
  the D/F collision. The constraint is structural (a ref name cannot be a path-prefix of another), not
  cosmetic.
- **A Sand Castle force/recreate flag for clean restart.** Rejected: none exists. Sand Castle's
  `CreateSandboxOptions.baseBranch` is documented as *"ignored when the branch already exists."* Deleting
  the branch host-side before the run is the only lever.
- **Map a missing clone to a `red` spec outcome** (the issue floated "map cleanly to a spec failure").
  Rejected: contradicts ADR-0011 §4 and corrupts the `red` domain term; folding env errors into the
  spec-failure/restart path stretches `red`/`failed` to mean "your machine is misconfigured."
- **Orchestrator owns spec-branch naming** (pass a pre-computed `specBranch`). Rejected: naming and
  freshness are one concern; splitting them (orchestrator names, adapter must still delete) is worse
  cohesion than keeping both in the adapter, which already produces and returns the branch.
- **Keep `storyBranch` and have the adapter strip the `story/` prefix to recover the key.** Rejected as
  a code smell: the orchestrator would add a prefix the adapter immediately removes. Passing the raw
  `storyKey` is the honest input.

## Consequences

- **#8 is unblocked and needs no adapter change** for seeding: it makes `story/<key>` real (the
  `merge()` that stacks green spec branches), and the existing base resolver starts returning it. #8
  still owns accumulation, scheduling (same-repo-serial / cross-repo-parallel), and the dependent
  grading concern (#33 — a false green now compounds across accumulated specs).
- **ADR-0011 §1 is amended:** the adapter is no longer a *pure* Sand Castle wrapper — it does one git
  op (delete-branch / prune-worktree) on the clone. ADR-0011 §2–§5 are unchanged.
- **`ExecuteInput` changes** (`storyBranch` → `storyKey` + `baseBranch`): the port, the adapter, the
  fake executor, the orchestrator call site, and the execute tests are updated together.
- **CONTEXT.md gains a "Spec branch" term** (it was referenced under *Story branch* but never defined)
  and the spec-branch ↔ story-branch seeding/merge relationship is now explicit.
- **Failed attempts leave no branch behind** — a deliberate consequence of clean restart. If forensic
  retention of a failed attempt is ever wanted, it is a new decision (e.g. archive to a dead ref), not
  this one.
