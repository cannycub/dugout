/**
 * Executor port — the primary testable seam. Two modes:
 *  - draft(): kiro read-only, NO sandbox, emits spec markdown (CONTEXT.md invariant 2).
 *  - execute(): kiro inside a Sand Castle sandbox, read-write, emits code + commits (later slice).
 *
 * v1 adapter is headless kiro; later a cloud worker. Orchestration depends only on this interface.
 */

import type { Ticket } from "./jira.js";
import type { DeclaredRepo } from "../repo-scope.js";

export interface DraftInput {
  ticket: Ticket;
  /** Repos declared in scope by the developer, bound to local clones (ADR-0006). */
  repos: DeclaredRepo[];
  /**
   * The developer's answered clarification rounds, oldest-first (ADR-0007). Absent on the first
   * attempt. Named for the head coach's POV at submit time — these are their *current* answers fed
   * back in, not an archive. kiro is one-shot with no session memory, so the harness reconstructs
   * continuity here: the adapter folds these question/answer rounds back into the freshly-assembled
   * prompt so a re-draft converges. The port stays a pure function of its input.
   */
  clarifications?: ClarificationRound[];
}

/**
 * One single-repo spec proposed by the agent's fan-out. The agent does NOT flag replay specs —
 * a replay verification can't be reliably identified from a ticket + code, so the developer
 * designates replay specs at the approval gate instead (ADR-0008).
 */
export interface DraftedSpec {
  repo: string;
  /** Canonical spec markdown. */
  markdown: string;
}

/** One answerable question the agent needs resolved before it can spec without guessing. */
export interface ClarifyingQuestion {
  /** Stable id; the developer's answer is threaded back via {@link ClarificationRound}. */
  id: string;
  /** The question text shown to the developer. */
  prompt: string;
}

/** One completed round of the clarify loop: questions asked, paired with the dev's answers. */
export interface ClarificationRound {
  answers: Array<{ questionId: string; question: string; answer: string }>;
}

/**
 * Outcome of a draft-mode run (ADR-0007). A closed, exhaustively-matchable union keyed on
 * `result`, mirroring {@link ExecuteOutcome}:
 *  - `drafted`            — the fan-out succeeded; `specs` are ready for the approval gate.
 *  - `needs-info`         — the ticket is too thin to spec at all; a terminal kickback (maps to
 *                           the `needs-info` glossary state + Jira label). The TICKET must be
 *                           enriched out of band. The agent stopped rather than guess (invariant 1).
 *  - `needs-clarification`— the agent CAN spec but is blocked on specific, answerable questions;
 *                           a resumable round-trip (dev answers → harness re-drafts).
 */
export type DraftOutcome =
  | { result: "drafted"; specs: DraftedSpec[] }
  | { result: "needs-info"; reason: string }
  | { result: "needs-clarification"; questions: ClarifyingQuestion[] };

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
  /** Analyse ticket + declared repos (read-only) and produce a draft outcome (ADR-0007). */
  draft(input: DraftInput): Promise<DraftOutcome>;
  /** Build the spec inside a sandbox seeded from the story-branch HEAD. */
  execute(input: ExecuteInput): Promise<ExecuteOutcome>;
}
