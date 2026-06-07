import { describe, it, expect } from "vitest";
import { makeHarness, declared } from "./test-harness.js";
import type { ClarificationRound } from "./ports/executor.js";

describe("clarification loop (orchestrator)", () => {
  it("forwards prior clarification rounds into the executor's draft call", async () => {
    const { orchestrator, executor } = makeHarness({
      tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
      draft: { result: "drafted", specs: [{ repo: "web", markdown: "# Spec (web)" }] },
    });

    const rounds: ClarificationRound[] = [
      { answers: [{ questionId: "q1", question: "Soft or hard delete?", answer: "Soft." }] },
    ];

    await orchestrator.draftStory("DUG-1", {
      repos: ["web"].map(declared),
      clarifications: rounds,
    });

    expect(executor.draftCalls).toHaveLength(1);
    expect(executor.draftCalls[0]!.clarifications).toEqual(rounds);
  });

  it("converges across rounds: round 1 asks, round 2 (with answers) drafts", async () => {
    const { orchestrator, executor } = makeHarness({
      tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
      // The fake returns a sequence: first a question, then a drafted fan-out once answered.
      drafts: [
        {
          result: "needs-clarification",
          questions: [{ id: "q1", prompt: "Soft-delete or hard-delete?" }],
        },
        { result: "drafted", specs: [{ repo: "web", markdown: "# Spec (web)" }] },
      ],
    });

    const repos = ["web"].map(declared);

    // Round 1: the developer drafts cold; the agent asks rather than guess (invariant 1).
    const first = await orchestrator.draftStory("DUG-1", { repos });
    expect(first.outcome).toBe("needs-clarification");
    expect(orchestrator.getStory("DUG-1")).toBeUndefined();

    // Round 2: the developer answers and re-drafts with the accumulated rounds.
    const rounds: ClarificationRound[] = [
      { answers: [{ questionId: "q1", question: "Soft-delete or hard-delete?", answer: "Soft." }] },
    ];
    const second = await orchestrator.draftStory("DUG-1", { repos, clarifications: rounds });

    expect(second.outcome).toBe("drafted");
    if (second.outcome !== "drafted") throw new Error("expected convergence to a drafted story");
    expect(second.story.specs[0]!.repo).toBe("web");

    // The harness fed the answers back oldest-first on the converging call (and nothing on round 1).
    expect(executor.draftCalls).toHaveLength(2);
    expect(executor.draftCalls[0]!.clarifications).toBeUndefined();
    expect(executor.draftCalls[1]!.clarifications).toEqual(rounds);
  });

  it("kicks back needs-info mid-loop (re-draft judges the ticket too thin), persisting nothing", async () => {
    const { orchestrator } = makeHarness({
      tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
      drafts: [
        {
          result: "needs-clarification",
          questions: [{ id: "q1", prompt: "Soft-delete or hard-delete?" }],
        },
        // On re-draft the agent decides the ticket is too thin to spec at all — terminal to Jira.
        { result: "needs-info", reason: "Even with answers, no acceptance criteria to spec against." },
      ],
    });

    const repos = ["web"].map(declared);
    await orchestrator.draftStory("DUG-1", { repos });

    const rounds: ClarificationRound[] = [
      { answers: [{ questionId: "q1", question: "Soft-delete or hard-delete?", answer: "Soft." }] },
    ];
    const second = await orchestrator.draftStory("DUG-1", { repos, clarifications: rounds });

    expect(second).toEqual({
      outcome: "needs-info",
      reason: "Even with answers, no acceptance criteria to spec against.",
    });
    // A mid-loop needs-info is still terminal-to-Jira — nothing is persisted to rebuild.
    expect(orchestrator.getStory("DUG-1")).toBeUndefined();
  });
});
