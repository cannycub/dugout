# Non-functional safeguards (#12)

Tests prove logic, not efficiency or thread-safety. For a performance-sensitive system that gap is
covered by three layers, from cheapest to strongest. This page records what is **enabled today**
and what is **deliberately deferred**.

## Enabled

1. **Methodology directives (prompt-level).** The execute-mode prompt
   (`src/core/adapters/execute-methodology.ts`) carries explicit performance + concurrency
   directives: no new work on hot paths, no avoidable allocation in loops, honour the existing
   locking discipline, never hold a lock across I/O, and **never weaken existing checks** (linters,
   analyzers, race detectors, test strictness) to get to green.

2. **Agent-surfaced assumptions (review-level).** Both agents must make their non-functional
   reasoning visible to the human reviewer rather than burying it:
   - **Draft:** specs state constraining expectations (latency budgets, ordering guarantees, lock
     discipline) under a `Non-functional notes` section, and perf/concurrency-touching specs are
     flagged `[review-recommended]` with a `Review focus:` line (#6) — so they default to a
     `review-required` stop the developer confirms.
   - **Execute:** assumptions made mid-build (load, ordering, acceptable latency) go in the
     relevant commit message body as a `Non-functional assumptions:` paragraph, which lands in the
     PR for peer review.

3. **Repo-owned cheap checks (suite-level).** The per-spec green gate runs the target repo's own
   `testCommand` from `.dugout/config.yaml` (ADR-0015) — twice, harness-observed. That command is
   **the** hook for near-free automated checks, owned by each target repo where its toolchain
   supports them: `go test -race`, `cargo test` with sanitizer profiles, .NET analyzers that fail
   the build, ESLint concurrency/`require-atomic-updates` rules, etc. Because target repos are
   language-agnostic (C#/Python/Rust/TS/…), Dugout does not inject checks itself — it guarantees
   whatever the repo wires into `testCommand` runs on every baseline/after pass, and the
   methodology forbids the agent from weakening them.

## Deferred (out of scope for v1)

- **Perf-budget / benchmark harness.** Asserting latency or throughput budgets per spec needs a
  stable runner environment and per-repo baselines; a Docker sandbox on a developer laptop is
  neither. Revisit when execution moves to consistent infrastructure.
- **Dugout-injected sanitizers.** Auto-adding `-race`/TSan-style flags per toolchain would couple
  Dugout to each language's tooling and silently change what "the repo's suite" means. The repo's
  `testCommand` stays the single owner.
- **Concurrency linters as a Dugout gate.** Same ownership argument: lint config belongs to the
  target repo; Dugout's gate is "the suite the repo defines, unweakened".
