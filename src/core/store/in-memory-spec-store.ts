import type { StorySpecs } from "../domain.js";
import type { SpecStore } from "./spec-store.js";

/**
 * In-memory spec content store standing in for git in the walking skeleton. Deep-copies on
 * write/read so callers can't mutate the "canonical" copy in place.
 */
export class InMemorySpecStore implements SpecStore {
  private readonly stories = new Map<string, StorySpecs>();

  putStory(story: StorySpecs): void {
    this.stories.set(story.key, structuredClone(story));
  }

  get(storyKey: string): StorySpecs | undefined {
    const stored = this.stories.get(storyKey);
    return stored ? structuredClone(stored) : undefined;
  }
}
