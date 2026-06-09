# Persistence split stays orchestrator-owned: two write cadences, never one `save(story)`

An architecture grill proposed extracting a "StoryStore" — a repository over the SpecStore +
RunStateStore pair that would own the persistence split and expose a unified `save(story)`. On
inspection the extraction doesn't earn its keep, and the unified-save shape would actively introduce
a bug. This ADR records both the rejection and the load-bearing reason, so the suggestion (which any
fresh look at the two `persist*` methods will re-derive) doesn't get re-implemented later.

## Decision

**The persistence split stays where it is — orchestrator-owned, two stores, two write verbs. Do NOT
extract a store-over-stores, and never unify the two writes into a single `save(story)`.**

1. **Two write cadences are the invariant, not an accident.** Spec **content** is canonical-in-git
   and written **rarely** — `persistContent` fires only at `draftStory` and `approveStory`, the two
   points where the contract itself changes. **Run-state** is ephemeral-in-SQLite and written on
   **every transition** — `persistRun` fires at each lifecycle flip (~11 sites). The cadence
   difference *is* the CLAUDE.md rule "never persist spec content as run-state" made mechanical: a
   unified `save(story)` would have exactly one cadence, and it would be the run-state one — committing
   spec markdown to git on every `running`/`green`/`merged` flip.

2. **The orchestrator keeps the logic.** `persistContent`, `persistRun`, and `assemble` live in one
   place with exactly one caller each. A StoryStore would relocate, not remove, that complexity — a
   shallow layer over an already-clean seam (N=1 callers = hypothetical seam, not a real one). The
   renderer never touches the stores; it receives the assembled `Story` via `DugoutApi` return values.

3. **`assemble` is exported and tested as the pure merge function it is.** Its `?? "drafted"`
   status fallback is **deliberately lenient**: a spec present in the canonical contract but unknown
   to run-state assembles at the start of its lifecycle. That fallback is the seed of
   "rebuild ephemeral run-state from canonical content" — the promise that makes SQLite disposable
   (ADR-0002). It must not be tightened into a throw.

4. **If a store-over-stores is ever introduced** (e.g. a future rebuild-from-canonical feature wants
   a home), it MUST expose **two save verbs** — `saveContract` / `saveRunState` — never one, so the
   two cadences stay impossible to conflate. `load` may own rebuild-from-canonical.

## Considered Options

- **Extract a StoryStore with `save(story)` (the grill's proposal).** Rejected. The unified write is
  the trap: every run-state flip would write the contract to git, violating "never persist spec
  content as run-state" and turning the spec's git history into transition noise. And the module
  itself is indirection for ~even gain — one caller, no second implementation, no renderer access.
- **Extract a StoryStore but with split verbs.** Deferred, not adopted: it fixes the trap but still
  adds a layer nothing needs today. Point 4 records the required shape if a real second consumer
  (rebuild, import/export) ever materialises.
- **Tighten `assemble`'s fallback to throw on unknown specs.** Rejected: it breaks the
  rebuild-from-canonical seed (point 3) for no integrity gain — the contract is the source of truth,
  so a contract-spec missing from SQLite is a *recoverable* state, not corruption.

## Consequences

- `assemble` is exported from `src/core/orchestrator.ts` and unit-tested directly
  (`orchestrator.persistence-split.test.ts`), with the lenient fallback pinned by an explicit test
  and an intentionality comment referencing this ADR.
- The SpecStore / RunStateStore seams are unchanged; no new module exists.
- Future architecture reviews that surface "unify the two `persist*` methods" or "extract a Story
  repository" should be answered with this ADR rather than re-litigated.
