import { describe, it, expect } from "vitest";
import { makeHarness, draftAndApprove } from "./test-harness.js";
import type { DraftedSpec } from "./ports/executor.js";

function setup(draftedSpecs: DraftedSpec[]) {
  return makeHarness({
    tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
    draft: draftedSpecs,
  });
}

describe("execute mode", () => {
  it("runs an approved spec to green and auto-merges it into the story branch", async () => {
    const { orchestrator } = setup([{ repo: "web", markdown: "# Spec A" }]);
    await draftAndApprove(orchestrator, ["web"]);

    const story = await orchestrator.runStory("DUG-1");

    expect(story.specs[0]!.status).toBe("merged");
    expect(story.status).toBe("dev-complete");
  });

  it("runs all specs in fixed order and ends dev-complete", async () => {
    const { orchestrator, executor } = setup([
      { repo: "web", markdown: "# Spec A" },
      { repo: "api", markdown: "# Spec B" },
    ]);
    await draftAndApprove(orchestrator, ["web", "api"]);

    const story = await orchestrator.runStory("DUG-1");

    expect(executor.executeCalls.map((c) => c.specId)).toEqual([
      "DUG-1-spec-1",
      "DUG-1-spec-2",
    ]);
    expect(story.specs.map((s) => s.status)).toEqual(["merged", "merged"]);
    expect(story.status).toBe("dev-complete");
  });
});
