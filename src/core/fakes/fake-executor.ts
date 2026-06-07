import type {
  DraftInput,
  DraftOutcome,
  ExecuteInput,
  ExecuteOutcome,
  ExecutorPort,
} from "../ports/executor.js";

export interface FakeExecutorConfig {
  /**
   * Canned draft outcome(s). A single {@link DraftOutcome} is returned for every draft() call; an
   * array is consumed in order (the last element repeats once exhausted), letting a test drive a
   * clarification loop across rounds (round 1 asks → round 2 drafts).
   */
  draft: DraftOutcome | DraftOutcome[];
  /** Per-spec execute outcomes keyed by specId. Specs not listed default to green. */
  execute?: Record<string, ExecuteOutcome>;
  /**
   * Optional artificial delay (ms) before draft() resolves. Real drafting is a slow agent run; a
   * demo/e2e can set this so the "agent is drafting" waiting view is actually observable instead of
   * flashing past. Zero/absent ⇒ resolve immediately (the default for unit tests).
   */
  draftDelayMs?: number;
}

/** In-memory executor adapter returning canned results — no kiro, no Docker. */
export class FakeExecutor implements ExecutorPort {
  /** Records draft() calls in order, so tests can assert the harness threaded continuity. */
  readonly draftCalls: DraftInput[] = [];
  /** Records execute() calls in order, so tests can assert the fixed execution order. */
  readonly executeCalls: ExecuteInput[] = [];

  /** The canned draft outcomes, normalized to a sequence; index advances per draft() call. */
  private readonly draftOutcomes: DraftOutcome[];
  private draftIndex = 0;

  constructor(private readonly config: FakeExecutorConfig) {
    this.draftOutcomes = Array.isArray(config.draft) ? config.draft : [config.draft];
  }

  async draft(input: DraftInput): Promise<DraftOutcome> {
    this.draftCalls.push(input);
    const delay = this.config.draftDelayMs ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    // Advance through the sequence; once exhausted, the last outcome repeats (single-outcome
    // configs are just a length-1 sequence, so they return the same result every call as before).
    const i = Math.min(this.draftIndex, this.draftOutcomes.length - 1);
    this.draftIndex++;
    return this.draftOutcomes[i]!;
  }

  async execute(input: ExecuteInput): Promise<ExecuteOutcome> {
    this.executeCalls.push(input);
    return (
      this.config.execute?.[input.specId] ?? {
        result: "green",
        branch: `${input.specId}-branch`,
      }
    );
  }

  /** Update a spec's canned outcome, e.g. to simulate the dev re-clarifying before a restart. */
  setExecuteOutcome(specId: string, outcome: ExecuteOutcome): void {
    this.config.execute = { ...this.config.execute, [specId]: outcome };
  }
}
