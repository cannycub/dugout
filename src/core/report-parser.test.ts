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

  it("throws when stdout carries no TRX (operational, not a green [])", () => {
    expect(() => reportParserFor("trx").failingIds("MSBuild error\n")).toThrow(/report|trx/i);
  });
});

describe("reportParserFor", () => {
  it("throws on an unknown report format", () => {
    expect(() => reportParserFor("junit" as never)).toThrow(/format/i);
  });
});
