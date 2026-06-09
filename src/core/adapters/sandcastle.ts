// Thin re-export so the rest of the core depends on one alias for Sandcastle's seams.
// ADR-0011 §5 (amended by ADR-0015 clause 2): execute mode now drives a *persistent* sandbox via
// createSandbox() — three run()s bracket the build (baseline → build → after) and must share one
// worktree/branch — rather than a one-shot run(). Unit tests pass a fake of this shape.
import type { createSandbox } from "@ai-hero/sandcastle";

/** The execute-mode test seam: Sandcastle's createSandbox(). Returns a reusable `Sandbox` handle. */
export type CreateSandbox = typeof createSandbox;
