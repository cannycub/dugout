export const TEST_REPORT_TAG = "dugout-test-report";
export const AMBIGUITY_TAG = "dugout-ambiguous";

/**
 * The execute-mode prompt: red→green TDD for one single-repo spec inside the sandbox, with the
 * harness-graded green gate (invariant 8) fed by a structured report. kiro runs --no-interactive and
 * never blocks for input; genuine mid-build ambiguity is an explicit escape hatch, never a guess
 * (invariant 1). ADR-0011.
 *
 * Baseline is folded into the report: kiro runs the full suite twice (before any change, then after
 * the build) and prints both lists in one <dugout-test-report> line on stdout. The adapter parses
 * that tag out of stdout and grades it host-side — Sandcastle hooks can't return output to the host,
 * so the folded report is the only clean baseline channel (see the Task 0 spike notes).
 */
export function executeMethodology(spec: { markdown: string }): string {
  return [
    "You are implementing ONE single-repo spec inside a sandboxed clone. Follow strict red→green TDD:",
    "write a failing test first, then the minimal code to pass it, refactor, repeat.",
    "",
    "PROCEDURE:",
    "1. Before changing anything, run the repo's FULL test suite and record every failing test id",
    "   (these are pre-existing failures — the baseline).",
    "2. Implement the spec test-first.",
    "3. Run the FULL test suite again and record every failing test id (after).",
    `4. Emit EXACTLY ONE report block, on its own lines:`,
    `   <${TEST_REPORT_TAG}>{"baselineFailures":[...],"afterFailures":[...]}</${TEST_REPORT_TAG}>`,
    "   using stable test ids (file + test name). Then emit <promise>COMPLETE</promise>.",
    "",
    "NEVER GUESS. If you hit a decision you cannot resolve from the spec and code without guessing,",
    `do NOT proceed and do NOT ask a question. Emit <${AMBIGUITY_TAG}>one-line reason</${AMBIGUITY_TAG}>`,
    "and stop. A clean restart after the developer clarifies is correct; a guess is not (invariant 1).",
    "",
    "THE SPEC:",
    spec.markdown,
  ].join("\n");
}
