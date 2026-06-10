import { describe, it, expect } from "vitest";
import { makeHarness, declared, draftAndApprove } from "./test-harness.js";

/**
 * Jira write-back (#11): a best-effort, non-blocking projection (invariant 4/7). Status moves via
 * a configurable event→transition map; each spec gets ONE idempotent subtask (key persisted in the
 * canonical contract, reused, never duplicated); failures degrade to warnings, never block.
 */
describe("Jira write-back", () => {
  it("moves the ticket via the configured pickup transition when drafting lands", async () => {
    const { orchestrator, jira } = makeHarness({
      draft: [{ repo: "web", markdown: "# A" }],
      jiraWriteBack: { transitions: { pickup: "In Progress" } },
    });

    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    expect(jira.transitions).toEqual([{ ticketKey: "DUG-1", transition: "In Progress" }]);
  });

  it("writes the needs-info kickback: configured transition + the agent's reason as a comment", async () => {
    const { orchestrator, jira } = makeHarness({
      draft: { result: "needs-info", reason: "no acceptance criteria" },
      jiraWriteBack: { transitions: { needsInfo: "Needs Info" } },
    });

    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });

    expect(jira.transitions).toEqual([{ ticketKey: "DUG-1", transition: "Needs Info" }]);
    expect(jira.comments).toEqual([
      { issueKey: "DUG-1", body: expect.stringContaining("no acceptance criteria") },
    ]);
  });

  it("creates one subtask per spec at approval, persisting the key into the canonical contract", async () => {
    const { orchestrator, jira, specStore } = makeHarness({
      draft: [
        { repo: "web", markdown: "# A" },
        { repo: "pipeline", markdown: "# B" },
      ],
      jiraWriteBack: {},
    });

    await draftAndApprove(orchestrator, ["web", "pipeline"]);

    expect(jira.subtasks.map((s) => s.parentKey)).toEqual(["DUG-1", "DUG-1"]);
    expect(specStore.get("DUG-1")?.specs.map((s) => s.jiraSubtaskKey)).toEqual([
      "DUG-1-sub-1",
      "DUG-1-sub-2",
    ]);
  });

  it("is idempotent: a spec that already has a subtask key never gets a duplicate", async () => {
    const { orchestrator, jira } = makeHarness({
      draft: [{ repo: "web", markdown: "# A" }],
      jiraWriteBack: {},
    });
    await orchestrator.draftStory("DUG-1", { repos: ["web"].map(declared) });
    await orchestrator.approveStory("DUG-1", {});
    // Simulate a second pass over an already-subtasked contract (restart-style re-entry).
    await orchestrator.syncJiraSubtasks("DUG-1");

    expect(jira.subtasks).toHaveLength(1);
  });

  it("closes the spec's subtask with a completion comment when the spec merges", async () => {
    const { orchestrator, jira } = makeHarness({
      draft: [{ repo: "web", markdown: "# A" }],
      jiraWriteBack: {},
    });
    await draftAndApprove(orchestrator, ["web"]);
    await orchestrator.runStory("DUG-1");

    expect(jira.closedSubtasks).toHaveLength(1);
    expect(jira.closedSubtasks[0]!.subtaskKey).toBe("DUG-1-sub-1");
    expect(jira.closedSubtasks[0]!.comment).toMatch(/merged/i);
  });

  it("moves the ticket via the configured dev-complete transition when every spec merges", async () => {
    const { orchestrator, jira } = makeHarness({
      draft: [{ repo: "web", markdown: "# A" }],
      jiraWriteBack: { transitions: { devComplete: "Ready for QA" } },
    });
    await draftAndApprove(orchestrator, ["web"]);
    await orchestrator.runStory("DUG-1");

    expect(jira.transitions).toContainEqual({ ticketKey: "DUG-1", transition: "Ready for QA" });
  });

  it("never blocks the build: every Jira write failing loudly still yields a dev-complete story", async () => {
    const { orchestrator, jira } = makeHarness({
      draft: [{ repo: "web", markdown: "# A" }],
      jiraWriteBack: { transitions: { pickup: "In Progress", devComplete: "Ready for QA" } },
    });
    jira.failWrites = true;

    await draftAndApprove(orchestrator, ["web"]);
    const story = await orchestrator.runStory("DUG-1");

    expect(story.status).toBe("dev-complete");
  });

  it("writes nothing when no write-back config is supplied (projection off)", async () => {
    const { orchestrator, jira } = makeHarness({ draft: [{ repo: "web", markdown: "# A" }] });

    await draftAndApprove(orchestrator, ["web"]);
    await orchestrator.runStory("DUG-1");

    expect(jira.transitions).toEqual([]);
    expect(jira.subtasks).toEqual([]);
  });
});
