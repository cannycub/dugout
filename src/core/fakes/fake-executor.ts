import type {
  DraftInput,
  DraftResult,
  ExecuteInput,
  ExecuteOutcome,
  ExecutorPort,
} from "../ports/executor.js";

export interface FakeExecutorConfig {
  /** Canned draft result returned for any draft() call. */
  draft: DraftResult;
  /** Per-spec execute outcomes keyed by specId. Specs not listed default to green. */
  execute?: Record<string, ExecuteOutcome>;
}

/** In-memory executor adapter returning canned results — no kiro, no Docker. */
export class FakeExecutor implements ExecutorPort {
  /** Records execute() calls in order, so tests can assert the fixed execution order. */
  readonly executeCalls: ExecuteInput[] = [];

  constructor(private readonly config: FakeExecutorConfig) {}

  async draft(_input: DraftInput): Promise<DraftResult> {
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
