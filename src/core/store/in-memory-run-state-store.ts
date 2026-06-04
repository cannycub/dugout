import type { StoryRunState } from "../domain.js";
import type { RunStateStore } from "./run-state-store.js";

/** In-memory run-state store for tests. */
export class InMemoryRunStateStore implements RunStateStore {
  private readonly states = new Map<string, StoryRunState>();

  save(state: StoryRunState): void {
    this.states.set(state.key, structuredClone(state));
  }

  get(storyKey: string): StoryRunState | undefined {
    const stored = this.states.get(storyKey);
    return stored ? structuredClone(stored) : undefined;
  }

  all(): StoryRunState[] {
    return [...this.states.values()].map((s) => structuredClone(s));
  }
}
