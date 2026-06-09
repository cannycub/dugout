import { describe, it, expect } from "vitest";
import { reportParserFor } from "./report-parser.js";

/** A vitest `--reporter=json` document with one passing and one failing assertion. */
const vitestJson = JSON.stringify({
  numTotalTestSuites: 1,
  numFailedTests: 1,
  testResults: [
    {
      name: "/repo/src/core/grade-execute.test.ts",
      status: "failed",
      assertionResults: [
        { ancestorTitles: ["gradeExecute"], fullName: "gradeExecute returns green", title: "returns green", status: "passed" },
        { ancestorTitles: ["gradeExecute"], fullName: "gradeExecute flags a new failure", title: "flags a new failure", status: "failed" },
      ],
    },
  ],
});

describe("vitest-json ReportParser", () => {
  it("returns the failing test ids as file + full test name", () => {
    const ids = reportParserFor("vitest-json").failingIds(vitestJson);
    expect(ids).toEqual(["/repo/src/core/grade-execute.test.ts > gradeExecute flags a new failure"]);
  });

  it("returns [] when the suite is all green (parseable, zero failures)", () => {
    const allPass = JSON.stringify({
      testResults: [
        { name: "a.test.ts", status: "passed", assertionResults: [{ fullName: "a works", status: "passed" }] },
      ],
    });
    expect(reportParserFor("vitest-json").failingIds(allPass)).toEqual([]);
  });

  it("tolerates surrounding stdout noise (command echo before/after the JSON)", () => {
    const noisy = `> vitest run --reporter=json\n${vitestJson}\nexit 0\n`;
    const ids = reportParserFor("vitest-json").failingIds(noisy);
    expect(ids).toEqual(["/repo/src/core/grade-execute.test.ts > gradeExecute flags a new failure"]);
  });

  it("throws when stdout carries no parseable report (operational, not a green [])", () => {
    expect(() => reportParserFor("vitest-json").failingIds("command not found\n")).toThrow(/report/i);
  });

  it("throws when vitest reports failure but names no failing test (compile/collection error, not a silent green)", () => {
    // A test file that fails to import/compile: vitest exits non-zero (masked by the command-runner's
    // forced exit 0) yet prints a PARSEABLE doc with success:false and an empty failing set. Returning
    // [] here would grade green though the suite never ran — the exact false-green invariant 8 forbids.
    const collectionError = JSON.stringify({ success: false, numFailedTests: 0, testResults: [] });
    expect(() => reportParserFor("vitest-json").failingIds(collectionError)).toThrow(/did not|complete|fail/i);
  });

  it("still returns named failures when success is false WITH failing assertions (a normal red)", () => {
    const realRed = JSON.stringify({
      success: false,
      testResults: [{ name: "a.test.ts", status: "failed", assertionResults: [{ fullName: "a breaks", status: "failed" }] }],
    });
    expect(reportParserFor("vitest-json").failingIds(realRed)).toEqual(["a.test.ts > a breaks"]);
  });

  it("returns [] for an all-green run reporting success:true", () => {
    const ok = JSON.stringify({
      success: true,
      testResults: [{ name: "a.test.ts", status: "passed", assertionResults: [{ fullName: "a ok", status: "passed" }] }],
    });
    expect(reportParserFor("vitest-json").failingIds(ok)).toEqual([]);
  });
});

/** A TRX with one failed + one passed result, joined to TestDefinitions by `testId`. The per-run
 *  `testId` GUIDs are deliberately distinct from the stable method names. */
const trx = (failGuid: string, passGuid: string) => `<?xml version="1.0" encoding="UTF-8"?>
<TestRun id="run-1" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testId="${failGuid}" testName="Add_ReturnsSum" outcome="Failed" duration="00:00:00.01" />
    <UnitTestResult testId="${passGuid}" testName="Sub_ReturnsDiff" outcome="Passed" duration="00:00:00.01" />
  </Results>
  <TestDefinitions>
    <UnitTest name="Add_ReturnsSum" id="${failGuid}">
      <TestMethod className="MyApp.Tests.CalculatorTests, MyApp.Tests" name="Add_ReturnsSum" />
    </UnitTest>
    <UnitTest name="Sub_ReturnsDiff" id="${passGuid}">
      <TestMethod className="MyApp.Tests.CalculatorTests, MyApp.Tests" name="Sub_ReturnsDiff" />
    </UnitTest>
  </TestDefinitions>
</TestRun>`;

describe("trx ReportParser", () => {
  it("returns failing tests as the fully-qualified method name (class + method), not the testId GUID", () => {
    const ids = reportParserFor("trx").failingIds(trx("aaaa-1111", "bbbb-2222"));
    expect(ids).toEqual(["MyApp.Tests.CalculatorTests.Add_ReturnsSum"]);
  });

  it("yields the same stable id across runs even though the per-run testId GUID changes", () => {
    const run1 = reportParserFor("trx").failingIds(trx("guid-A", "guid-B"));
    const run2 = reportParserFor("trx").failingIds(trx("guid-C", "guid-D"));
    expect(run1).toEqual(run2);
  });

  it("returns [] when every result passed", () => {
    const allPass = trx("x", "y").replace('outcome="Failed"', 'outcome="Passed"');
    expect(reportParserFor("trx").failingIds(allPass)).toEqual([]);
  });

  it("counts Error/Timeout/Aborted outcomes as failing, not only Failed (a test that throws/hangs)", () => {
    for (const outcome of ["Error", "Timeout", "Aborted"]) {
      const errored = trx("g1", "g2").replace('outcome="Failed"', `outcome="${outcome}"`);
      expect(reportParserFor("trx").failingIds(errored)).toEqual(["MyApp.Tests.CalculatorTests.Add_ReturnsSum"]);
    }
  });

  it("does not count NotExecuted (skipped) tests as failing", () => {
    const skipped = trx("g1", "g2").replace('outcome="Failed"', 'outcome="NotExecuted"');
    expect(reportParserFor("trx").failingIds(skipped)).toEqual([]);
  });

  it("throws when stdout carries no TRX (operational, not a green [])", () => {
    expect(() => reportParserFor("trx").failingIds("MSBuild error\n")).toThrow(/report|trx/i);
  });
});

describe("reportParserFor", () => {
  it("throws on an unknown report format", () => {
    expect(() => reportParserFor("junit" as never)).toThrow(/format/i);
  });
});
