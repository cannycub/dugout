import { describe, it, expect } from "vitest";
import { makeHarness, declared } from "./test-harness.js";

/**
 * The lifecycle stream (#27): every story/spec transition emits exactly one typed event through the
 * LifecyclePort, in transition order — the single test surface for "what moved when".
 */
describe("lifecycle event stream", () => {
  it("emits the full story+spec sequence for a happy single-spec run", async () => {
    const { orchestrator, lifecycle } = makeHarness({ draft: [{ repo: "web", markdown: "# A" }] });

    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await orchestrator.approveStory("DUG-1", {});
    await orchestrator.runStory("DUG-1");

    expect(lifecycle.events).toEqual([
      { kind: "story", storyKey: "DUG-1", status: "drafted" },
      { kind: "story", storyKey: "DUG-1", status: "approved" },
      { kind: "story", storyKey: "DUG-1", status: "executing" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-1", status: "running" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-1", status: "green" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-1", status: "merged" },
      { kind: "story", storyKey: "DUG-1", status: "dev-complete" },
    ]);
  });

  it("emits awaiting-review after the merged review-required spec, then executing on resume", async () => {
    const { orchestrator, lifecycle } = makeHarness({
      draft: [
        { repo: "web", markdown: "# A" },
        { repo: "web", markdown: "# B" },
      ],
    });
    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await orchestrator.approveStory("DUG-1", { reviewRequired: ["DUG-1-spec-1"] });
    lifecycle.events.length = 0;

    await orchestrator.runStory("DUG-1");
    expect(lifecycle.events).toEqual([
      { kind: "story", storyKey: "DUG-1", status: "executing" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-1", status: "running" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-1", status: "green" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-1", status: "merged" },
      { kind: "story", storyKey: "DUG-1", status: "awaiting-review" },
    ]);

    lifecycle.events.length = 0;
    await orchestrator.resumeAfterReview("DUG-1");
    expect(lifecycle.events).toEqual([
      { kind: "story", storyKey: "DUG-1", status: "executing" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-2", status: "running" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-2", status: "green" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-2", status: "merged" },
      { kind: "story", storyKey: "DUG-1", status: "dev-complete" },
    ]);
  });

  it("emits spec failed + story failed on a red grade, and executing again on restart", async () => {
    const { orchestrator, lifecycle } = makeHarness({
      draft: [{ repo: "web", markdown: "# A" }],
      execute: { "DUG-1-spec-1": { result: "red", reason: "new failure" } },
    });
    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await orchestrator.approveStory("DUG-1", {});
    lifecycle.events.length = 0;

    await orchestrator.runStory("DUG-1");
    expect(lifecycle.events).toEqual([
      { kind: "story", storyKey: "DUG-1", status: "executing" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-1", status: "running" },
      { kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-1", status: "failed" },
      { kind: "story", storyKey: "DUG-1", status: "failed" },
    ]);

    lifecycle.events.length = 0;
    await expect(orchestrator.restartStory("DUG-1")).resolves.toMatchObject({ status: "failed" });
    expect(lifecycle.events[0]).toEqual({ kind: "story", storyKey: "DUG-1", status: "executing" });
  });

  it("emits pr-created when the PRs open", async () => {
    const { orchestrator, lifecycle } = makeHarness({ draft: [{ repo: "web", markdown: "# A" }] });
    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await orchestrator.approveStory("DUG-1", {});
    await orchestrator.runStory("DUG-1");
    lifecycle.events.length = 0;

    await orchestrator.createPullRequests("DUG-1");
    expect(lifecycle.events).toEqual([{ kind: "story", storyKey: "DUG-1", status: "pr-created" }]);
  });

  it("never lets a throwing lifecycle sink break a transition (best-effort, invariant 7)", async () => {
    const { orchestrator, lifecycle } = makeHarness({ draft: [{ repo: "web", markdown: "# A" }] });
    lifecycle.emit = () => {
      throw new Error("sink down");
    };

    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await orchestrator.approveStory("DUG-1", {});
    const story = await orchestrator.runStory("DUG-1");

    expect(story.status).toBe("dev-complete");
  });
});
