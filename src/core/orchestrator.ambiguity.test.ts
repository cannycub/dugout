import { describe, it, expect } from "vitest";
import { makeHarness, draftAndApprove } from "./test-harness.js";

describe("ambiguity fail + clean restart", () => {
  it("fails the spec and story on mid-build ambiguity, never running downstream specs", async () => {
    const { orchestrator } = makeHarness({
      draft: [
        { repo: "web", markdown: "# Spec A" },
        { repo: "api", markdown: "# Spec B" },
      ],
      execute: {
        "DUG-1-spec-1": { result: "ambiguous", reason: "which auth scheme?" },
      },
    });
    await draftAndApprove(orchestrator, ["web", "api"]);

    const story = await orchestrator.runStory("DUG-1");

    expect(story.specs[0]!.status).toBe("failed");
    expect(story.status).toBe("failed");
    // The agent never guesses and never stacks downstream work on a failed spec.
    expect(story.specs[1]!.status).toBe("approved");
  });

  it("clean-restarts from the failed spec after the dev re-clarifies", async () => {
    const { orchestrator, executor } = makeHarness({
      draft: [
        { repo: "web", markdown: "# Spec A" },
        { repo: "api", markdown: "# Spec B" },
      ],
      execute: {
        "DUG-1-spec-1": { result: "ambiguous", reason: "which auth scheme?" },
      },
    });
    await draftAndApprove(orchestrator, ["web", "api"]);
    await orchestrator.runStory("DUG-1");

    // The dev re-clarifies; the spec now builds green. Restart re-runs it clean (not resume).
    executor.setExecuteOutcome("DUG-1-spec-1", { result: "green", branch: "fixed" });
    const story = await orchestrator.restartStory("DUG-1");

    expect(story.specs.map((s) => s.status)).toEqual(["merged", "merged"]);
    expect(story.status).toBe("dev-complete");
    // The failed spec was executed again from scratch (a fresh run, not a resume).
    expect(executor.executeCalls.filter((c) => c.specId === "DUG-1-spec-1")).toHaveLength(2);
  });

  it("fails the spec and story on a red outcome (built, suite not green), restartable like ambiguity", async () => {
    const { orchestrator } = makeHarness({
      draft: [
        { repo: "web", markdown: "# Spec A" },
        { repo: "api", markdown: "# Spec B" },
      ],
      execute: {
        "DUG-1-spec-1": { result: "red", reason: "3 tests still failing after build" },
      },
    });
    await draftAndApprove(orchestrator, ["web", "api"]);

    const story = await orchestrator.runStory("DUG-1");

    expect(story.specs[0]!.status).toBe("failed");
    expect(story.status).toBe("failed");
    expect(story.specs[1]!.status).toBe("approved"); // never stacks downstream
  });
});
