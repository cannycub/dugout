import { describe, it, expect } from "vitest";
import { makeHarness, declared } from "./test-harness.js";
import type { DraftedSpec } from "./ports/executor.js";

function setup(draftedSpecs: DraftedSpec[]) {
  return makeHarness({
    tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
    draft: draftedSpecs,
  }).orchestrator;
}

describe("spec approval", () => {
  it("approves the drafted spec set as a unit", async () => {
    const orchestrator = setup([
      { repo: "web", markdown: "# Spec A" },
      { repo: "api", markdown: "# Spec B" },
    ]);
    await orchestrator.draftStory("DUG-1", { repos: ["web", "api"].map(declared) });

    const story = await orchestrator.approveStory("DUG-1", {});

    expect(story.status).toBe("approved");
    expect(story.specs.map((s) => s.status)).toEqual(["approved", "approved"]);
  });

  it("defaults replay specs to review-required", async () => {
    const orchestrator = setup([
      { repo: "web", markdown: "# Spec A" },
      { repo: "pipeline", markdown: "# Spec B (replay)", isReplaySpec: true },
    ]);
    await orchestrator.draftStory("DUG-1", { repos: ["web", "pipeline"].map(declared) });

    const story = await orchestrator.approveStory("DUG-1", {});

    expect(story.specs.map((s) => s.reviewRequired)).toEqual([false, true]);
  });

  it("lets the developer mark additional specs review-required at pre-flight", async () => {
    const orchestrator = setup([
      { repo: "web", markdown: "# Spec A" },
      { repo: "api", markdown: "# Spec B" },
    ]);
    await orchestrator.draftStory("DUG-1", { repos: ["web", "api"].map(declared) });

    const story = await orchestrator.approveStory("DUG-1", {
      reviewRequired: ["DUG-1-spec-1"],
    });

    expect(story.specs.map((s) => s.reviewRequired)).toEqual([true, false]);
  });
});
