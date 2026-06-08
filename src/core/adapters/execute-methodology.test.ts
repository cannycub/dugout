import { describe, it, expect } from "vitest";
import { executeMethodology, TEST_REPORT_TAG, AMBIGUITY_TAG } from "./execute-methodology.js";

describe("executeMethodology", () => {
  const prompt = executeMethodology({ markdown: "# Add /health endpoint\nAC: returns 200." });

  it("embeds the spec markdown", () => {
    expect(prompt).toContain("# Add /health endpoint");
  });
  it("instructs red→green TDD", () => {
    expect(prompt).toMatch(/test-first|red.?→?.?green|failing test first/i);
  });
  it("requires the full suite be run for baseline and after, reported in the tag", () => {
    expect(prompt).toContain(TEST_REPORT_TAG);
    expect(prompt).toMatch(/baselineFailures/);
    expect(prompt).toMatch(/afterFailures/);
  });
  it("instructs the ambiguity escape hatch (never guess, never ask)", () => {
    expect(prompt).toContain(AMBIGUITY_TAG);
    expect(prompt).toMatch(/never guess|do not guess/i);
  });
});
