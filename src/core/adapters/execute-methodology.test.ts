import { describe, it, expect } from "vitest";
import { executeMethodology, AMBIGUITY_TAG } from "./execute-methodology.js";

describe("executeMethodology", () => {
  const prompt = executeMethodology({ markdown: "# Add /health endpoint\nAC: returns 200." });

  it("embeds the spec markdown", () => {
    expect(prompt).toContain("# Add /health endpoint");
  });
  it("instructs red→green TDD", () => {
    expect(prompt).toMatch(/test-first|red.?→?.?green|failing test first/i);
  });
  it("instructs the ambiguity escape hatch (never guess, never ask)", () => {
    expect(prompt).toContain(AMBIGUITY_TAG);
    expect(prompt).toMatch(/never guess|do not guess/i);
  });
  it("asks for a single COMPLETE signal on success", () => {
    expect(prompt).toMatch(/<promise>COMPLETE<\/promise>/);
  });
  it("is build-only: it does NOT ask kiro to run the suite or self-report a test report (the harness grades)", () => {
    // ADR-0015: the harness observes the suite (command-runner runs bracket the build); kiro never
    // authors the grade inputs. No baseline/after self-report, no <dugout-test-report> tag.
    expect(prompt).not.toMatch(/dugout-test-report/);
    expect(prompt).not.toMatch(/baselineFailures|afterFailures/);
  });
});

describe("executeMethodology — non-functional directives (#12)", () => {
  const prompt = executeMethodology({ markdown: "# Spec" });

  it("carries explicit performance + concurrency directives", () => {
    expect(prompt).toMatch(/hot path/i);
    expect(prompt).toMatch(/allocat/i);
    expect(prompt).toMatch(/lock|thread-safe|shared mutable state/i);
  });
  it("requires the agent to surface its non-functional assumptions for the reviewer", () => {
    expect(prompt).toMatch(/non-functional assumptions/i);
    expect(prompt).toMatch(/commit message/i);
  });
  it("forbids weakening the repo's existing checks", () => {
    expect(prompt).toMatch(/never (weaken|disable|remove)/i);
  });
});

describe("executeMethodology — ID-stamped commits (#10)", () => {
  it("directs the agent to prefix every commit subject with the spec id", () => {
    const prompt = executeMethodology({ markdown: "# Spec", specId: "DUG-1-spec-2" });
    expect(prompt).toContain('"[DUG-1-spec-2]"');
    expect(prompt).toMatch(/every commit subject/i);
  });
});
