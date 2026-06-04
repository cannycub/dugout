# ADR 0002 — Use Node's built-in `node:sqlite` for run-state (no native deps)

- **Status:** Accepted
- **Date:** 2026-06-04

## Context

Ephemeral run-state lives in SQLite (CONTEXT.md; ADR-0001). The first implementation used
`better-sqlite3`, a native (compiled) module. Native modules are compiled against a single
runtime ABI (`NODE_MODULE_VERSION`), and Dugout runs SQLite under **two** runtimes:

- the **Node** test runner (Vitest), where the core tests exercise the real store; and
- **Electron's** bundled Node, where the app runs.

Their ABIs differ, so one compiled `better-sqlite3` binary works for only one of them. Making the
tests pass *and* the app run meant rebuilding the module for Electron (`electron-rebuild`) and
then reinstalling for Node before running tests again — an awkward, error-prone loop — plus the
native toolchain (node-gyp/Python) and a flaky prebuilt-binary download.

Node 22+ (and Electron 42, which bundles Node 24) ship **`node:sqlite`**, a SQLite binding built
*into the runtime itself*. Verified: it works on our Node 24 and inside Electron 42 with no flag,
including prepared statements and named parameters.

## Decision

1. **Use `node:sqlite` for the SQLite run-state store.** Because it is part of the runtime, the
   *same* store code runs under Node (tests) and Electron (app) with **no native build and no
   rebuild dance**. Drop `better-sqlite3` and `@electron/rebuild`.
2. **Keep the engine behind the `RunStateStore` interface.** Orchestration depends only on the
   interface (`InMemoryRunStateStore` + the SQLite adapter), so the engine can be swapped in one
   file without touching the state machine.
3. **Treat query results as the untyped DB boundary.** `node:sqlite` returns rows as
   `Record<string, SQLOutputValue>`; we read columns explicitly at the boundary rather than
   force-casting whole rows.

## Consequences

- The native-module ABI problem disappears: no `electron-rebuild`, no node-gyp/Python, no
  prebuilt-binary download, smaller and more reproducible installs, faster CI.
- We accept that `node:sqlite` is **experimental** (Node "Stability 1"): it emits an
  `ExperimentalWarning` and its API may change across Node versions. Mitigated by pinning
  Node/Electron and by the `RunStateStore` seam — reverting to `better-sqlite3` (or another
  engine) is a one-file change.
- We give up `better-sqlite3` conveniences we do not use for run-state: the `.transaction()`
  helper (replaced by a small `BEGIN/COMMIT/ROLLBACK` wrapper), `.pragma()` (use `exec`), and a
  guaranteed extension set (FTS5/RTREE/`loadExtension`). Run-state needs none of these; spec
  **content** (where full-text search might one day matter) lives in git via the SpecStore, not
  SQLite.
