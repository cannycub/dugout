// Thin re-export so the rest of the core depends on one alias for Sandcastle's run(),
// the injected test seam for execute mode (mirrors runKiro for draft). ADR-0011.
import type { run } from "@ai-hero/sandcastle";

/** The execute-mode test seam: Sandcastle's run(). Unit tests pass a fake of this shape. */
export type SandcastleRun = typeof run;
