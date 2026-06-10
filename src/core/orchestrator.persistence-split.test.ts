import { describe, it, expect } from "vitest";
import { makeHarness, declared } from "./test-harness.js";
import { assemble } from "./orchestrator.js";
import type { SpecContent, StorySpecs, StoryRunState } from "./domain.js";

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
        { repo: "pipeline", markdown: "# B" },
      ],
    });

    await orchestrator.draftStory("DUG-1", { repos: ["web", "pipeline"].map(declared) });
    // spec-1 marked review-required; spec-2 designated a replay spec (→ review-required by default).
    await orchestrator.approveStory("DUG-1", {
      reviewRequired: ["DUG-1-spec-1"],
      replaySpecs: ["DUG-1-spec-2"],
    });

    // The plan is part of the contract (canonical-in-git), not just run-state.
    const content = specStore.get("DUG-1");
    expect(content?.specs.map((s) => s.reviewRequired)).toEqual([true, true]);
  });
});

function spec(id: string, order: number, overrides: Partial<SpecContent> = {}): SpecContent {
  return {
    id,
    repo: "web",
    markdown: `# ${id}`,
    isReplaySpec: false,
    reviewRequired: false,
    reviewRecommended: false,
    order,
    ...overrides,
  };
}

describe("assemble (contract + run-state → Story view)", () => {
  const content: StorySpecs = {
    key: "DUG-1",
    title: "ignored — run-state owns the title",
    specs: [spec("DUG-1-spec-2", 2), spec("DUG-1-spec-1", 1)],
  };

  it("merges each spec's run-state status into the contract, in execution order", () => {
    const run: StoryRunState = {
      key: "DUG-1",
      title: "Story title",
      status: "executing",
      specs: [
        { specId: "DUG-1-spec-1", status: "merged" },
        { specId: "DUG-1-spec-2", status: "running" },
      ],
      declaredRepos: ["web"],
    };

    const story = assemble(content, run);

    expect(story.key).toBe("DUG-1");
    expect(story.title).toBe("Story title");
    expect(story.status).toBe("executing");
    expect(story.declaredRepos).toEqual(["web"]);
    expect(story.specs.map((s) => [s.id, s.status])).toEqual([
      ["DUG-1-spec-1", "merged"],
      ["DUG-1-spec-2", "running"],
    ]);
    expect(story.specs[0]?.markdown).toBe("# DUG-1-spec-1");
  });

  it("falls back to 'drafted' for a spec the run-state has never seen (rebuild-from-canonical seed)", () => {
    // Run-state is ephemeral and rebuildable; the canonical contract is not. A spec present in
    // git but absent from SQLite (fresh DB, wiped run-state) must assemble — at the start of the
    // lifecycle — rather than crash or be dropped.
    const run: StoryRunState = {
      key: "DUG-1",
      title: "Story title",
      status: "drafted",
      specs: [{ specId: "DUG-1-spec-1", status: "green" }], // spec-2 unknown to run-state
      declaredRepos: ["web"],
    };

    const story = assemble(content, run);

    expect(story.specs.map((s) => [s.id, s.status])).toEqual([
      ["DUG-1-spec-1", "green"],
      ["DUG-1-spec-2", "drafted"],
    ]);
  });
});
