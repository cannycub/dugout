import { describe, it, expect } from "vitest";
import { gradeExecute, type DugoutTestReport } from "./grade-execute.js";

describe("gradeExecute", () => {
  it("green when no test fails that wasn't already failing in the baseline", () => {
    const report: DugoutTestReport = { baselineFailures: ["a", "b"], afterFailures: ["a", "b"] };
    expect(gradeExecute(report)).toEqual({ result: "green" });
  });

  it("green when the build fixed a pre-existing red and added none", () => {
    const report: DugoutTestReport = { baselineFailures: ["a"], afterFailures: [] };
    expect(gradeExecute(report)).toEqual({ result: "green" });
  });

  it("red when a new failure appears that wasn't in the baseline", () => {
    const report: DugoutTestReport = { baselineFailures: ["a"], afterFailures: ["a", "c"] };
    const r = gradeExecute(report);
    expect(r.result).toBe("red");
    expect(r.result === "red" && r.reason).toMatch(/c/);
  });
});
