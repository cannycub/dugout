import { describe, it, expect } from "vitest";
import { makeHarness, declared } from "./test-harness.js";

/**
 * The spec review & feedback loop (#5): PR-review-style iteration on a DRAFTED set — agent is the
 * author, the developer reviews. Conversational feedback (set / spec / section granularity) drives
 * a consistent re-draft; direct markdown edit is the escape hatch; the thread persists with the
 * contract.
 */
describe("reviseDraft — conversational feedback → consistent re-draft", () => {
  it("re-drafts with the current set + rendered feedback, replacing the canonical contract", async () => {
    const h = makeHarness({
      drafts: [
        { result: "drafted", specs: [{ repo: "web", markdown: "# Spec v1" }] },
        { result: "drafted", specs: [{ repo: "web", markdown: "# Spec v2 (revised)" }] },
      ],
    });
    await h.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    const result = await h.orchestrator.reviseDraft("DUG-1", {
      scope: { kind: "set" },
      content: "Split the second AC into its own spec.",
    });

    // The executor saw revision mode: the current canonical set + the feedback, set-scope first.
    const call = h.executor.draftCalls.at(-1)!;
    expect(call.revision?.specs).toEqual([{ repo: "web", markdown: "# Spec v1" }]);
    expect(call.revision?.feedback).toContain("Split the second AC");
    expect(call.revision?.feedback).toMatch(/whole spec set|fan-out/i);

    // The revised fan-out replaced the contract; the story stays drafted for further review.
    expect(result.outcome).toBe("drafted");
    const story = h.orchestrator.getStory("DUG-1")!;
    expect(story.specs.map((s) => s.markdown)).toEqual(["# Spec v2 (revised)"]);
    expect(story.status).toBe("drafted");
  });

  it("renders spec- and section-scope feedback into the revision request", async () => {
    const h = makeHarness({
      drafts: [
        { result: "drafted", specs: [{ repo: "web", markdown: "# A" }] },
        { result: "drafted", specs: [{ repo: "web", markdown: "# A2" }] },
        { result: "drafted", specs: [{ repo: "web", markdown: "# A3" }] },
      ],
    });
    await h.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    await h.orchestrator.reviseDraft("DUG-1", {
      scope: { kind: "spec", specId: "DUG-1-spec-1" },
      content: "Too broad.",
    });
    expect(h.executor.draftCalls.at(-1)!.revision?.feedback).toContain("DUG-1-spec-1");

    await h.orchestrator.reviseDraft("DUG-1", {
      scope: { kind: "section", specId: "DUG-1-spec-1", section: "test plan" },
      content: "Name the failing tests explicitly.",
    });
    const feedback = h.executor.draftCalls.at(-1)!.revision?.feedback;
    expect(feedback).toContain("test plan");
    expect(feedback).toContain("Name the failing tests");
  });

  it("persists the review thread with the contract, oldest-first with rounds", async () => {
    const h = makeHarness({
      drafts: [
        { result: "drafted", specs: [{ repo: "web", markdown: "# A" }] },
        { result: "drafted", specs: [{ repo: "web", markdown: "# A2" }] },
        { result: "drafted", specs: [{ repo: "web", markdown: "# A3" }] },
      ],
    });
    await h.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await h.orchestrator.reviseDraft("DUG-1", { scope: { kind: "set" }, content: "first" });
    await h.orchestrator.reviseDraft("DUG-1", {
      scope: { kind: "spec", specId: "DUG-1-spec-1" },
      content: "second",
    });

    const thread = h.specStore.get("DUG-1")!.reviewThread!;
    expect(thread).toEqual([
      { scope: { kind: "set" }, content: "first", round: 1, kind: "feedback" },
      { scope: { kind: "spec", specId: "DUG-1-spec-1" }, content: "second", round: 2, kind: "feedback" },
    ]);
    // Surfaced on the assembled story for the UI.
    expect(h.orchestrator.getStory("DUG-1")!.reviewThread).toHaveLength(2);
  });

  it("surfaces a needs-clarification stop from a revision without touching the contract", async () => {
    const h = makeHarness({
      drafts: [
        { result: "drafted", specs: [{ repo: "web", markdown: "# A" }] },
        { result: "needs-clarification", questions: [{ id: "q1", prompt: "Which AC?" }] },
      ],
    });
    await h.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    const result = await h.orchestrator.reviseDraft("DUG-1", { scope: { kind: "set" }, content: "split" });

    expect(result.outcome).toBe("needs-clarification");
    expect(h.orchestrator.getStory("DUG-1")!.specs[0]!.markdown).toBe("# A"); // untouched
  });

  it("rejects revision once the set is approved (the contract is ratified)", async () => {
    const h = makeHarness({ draft: [{ repo: "web", markdown: "# A" }] });
    await h.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await h.orchestrator.approveStory("DUG-1", {});
    await expect(
      h.orchestrator.reviseDraft("DUG-1", { scope: { kind: "set" }, content: "x" }),
    ).rejects.toThrow(/drafted/);
  });
});

describe("editSpecDraft — the direct-edit escape hatch", () => {
  it("persists the developer's markdown verbatim and records a direct-edit thread entry", async () => {
    const h = makeHarness({ draft: [{ repo: "web", markdown: "# A" }] });
    await h.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    const story = await h.orchestrator.editSpecDraft("DUG-1", "DUG-1-spec-1", "# A — dev edited");

    expect(story.specs[0]!.markdown).toBe("# A — dev edited");
    expect(h.specStore.get("DUG-1")!.specs[0]!.markdown).toBe("# A — dev edited");
    const entry = h.specStore.get("DUG-1")!.reviewThread!.at(-1)!;
    expect(entry.kind).toBe("direct-edit");
    expect(entry.scope).toEqual({ kind: "spec", specId: "DUG-1-spec-1" });
    // No agent call: the edit is the developer's word, applied verbatim (never overridden).
    expect(h.executor.draftCalls).toHaveLength(1);
  });

  it("a follow-up revision carries the dev's edit and the no-override directive to the agent", async () => {
    const h = makeHarness({
      drafts: [
        { result: "drafted", specs: [{ repo: "web", markdown: "# A" }] },
        { result: "drafted", specs: [{ repo: "web", markdown: "# A flagged" }] },
      ],
    });
    await h.orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await h.orchestrator.editSpecDraft("DUG-1", "DUG-1-spec-1", "# A — dev edited");

    await h.orchestrator.reviseDraft("DUG-1", { scope: { kind: "set" }, content: "check consistency" });

    const call = h.executor.draftCalls.at(-1)!;
    expect(call.revision?.specs[0]!.markdown).toBe("# A — dev edited"); // the edit is the input
    expect(call.revision?.feedback).toMatch(/directly edited/i); // the thread reaches the agent
  });
});
