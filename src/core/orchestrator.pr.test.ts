import { describe, it, expect } from "vitest";
import { makeHarness, draftAndApprove } from "./test-harness.js";

describe("PR creation", () => {
  it("pushes once per repo and opens one fully-linked PR per repo, never auto-merged", async () => {
    const { orchestrator, github } = makeHarness({
      draft: [
        { repo: "web", markdown: "# Spec A" },
        { repo: "api", markdown: "# Spec B" },
      ],
    });
    await draftAndApprove(orchestrator, ["web", "api"]);
    await orchestrator.runStory("DUG-1");

    const prs = await orchestrator.createPullRequests("DUG-1");

    // One PR per repo, never auto-merged (invariant 5).
    expect(prs.map((p) => p.repo).sort()).toEqual(["api", "web"]);
    expect(prs.every((p) => p.autoMerge === false)).toBe(true);

    // A single push per repo's story branch.
    expect(github.pushes.map((p) => p.repo).sort()).toEqual(["api", "web"]);

    // Fully-linked: every PR title carries the story id for traceability.
    expect(github.pullRequests.every((pr) => pr.title.includes("DUG-1"))).toBe(true);

    expect(orchestrator.getStory("DUG-1")!.status).toBe("pr-created");
  });
});
