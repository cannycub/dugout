import type { StorySpecs } from "../domain.js";

/**
 * Canonical spec content store — the git-canonical contract (markdown + approved plan).
 * Abstracts *where* spec content lives (in-target-repo, sidecar, or an in-memory fake) so the
 * orchestration and ports never depend on the location (CONTEXT.md invariant 4).
 *
 * v1 adapter: in-memory fake. Later: real git, written to spec files on the story branches and
 * carried into the per-repo PRs (tested against real git on throwaway temp repos).
 */
export interface SpecStore {
  /** Persist (insert or replace) the canonical contract for a story's fan-out. */
  putStory(story: StorySpecs): void;
  get(storyKey: string): StorySpecs | undefined;
}
