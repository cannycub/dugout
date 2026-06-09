import { describe, it, expect } from "vitest";
import { makeHarness, declared } from "./test-harness.js";

async function setupWithReviewRequiredFirstSpec() {
  const harness = makeHarness({
    draft: [
      { repo: "web", markdown: "# Spec A" },
      { repo: "api", markdown: "# Spec B" },
    ],
  });
  await harness.orchestrator.draftStory("DUG-1", { repos: ["web", "api"].map(declared) });
  // Developer marks the first spec review-required at pre-flight.
  await harness.orchestrator.approveStory("DUG-1", { reviewRequired: ["DUG-1-spec-1"] });
  return harness;
}

describe("review-required stop", () => {
  it("merges the review-required spec at green, then stops before the next spec runs (ADR-0014)", async () => {
    const { orchestrator, executor, mergeCalls } = await setupWithReviewRequiredFirstSpec();

    const story = await orchestrator.runStory("DUG-1");

    expect(story.status).toBe("awaiting-review");
    // Model B: the spec is merged into the story branch AT green; the dev reviews the integrated
    // result on the story branch (the surface that becomes the PR), not an isolated spec branch.
    expect(story.specs[0]!.status).toBe("merged");
    expect(mergeCalls).toEqual([{ repo: "web", storyKey: "DUG-1", specId: "DUG-1-spec-1" }]);
    // The next spec has not run; nothing stacks until the dev resumes.
    expect(story.specs[1]!.status).toBe("approved");
    expect(executor.executeCalls.map((c) => c.specId)).toEqual(["DUG-1-spec-1"]);
  });

  it("resumes after review: runs the rest to dev-complete WITHOUT re-merging the reviewed spec", async () => {
    const { orchestrator, executor, mergeCalls } = await setupWithReviewRequiredFirstSpec();
    await orchestrator.runStory("DUG-1");

    const story = await orchestrator.resumeAfterReview("DUG-1");

    expect(story.specs.map((s) => s.status)).toEqual(["merged", "merged"]);
    expect(story.status).toBe("dev-complete");
    expect(executor.executeCalls.map((c) => c.specId)).toEqual([
      "DUG-1-spec-1",
      "DUG-1-spec-2",
    ]);
    // spec-1 was merged at the stop (not again on resume); resume only merges spec-2.
    expect(mergeCalls.map((c) => c.specId)).toEqual(["DUG-1-spec-1", "DUG-1-spec-2"]);
  });

  it("resumes to dev-complete when the review-required spec is the LAST (nothing left to run)", async () => {
    // A single review-required spec (e.g. a replay spec, which defaults review-required) merges at
    // green and stops. On resume there is no further spec to run — the story must complete, not get
    // stuck in awaiting-review (regression: Model B left no `green` spec for the old resume to find).
    const harness = makeHarness({ draft: [{ repo: "web", markdown: "# Spec A" }] });
    await harness.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await harness.orchestrator.approveStory("DUG-1", { reviewRequired: ["DUG-1-spec-1"] });
    await harness.orchestrator.runStory("DUG-1");

    const story = await harness.orchestrator.resumeAfterReview("DUG-1");

    expect(story.status).toBe("dev-complete");
    expect(story.specs.map((s) => s.status)).toEqual(["merged"]);
  });
});
