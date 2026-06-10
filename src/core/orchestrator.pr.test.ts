import { describe, it, expect } from "vitest";
import { makeHarness, draftAndApprove } from "./test-harness.js";

describe("PR creation", () => {
  it("pushes once per repo and opens one fully-linked PR per repo, never auto-merged", async () => {
    const { orchestrator, github } = makeHarness({
      draft: [
        { repo: "web", markdown: "# Spec A" },
        { repo: "api", markdown: "# Spec B" },
      ],
    });
    await draftAndApprove(orchestrator, ["web", "api"]);
    await orchestrator.runStory("DUG-1");

    const prs = await orchestrator.createPullRequests("DUG-1");

    // One PR per repo, never auto-merged (invariant 5).
    expect(prs.map((p) => p.repo).sort()).toEqual(["api", "web"]);
    expect(prs.every((p) => p.autoMerge === false)).toBe(true);

    // A single push per repo's story branch — the head is the accumulated `story/<key>` branch the
    // merges land on, NOT the legacy `dugout/<key>/<repo>` name (ADR-0013/0014 reconciliation).
    expect(github.pushes.map((p) => p.repo).sort()).toEqual(["api", "web"]);
    expect(github.pushes.map((p) => p.branch)).toEqual(["story/DUG-1", "story/DUG-1"]);
    expect(github.pullRequests.every((pr) => pr.head === "story/DUG-1")).toBe(true);

    // Fully-linked: every PR title carries the story id for traceability.
    expect(github.pullRequests.every((pr) => pr.title.includes("DUG-1"))).toBe(true);

    expect(orchestrator.getStory("DUG-1")!.status).toBe("pr-created");
  });
});

describe("PR body — maximum context for peer reviewers (#10)", () => {
  it("carries the specs (full markdown incl. AC), their flags and grades, and the test-result basis", async () => {
    const { orchestrator, github } = makeHarness({
      draft: [
        { repo: "web", markdown: "# Spec: add endpoint\n\n## AC\n- [ ] returns 200" },
        { repo: "web", markdown: "# Spec: stream events" },
      ],
    });
    await orchestrator.draftStory("DUG-1", { repos: ["web"].map((await import("./test-harness.js")).declared) });
    await orchestrator.approveStory("DUG-1", { replaySpecs: ["DUG-1-spec-2"] });
    await orchestrator.runStory("DUG-1");
    await orchestrator.resumeAfterReview("DUG-1");
    await orchestrator.createPullRequests("DUG-1");

    const body = github.pullRequests[0]!.body;
    // Story header + per-spec sections with the canonical markdown (the AC mapping lives in it).
    expect(body).toContain("DUG-1");
    expect(body).toContain("# Spec: add endpoint");
    expect(body).toContain("- [ ] returns 200");
    expect(body).toContain("# Spec: stream events");
    // Flags + resting status are visible per spec.
    expect(body).toMatch(/DUG-1-spec-2.*replay spec/);
    expect(body).toMatch(/merged/);
    // What "green" meant: full suite over baseline, observed by the harness, not self-reported.
    expect(body).toMatch(/full local suite|harness-observed/i);
  });
});
