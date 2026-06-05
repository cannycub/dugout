# Repo-scope seam: two ports + a façade; declared repos are bound and flow into draft

The seam between "the developer declares which repos a story touches" and "the orchestrator holds
declared repos bound to local clones" is modelled as **two ports plus a plain façade**:

- **`CatalogPort`** — the team catalog (source = the GitHub org), searchable. v1 search is an
  in-memory filter behind this port (swappable to server-side later without touching callers).
- **`WorkspacePort`** — scans the developer's chosen workspace roots and returns discovered
  clones with their `origin` remotes. The only filesystem-touching piece (so it's where the real
  adapter and its fake live; real-git mechanics are tested on throwaway temp repos per CLAUDE.md).
- **`RepoScope`** — a plain composer object (not a port; nothing to swap underneath) exposing
  `search(query) → RepoMatch[]`, `declare(names) → DeclaredRepo[]`, and `rescan()`. It binds
  catalog identities to clones by **normalized remote URL** (ssh↔https, trailing `.git`, casing —
  an internal detail), producing a **`CloneBinding`** that is a discriminated union
  `cloned | not-cloned | ambiguous`. Ambiguity (two local clones, one remote) is surfaced to the
  developer, never auto-resolved (invariant 1 — never guess).

A **declared repo** is a catalog identity bound to a local clone for one story. `draft` now takes
the bound set: **`DraftInput.repos` and `DugoutApi.draft` widen from `string[]` to
`DeclaredRepo[]`** (plain serializable data, safe across IPC). `spec.repo` stays a catalog **name**
(string); clone **paths are machine-local run-state** — re-resolved, never persisted as spec
content (CLAUDE.md / ADR-0004). Execute mode later reads `DeclaredRepo.clone.path` to seed the
sandbox; "not cloned" is selectable at draft and only **blocks at execute**.

## Considered Options

- **Single deep `resolve()` port** — rejected: its fake must simulate both the network catalog and
  the disk scan at once, and caller-side search leaks the catalog into the renderer (against
  CLAUDE.md's "keep the renderer behind the abstraction").
- **Queryable read-model with a branded `RemoteKey` + specification-object queries** — rejected for
  v1: principled but more machinery than needed; its one real insight (normalize the remote as the
  join key) is kept as an internal helper.
- **Keep `draft` names-based, thread paths only at execute** — considered and rejected by the
  developer in favour of binding end-to-end now (one migration, the binding travels with the set).

## Consequences

- Two thin ports with honest fakes; `RepoScope` is the single thing orchestration and the renderer
  program against.
- `DeclaredRepo` crosses IPC as plain data; the existing `repos: string[]` seam
  (`DraftInput`, `Orchestrator.draftStory`, `DugoutApi.draft`) is migrated to `DeclaredRepo[]`.
- The fan-out invariant becomes checkable: `spec.repo ∈ declaredRepos.map(r => r.name)`.
