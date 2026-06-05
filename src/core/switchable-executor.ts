import type {
  DraftInput,
  DraftOutcome,
  ExecuteInput,
  ExecuteOutcome,
  ExecutorPort,
} from "./ports/executor.js";

/** Which executor backs drafting: in-memory fakes, or the real (kiro) live path. */
export type ExecutorMode = "fakes" | "live";

/**
 * Composite executor whose draft path is switchable at runtime between fake and live (kiro)
 * implementations — the developer flips it from the UI without rebuilding the orchestrator, so
 * in-flight state survives. `execute()` always uses the fake: there is no real execute-mode adapter
 * yet (sandboxed build is a later slice), so "live" today means real spec generation only.
 */
export class SwitchableExecutor implements ExecutorPort {
  private mode: ExecutorMode;

  constructor(private readonly deps: { fake: ExecutorPort; live: ExecutorPort; mode: ExecutorMode }) {
    this.mode = deps.mode;
  }

  getMode(): ExecutorMode {
    return this.mode;
  }

  setMode(mode: ExecutorMode): void {
    this.mode = mode;
  }

  draft(input: DraftInput): Promise<DraftOutcome> {
    return (this.mode === "live" ? this.deps.live : this.deps.fake).draft(input);
  }

  execute(input: ExecuteInput): Promise<ExecuteOutcome> {
    return this.deps.fake.execute(input);
  }
}
