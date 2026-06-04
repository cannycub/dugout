/**
 * Executor port — the primary testable seam. Two modes:
 *  - draft(): kiro read-only, NO sandbox, emits spec markdown (CONTEXT.md invariant 2).
 *  - execute(): kiro inside a Sand Castle sandbox, read-write, emits code + commits (later slice).
 *
 * v1 adapter is headless kiro; later a cloud worker. Orchestration depends only on this interface.
 */

import type { Ticket } from "./jira.js";

export interface DraftInput {
  ticket: Ticket;
  /** Repos declared in scope by the developer (agent may suggest; dev confirms). */
  repos: string[];
}

/** One single-repo spec proposed by the agent's fan-out. */
export interface DraftedSpec {
  repo: string;
  /** Canonical spec markdown. */
  markdown: string;
  /** The agent flags story-level replay spec(s); these default to `review-required`. */
  isReplaySpec?: boolean;
}

export interface DraftResult {
  specs: DraftedSpec[];
}

export interface ExecuteInput {
  specId: string;
  repo: string;
  markdown: string;
  /** The per-repo story-branch HEAD the sandbox is seeded from. */
  storyBranch: string;
}

/**
 * Outcome of an execute-mode run. `green` = TDD red→green with the full suite passing
 * (pre-existing reds baselined). `ambiguous` = genuine mid-build ambiguity; the spec fails
 * and must be restarted clean (the agent never guesses — invariant 1).
 */
export type ExecuteOutcome =
  | { result: "green"; branch: string }
  | { result: "ambiguous"; reason: string };

export interface ExecutorPort {
  /** Analyse ticket + declared repos (read-only) and draft the fan-out. */
  draft(input: DraftInput): Promise<DraftResult>;
  /** Build the spec inside a sandbox seeded from the story-branch HEAD. */
  execute(input: ExecuteInput): Promise<ExecuteOutcome>;
}
