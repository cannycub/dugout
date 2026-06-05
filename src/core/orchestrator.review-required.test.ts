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
  it("stops after a review-required spec goes green, before the next spec stacks", async () => {
    const { orchestrator, executor } = await setupWithReviewRequiredFirstSpec();

    const story = await orchestrator.runStory("DUG-1");

    expect(story.status).toBe("awaiting-review");
    // The review-required spec is green but NOT yet merged — the dev reviews the code first.
    expect(story.specs[0]!.status).toBe("green");
    // The next spec has not run; nothing stacks on unreviewed code.
    expect(story.specs[1]!.status).toBe("approved");
    expect(executor.executeCalls.map((c) => c.specId)).toEqual(["DUG-1-spec-1"]);
  });

  it("resumes after review: merges the reviewed spec and runs the rest to dev-complete", async () => {
    const { orchestrator, executor } = await setupWithReviewRequiredFirstSpec();
    await orchestrator.runStory("DUG-1");

    const story = await orchestrator.resumeAfterReview("DUG-1");

    expect(story.specs.map((s) => s.status)).toEqual(["merged", "merged"]);
    expect(story.status).toBe("dev-complete");
    expect(executor.executeCalls.map((c) => c.specId)).toEqual([
      "DUG-1-spec-1",
      "DUG-1-spec-2",
    ]);
  });
});
