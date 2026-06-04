import type { StoryRunState } from "../domain.js";

/**
 * Ephemeral run-state persistence. Holds only the rebuildable lifecycle position of in-flight
 * stories (story + per-spec status) — NOT the canonical spec contract, which lives in the
 * SpecStore (git). Adapters: in-memory (tests) and SQLite (the local app).
 */
export interface RunStateStore {
  /** Insert or replace a story's run-state. */
  save(state: StoryRunState): void;
  get(storyKey: string): StoryRunState | undefined;
  all(): StoryRunState[];
}
