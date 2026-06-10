import { describe, it, expect } from "vitest";
import { makeHarness, declared } from "./test-harness.js";

/**
 * Code feedback at a review-required stop (#9): behavioural feedback as a failing test, NL
 * quality feedback iterated in place — both run as refinement passes on top of the story branch
 * with the suite-green gate, and the stop remains until the developer resumes. "Spec was wrong"
 * amends the contract and re-runs clean, cascading downstream specs from the corrected HEAD.
 */

/** drafted fan-out: spec-1 review-required (the stop), spec-2 plain. */
async function storyAtReviewStop(harnessOpts: Parameters<typeof makeHarness>[0] = { draft: [] }) {
  const h = makeHarness({
    ...harnessOpts,
    draft: [
      { repo: "web", markdown: "# Spec one" },
      { repo: "web", markdown: "# Spec two" },
    ],
  });
  await h.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
  await h.orchestrator.approveStory("DUG-1", { reviewRequired: ["DUG-1-spec-1"] });
  await h.orchestrator.runStory("DUG-1");
  expect(h.orchestrator.getStory("DUG-1")!.status).toBe("awaiting-review");
  return h;
}

describe("submitReviewFeedback — in-place iteration at the stop", () => {
  it("runs a quality refinement seeded from the story branch, merges it, and KEEPS the stop", async () => {
    const h = await storyAtReviewStop();

    const story = await h.orchestrator.submitReviewFeedback("DUG-1", {
      kind: "quality",
      content: "Extract the parser into its own module; behaviour unchanged.",
    });

    // The refinement executed as its own run against the spec's repo, on a feedback id.
    const refinement = h.executor.executeCalls.at(-1)!;
    expect(refinement.specId).toBe("DUG-1-spec-1-fb1");
    expect(refinement.repo).toBe("web");
    expect(refinement.storyKey).toBe("DUG-1");
    expect(refinement.markdown).toContain("Extract the parser");
    expect(refinement.markdown).toMatch(/suite must stay green/i);

    // Green ⇒ merged back onto the story branch; the SAME review stop continues (no auto-resume).
    expect(h.mergeCalls.at(-1)).toEqual({ repo: "web", storyKey: "DUG-1", specId: "DUG-1-spec-1-fb1" });
    expect(story.status).toBe("awaiting-review");
    expect(story.specs.map((s) => s.status)).toEqual(["merged", "approved"]);
  });

  it("frames behavioural feedback as a must-pass failing test the agent makes green", async () => {
    const h = await storyAtReviewStop();

    await h.orchestrator.submitReviewFeedback("DUG-1", {
      kind: "test",
      content: "it('rejects an empty payload', () => …)",
    });

    const refinement = h.executor.executeCalls.at(-1)!;
    expect(refinement.markdown).toMatch(/failing test/i);
    expect(refinement.markdown).toContain("rejects an empty payload");
  });

  it("numbers successive feedback rounds (fb1, fb2, …) within the stop", async () => {
    const h = await storyAtReviewStop();
    await h.orchestrator.submitReviewFeedback("DUG-1", { kind: "quality", content: "round one" });
    await h.orchestrator.submitReviewFeedback("DUG-1", { kind: "quality", content: "round two" });
    expect(h.executor.executeCalls.at(-1)!.specId).toBe("DUG-1-spec-1-fb2");
  });

  it("a failed refinement throws with the reason and leaves the merged story untouched at the stop", async () => {
    const h = await storyAtReviewStop({
      draft: [],
      execute: { "DUG-1-spec-1-fb1": { result: "red", reason: "new test still failing" } },
    });

    await expect(
      h.orchestrator.submitReviewFeedback("DUG-1", { kind: "test", content: "…" }),
    ).rejects.toThrow(/new test still failing/);

    const story = h.orchestrator.getStory("DUG-1")!;
    expect(story.status).toBe("awaiting-review"); // the stop survives; merged code is untouched
    expect(story.specs.map((s) => s.status)).toEqual(["merged", "approved"]);
    expect(h.mergeCalls.filter((m) => m.specId.includes("fb"))).toHaveLength(0);
  });

  it("rejects feedback outside a review stop", async () => {
    const h = makeHarness({ draft: [{ repo: "web", markdown: "# A" }] });
    await h.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await expect(
      h.orchestrator.submitReviewFeedback("DUG-1", { kind: "quality", content: "x" }),
    ).rejects.toThrow(/awaiting-review/);
  });
});

describe("amendSpec — spec-was-wrong + cascade", () => {
  it("amends the contract, flags the downstream cascade, and re-runs from the corrected spec", async () => {
    const h = await storyAtReviewStop();

    const { story, cascade } = await h.orchestrator.amendSpec("DUG-1", "DUG-1-spec-1", "# Spec one — corrected");

    // The cascade was flagged: spec-2 had not run yet, so only the amended spec re-ran… and the
    // contract now carries the corrected markdown canonically.
    expect(cascade).toEqual([]);
    expect(h.specStore.get("DUG-1")!.specs[0]!.markdown).toBe("# Spec one — corrected");

    // The re-run executed with the corrected markdown, seeded from the story branch as it stands
    // (no magic-rewind), and the story came back to the same review-required stop.
    const rerun = h.executor.executeCalls.at(-1)!;
    expect(rerun.specId).toBe("DUG-1-spec-1");
    expect(rerun.markdown).toBe("# Spec one — corrected");
    expect(story.status).toBe("awaiting-review");
  });

  it("amending an earlier spec after later specs merged cascades them: flagged and re-run in order", async () => {
    const h = await storyAtReviewStop();
    await h.orchestrator.resumeAfterReview("DUG-1"); // spec-2 merges → dev-complete
    expect(h.orchestrator.getStory("DUG-1")!.status).toBe("dev-complete");

    const { story, cascade } = await h.orchestrator.amendSpec("DUG-1", "DUG-1-spec-1", "# Spec one v2");

    expect(cascade).toEqual(["DUG-1-spec-2"]); // the downstream spec that was invalidated
    // The corrected spec re-runs first and — being review-required — pauses at its stop again;
    // the cascaded downstream spec re-runs through resume (explicit, never silent).
    expect(h.executor.executeCalls.at(-1)!.specId).toBe("DUG-1-spec-1");
    expect(story.status).toBe("awaiting-review");
    expect(story.specs.map((s) => s.status)).toEqual(["merged", "approved"]); // spec-2 reset, queued

    const resumed = await h.orchestrator.resumeAfterReview("DUG-1");
    expect(h.executor.executeCalls.at(-1)!.specId).toBe("DUG-1-spec-2");
    expect(resumed.status).toBe("dev-complete");
  });

  it("rejects amending a spec that never ran (the contract is editable pre-approval instead)", async () => {
    const h = makeHarness({ draft: [{ repo: "web", markdown: "# A" }] });
    await h.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await expect(h.orchestrator.amendSpec("DUG-1", "DUG-1-spec-1", "# B")).rejects.toThrow(
      /awaiting-review|dev-complete/,
    );
  });
});
