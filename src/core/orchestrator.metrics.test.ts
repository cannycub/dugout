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

describe("metrics — funnel + agent-correction instrumentation (#13)", () => {
  it("emits the adoption funnel: drafted → approved → merged → dev_complete → pr_created", async () => {
    const { orchestrator, metrics } = makeHarness({ draft: [{ repo: "web", markdown: "# A" }] });
    await draftAndApprove(orchestrator, ["web"]);
    await orchestrator.runStory("DUG-1");
    await orchestrator.createPullRequests("DUG-1");

    const names = metrics.events.map((e) => e.name);
    expect(names).toEqual([
      "story.drafted",
      "story.approved",
      "spec.merged",
      "story.dev_complete",
      "story.pr_created",
    ]);
  });

  it("emits a clarification round per needs-clarification (ticket-quality signal) and convergence", async () => {
    const { orchestrator, metrics } = makeHarness({
      drafts: [
        { result: "needs-clarification", questions: [{ id: "q1", prompt: "Soft or hard delete?" }] },
        { result: "drafted", specs: [{ repo: "web", markdown: "# A" }] },
      ],
    });
    const declared = (await import("./test-harness.js")).declared;

    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await orchestrator.draftStory("DUG-1", {
      repos: ["web"].map(declared),
      clarifications: [{ answers: [{ questionId: "q1", question: "?", answer: "soft" }] }],
    });

    expect(metrics.events).toEqual([
      { name: "draft.clarification_round", tags: { story: "DUG-1", round: 1 } },
      { name: "draft.clarification_converged", tags: { story: "DUG-1", rounds: 1 } },
      { name: "story.drafted", tags: { story: "DUG-1", specs: 1 } },
    ]);
  });

  it("emits the needs-info kickback (ticket-quality signal)", async () => {
    const { orchestrator, metrics } = makeHarness({
      draft: { result: "needs-info", reason: "no AC at all" },
    });
    const declared = (await import("./test-harness.js")).declared;
    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    expect(metrics.events).toEqual([{ name: "draft.needs_info", tags: { story: "DUG-1" } }]);
  });

  it("emits agent-correction signals: spec failure (with the grade) and the clean restart", async () => {
    const { orchestrator, metrics } = makeHarness({
      draft: [{ repo: "web", markdown: "# A" }],
      execute: { "DUG-1-spec-1": { result: "ambiguous", reason: "which auth?" } },
    });
    await draftAndApprove(orchestrator, ["web"]);
    await orchestrator.runStory("DUG-1");
    await orchestrator.restartStory("DUG-1");

    const names = metrics.events.map((e) => e.name);
    expect(names).toContain("spec.failed");
    expect(names).toContain("story.restarted");
    const failed = metrics.events.find((e) => e.name === "spec.failed");
    expect(failed?.tags).toEqual({ story: "DUG-1", repo: "web", result: "ambiguous" });
  });

  it("emits the resume after a review stop (code-level correction surface)", async () => {
    const { orchestrator, metrics } = makeHarness({ draft: [{ repo: "web", markdown: "# A" }] });
    await orchestrator.draftStory("DUG-1", { repos: ["web"].map((await import("./test-harness.js")).declared) });
    await orchestrator.approveStory("DUG-1", { reviewRequired: ["DUG-1-spec-1"] });
    await orchestrator.runStory("DUG-1");
    await orchestrator.resumeAfterReview("DUG-1");

    expect(metrics.events.map((e) => e.name)).toContain("story.resumed_after_review");
  });
});
