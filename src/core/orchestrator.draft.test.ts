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
    const story = await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    expect(story.status).toBe("drafted");
    expect(story.specs).toHaveLength(1);

    const spec = story.specs[0]!;
    expect(spec.repo).toBe("web");
    expect(spec.status).toBe("drafted");
    expect(spec.markdown).toContain("Add widget endpoint");
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
