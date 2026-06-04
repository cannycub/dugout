import { describe, it, expect } from "vitest";
import { makeHarness, draftAndApprove } from "./test-harness.js";

describe("metrics", () => {
  it("emits adoption events across the run, tagged for aggregation, never by developer", async () => {
    const { orchestrator, metrics } = makeHarness({
      draft: [{ repo: "web", markdown: "# Spec A" }],
    });
    await draftAndApprove(orchestrator, ["web"]);
    await orchestrator.runStory("DUG-1");
    await orchestrator.createPullRequests("DUG-1");

    const names = metrics.events.map((e) => e.name);
    expect(names).toContain("spec.merged");
    expect(names).toContain("story.pr_created");

    // Improvement-only: never tagged with a developer identity (invariant 9).
    expect(metrics.events.every((e) => !("developer" in (e.tags ?? {})))).toBe(true);
  });
});
