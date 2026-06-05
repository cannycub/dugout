import { describe, it, expect } from "vitest";
import { makeHarness, declared } from "./test-harness.js";

describe("draft mode", () => {
  it("drafts single-repo specs as markdown from a selected ticket", async () => {
    const { orchestrator } = makeHarness({
      tickets: [{ key: "DUG-1", title: "Add widget endpoint", description: "AC: returns 200" }],
      draft: [{ repo: "web", markdown: "# Spec: Add widget endpoint (web)\n\nTest-first." }],
    });

    // The developer sees their assigned tickets and picks one.
    const tickets = await orchestrator.listAssignedTickets();
    expect(tickets.map((t) => t.key)).toEqual(["DUG-1"]);

    // Declaring the repos in scope, the agent drafts the fan-out (read-only, no sandbox).
    const result = await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    expect(result.outcome).toBe("drafted");
    if (result.outcome !== "drafted") throw new Error("expected a drafted outcome");
    const story = result.story;
    expect(story.status).toBe("drafted");
    expect(story.specs).toHaveLength(1);

    const spec = story.specs[0]!;
    expect(spec.repo).toBe("web");
    expect(spec.status).toBe("drafted");
    expect(spec.markdown).toContain("Add widget endpoint");
  });

  it("persists the declared repos as story scope, including a declared repo with no spec", async () => {
    const { orchestrator } = makeHarness({
      tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
      // The fan-out only assigns a spec to web; infra is declared but gets none (still in scope).
      draft: [{ repo: "web", markdown: "# Spec (web)" }],
    });

    await orchestrator.draftStory("DUG-1", { repos: ["web", "infra"].map(declared) });

    const story = orchestrator.getStory("DUG-1")!;
    expect(story.declaredRepos).toEqual(["web", "infra"]);
  });

  it("kicks back needs-info (with the reason) and persists nothing when the ticket is too thin", async () => {
    const { orchestrator } = makeHarness({
      tickets: [{ key: "DUG-1", title: "Fix the thing", description: "make it better" }],
      // The agent stops rather than guess (invariant 1): the ticket is too thin to spec at all.
      draft: { result: "needs-info", reason: "No acceptance criteria; target behaviour unclear." },
    });

    const result = await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    expect(result).toEqual({
      outcome: "needs-info",
      reason: "No acceptance criteria; target behaviour unclear.",
    });
    // A terminal kickback drafts nothing — no story is persisted to rebuild.
    expect(orchestrator.getStory("DUG-1")).toBeUndefined();
  });

  it("surfaces needs-clarification questions (with no story) so the developer can answer and re-draft", async () => {
    const { orchestrator } = makeHarness({
      tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
      // The agent can spec, but is blocked on a specific, answerable question.
      draft: {
        result: "needs-clarification",
        questions: [{ id: "q1", prompt: "Soft-delete or hard-delete?" }],
      },
    });

    const result = await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    expect(result).toEqual({
      outcome: "needs-clarification",
      questions: [{ id: "q1", prompt: "Soft-delete or hard-delete?" }],
    });
    expect(orchestrator.getStory("DUG-1")).toBeUndefined();
  });

  it("rejects a fan-out that drafts a spec for an undeclared repo (ADR-0006)", async () => {
    const { orchestrator } = makeHarness({
      tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
      // The executor fans out onto a repo the developer never put in scope.
      draft: [
        { repo: "web", markdown: "# Spec (web)" },
        { repo: "pipeline", markdown: "# Spec (pipeline)" },
      ],
    });

    await expect(
      orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) }),
    ).rejects.toThrow(/pipeline/);
  });
});
