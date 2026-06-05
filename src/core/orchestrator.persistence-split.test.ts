import { describe, it, expect } from "vitest";
import { makeHarness, declared } from "./test-harness.js";

describe("persistence split (SpecStore vs RunStateStore)", () => {
  it("stores spec content in the SpecStore and only status in run-state, assembling on read", async () => {
    const { orchestrator, specStore, store } = makeHarness({
      draft: [{ repo: "web", markdown: "# Spec: the canonical contract" }],
    });

    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    // Canonical content lives in the SpecStore (git), with the markdown.
    const content = specStore.get("DUG-1");
    expect(content?.specs[0]?.markdown).toContain("canonical contract");

    // Run-state holds only the lifecycle position — never the spec content.
    const runState = store.get("DUG-1");
    expect(runState?.specs).toEqual([{ specId: "DUG-1-spec-1", status: "drafted" }]);
    expect(JSON.stringify(runState)).not.toContain("canonical contract");

    // getStory assembles both into the view callers see.
    const assembled = orchestrator.getStory("DUG-1");
    expect(assembled?.specs[0]?.markdown).toContain("canonical contract");
    expect(assembled?.specs[0]?.status).toBe("drafted");
  });

  it("writes the approved plan (reviewRequired) into the canonical contract at approval", async () => {
    const { orchestrator, specStore } = makeHarness({
      draft: [
        { repo: "web", markdown: "# A" },
        { repo: "pipeline", markdown: "# B", isReplaySpec: true },
      ],
    });

    await orchestrator.draftStory("DUG-1", { repos: ["web", "pipeline"].map(declared) });
    await orchestrator.approveStory("DUG-1", { reviewRequired: ["DUG-1-spec-1"] });

    // The plan is part of the contract (canonical-in-git), not just run-state.
    const content = specStore.get("DUG-1");
    expect(content?.specs.map((s) => s.reviewRequired)).toEqual([true, true]);
  });
});
