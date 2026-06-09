import { describe, it, expect } from "vitest";
import { gradeExecute, gradeExecuteRuns, type DugoutTestReport } from "./grade-execute.js";
import { reportParserFor } from "./report-parser.js";

/** A minimal vitest `--reporter=json` stdout naming the given failing full-test-names in one file. */
const vitestStdout = (...failing: string[]) =>
  JSON.stringify({
    testResults: [
      {
        name: "suite.test.ts",
        status: failing.length ? "failed" : "passed",
        assertionResults: [
          { fullName: "t passes", status: "passed" },
          ...failing.map((f) => ({ fullName: f, status: "failed" })),
        ],
      },
    ],
  });

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

describe("gradeExecuteRuns (parser-produced report)", () => {
  const parser = reportParserFor("vitest-json");

  it("green when the after-run's failures match the baseline's", () => {
    const out = gradeExecuteRuns(parser, vitestStdout("pre-existing"), vitestStdout("pre-existing"));
    expect(out).toEqual({ result: "green" });
  });

  it("red naming the new failure the build introduced", () => {
    const out = gradeExecuteRuns(parser, vitestStdout(), vitestStdout("regression"));
    expect(out.result).toBe("red");
    expect(out.result === "red" && out.reason).toMatch(/regression/);
  });

  it("propagates the parser's throw when a reporter stdout is unparseable (operational, not red)", () => {
    expect(() => gradeExecuteRuns(parser, "kiro crashed, no report", vitestStdout())).toThrow(/report/i);
  });
});
