import { describe, it, expect } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { FakeJira } from "./fakes/fake-jira.js";
import { FakeExecutor } from "./fakes/fake-executor.js";
import { FakeGitHub } from "./fakes/fake-github.js";
import { declared } from "./test-harness.js";
import { FakeEnvReplay } from "./fakes/fake-env-replay.js";
import type { MetricsPort } from "./ports/metrics.js";

/** A metrics port that always throws — simulates Datadog being unreachable. */
const throwingMetrics: MetricsPort = {
  emit() {
    throw new Error("Datadog unreachable");
  },
};

describe("best-effort side-effects", () => {
  it("does not let a failing metrics emit wedge the build", async () => {
    const orchestrator = new Orchestrator({
      jira: new FakeJira({
        tickets: [{ key: "DUG-1", title: "Add widget", description: "AC" }],
      }),
      executor: new FakeExecutor({
        draft: { result: "drafted", specs: [{ repo: "web", markdown: "# A" }] },
      }),
      github: new FakeGitHub(),
      metrics: throwingMetrics,
      envReplay: new FakeEnvReplay(),
    });

    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await orchestrator.approveStory("DUG-1", {});

    const story = await orchestrator.runStory("DUG-1");

    // The build completes despite metrics throwing (invariant 7).
    expect(story.status).toBe("dev-complete");
    expect(story.specs[0]!.status).toBe("merged");
  });
});
