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
