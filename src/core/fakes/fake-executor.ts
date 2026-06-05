import type {
  DraftInput,
  DraftOutcome,
  ExecuteInput,
  ExecuteOutcome,
  ExecutorPort,
} from "../ports/executor.js";

export interface FakeExecutorConfig {
  /** Canned draft outcome returned for any draft() call (any DraftOutcome variant). */
  draft: DraftOutcome;
  /** Per-spec execute outcomes keyed by specId. Specs not listed default to green. */
  execute?: Record<string, ExecuteOutcome>;
}

/** In-memory executor adapter returning canned results — no kiro, no Docker. */
export class FakeExecutor implements ExecutorPort {
  /** Records draft() calls in order, so tests can assert the harness threaded continuity. */
  readonly draftCalls: DraftInput[] = [];
  /** Records execute() calls in order, so tests can assert the fixed execution order. */
  readonly executeCalls: ExecuteInput[] = [];

  constructor(private readonly config: FakeExecutorConfig) {}

  async draft(input: DraftInput): Promise<DraftOutcome> {
    this.draftCalls.push(input);
    return this.config.draft;
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
