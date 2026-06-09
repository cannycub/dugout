import { describe, it, expect } from "vitest";
import { makeHarness, draftAndApprove, declared } from "./test-harness.js";
import { Orchestrator } from "./orchestrator.js";
import { FakeJira } from "./fakes/fake-jira.js";
import { FakeGitHub } from "./fakes/fake-github.js";
import { FakeMetrics } from "./fakes/fake-metrics.js";
import { FakeEnvReplay } from "./fakes/fake-env-replay.js";
import type { DraftedSpec, ExecutorPort } from "./ports/executor.js";

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

  it("merges each green spec into its per-repo story branch, once, in fixed order (ADR-0014)", async () => {
    const { orchestrator, mergeCalls } = setup([
      { repo: "web", markdown: "# Spec A" },
      { repo: "api", markdown: "# Spec B" },
    ]);
    await draftAndApprove(orchestrator, ["web", "api"]);

    await orchestrator.runStory("DUG-1");

    expect(mergeCalls).toEqual([
      { repo: "web", storyKey: "DUG-1", specId: "DUG-1-spec-1" },
      { repo: "api", storyKey: "DUG-1", specId: "DUG-1-spec-2" },
    ]);
  });

  it("passes the story key and the orchestrator-resolved base branch into execute (ADR-0013)", async () => {
    const resolveCalls: Array<[string, string]> = [];
    const { orchestrator, executor } = makeHarness({
      tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
      draft: [{ repo: "web", markdown: "# Spec A" }],
      resolveBaseBranch: async (repo, storyKey) => {
        resolveCalls.push([repo, storyKey]);
        return `story/${storyKey}`; // pretend a story branch already exists (the #8 accumulation case)
      },
    });
    await draftAndApprove(orchestrator, ["web"]);
    await orchestrator.runStory("DUG-1");

    expect(resolveCalls).toEqual([["web", "DUG-1"]]);
    expect(executor.executeCalls[0]).toMatchObject({
      specId: "DUG-1-spec-1",
      repo: "web",
      storyKey: "DUG-1",
      baseBranch: "story/DUG-1",
    });
  });

  it("treats a failed story-branch merge as an operational error: unwinds to failed and rethrows (ADR-0014)", async () => {
    // A merge can't conflict in serial v1 (the spec branch always descends from story HEAD), so a
    // failure signals out-of-band manual git — mechanical, not a spec grade. The spec already graded
    // green, so it must NOT become red/ambiguous; instead the story unwinds to a restartable failed.
    const { orchestrator } = makeHarness({
      tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
      draft: [{ repo: "web", markdown: "# Spec A" }],
      mergeToStoryBranch: async () => {
        throw new Error("merge conflict in story/DUG-1 (out-of-band git state)");
      },
    });
    await draftAndApprove(orchestrator, ["web"]);

    await expect(orchestrator.runStory("DUG-1")).rejects.toThrow(/merge conflict/i);

    const story = orchestrator.getStory("DUG-1")!;
    expect(story.status).toBe("failed");
    expect(story.specs[0]!.status).toBe("failed");
  });

  it("does not wedge the story when execute throws an operational error; marks it failed and rethrows", async () => {
    // A missing clone / Docker-down is an operational error (ADR-0011 §4), not a spec red. The
    // orchestrator must not leave the spec `running` / story `executing` (an unhandled rejection
    // mid-loop) — it unwinds to a restartable `failed` state and rethrows so the dev sees the cause.
    const throwingExecutor: ExecutorPort = {
      draft: async () => ({ result: "drafted", specs: [{ repo: "web", markdown: "# A" }] }),
      execute: async () => {
        throw new Error("execute mode needs a local clone of \"web\" (not cloned).");
      },
    };
    const orchestrator = new Orchestrator({
      jira: new FakeJira({ tickets: [{ key: "DUG-1", title: "Add widget", description: "AC" }] }),
      executor: throwingExecutor,
      github: new FakeGitHub(),
      metrics: new FakeMetrics(),
      envReplay: new FakeEnvReplay(),
      resolveBaseBranch: async () => "main",
    });
    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await orchestrator.approveStory("DUG-1", {});

    await expect(orchestrator.runStory("DUG-1")).rejects.toThrow(/not cloned/i);

    const story = orchestrator.getStory("DUG-1")!;
    expect(story.status).toBe("failed");
    expect(story.specs[0]!.status).toBe("failed");
  });
});
