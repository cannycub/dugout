import type { ReportParser } from "./report-parser.js";

/** A spec's test results, baseline (on the seed) vs after the build. Both are stable test ids. */
export interface DugoutTestReport {
  /** Test ids failing on the seed before the build (pre-existing reds — invariant 8). */
  baselineFailures: string[];
  /** Test ids failing after the build. */
  afterFailures: string[];
}

/**
 * Pure per-spec green gate (invariant 8): green iff no test fails that wasn't already failing in the
 * baseline. New failures → red, naming them. The harness grades — kiro never self-reports (ADR-0011).
 */
export function gradeExecute(
  report: DugoutTestReport,
): { result: "green" } | { result: "red"; reason: string } {
  const baseline = new Set(report.baselineFailures);
  const newFailures = report.afterFailures.filter((t) => !baseline.has(t));
  if (newFailures.length === 0) return { result: "green" };
  return {
    result: "red",
    reason: `${newFailures.length} new test failure(s) not in baseline: ${newFailures.join(", ")}`,
  };
}

/**
 * Grade the build from the two command-runner suite runs that bracket it (ADR-0015). The producer of
 * `DugoutTestReport` is now the host-side `ReportParser` — fed the baseline and after reporter stdout
 * — rather than kiro self-reporting a tag. The diff/green-red logic in {@link gradeExecute} is
 * unchanged. An unparseable reporter stdout means the *harness* could not run the suite, so the
 * parser throws and we let it propagate: that is an operational error to fix, not a spec `red`
 * (ADR-0015 clause 6).
 */
export function gradeExecuteRuns(
  parser: ReportParser,
  baselineStdout: string,
  afterStdout: string,
): { result: "green" } | { result: "red"; reason: string } {
  return gradeExecute({
    baselineFailures: parser.failingIds(baselineStdout),
    afterFailures: parser.failingIds(afterStdout),
  });
}
