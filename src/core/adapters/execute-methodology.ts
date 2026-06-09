export const AMBIGUITY_TAG = "dugout-ambiguous";
/** kiro's build-complete signal: `<promise>COMPLETE</promise>`. The adapter uses its position to
 *  disambiguate a genuine ambiguity (last control tag wins) from an echoed template (ADR-0015). */
export const COMPLETION_TAG = "promise";

/**
 * The execute-mode prompt: red→green TDD for one single-repo spec inside the sandbox. kiro **builds
 * only** — it no longer runs the suite for grading or self-reports a test report. The harness
 * observes the suite itself, running it as a command before and after this build and diffing the
 * failing sets host-side (invariant 8; ADR-0015). kiro runs --no-interactive and never blocks for
 * input; genuine mid-build ambiguity is an explicit escape hatch, never a guess (invariant 1).
 */
export function executeMethodology(spec: { markdown: string }): string {
  return [
    "You are implementing ONE single-repo spec inside a sandboxed clone. Follow strict red→green TDD:",
    "write a failing test first, then the minimal code to pass it, refactor, repeat.",
    "",
    "When the spec is fully implemented and its tests pass, emit <promise>COMPLETE</promise> and stop.",
    "You do NOT need to report test results — the harness runs the suite and grades it for you.",
    "",
    "NEVER GUESS. If you hit a decision you cannot resolve from the spec and code without guessing,",
    `do NOT proceed and do NOT ask a question. Emit <${AMBIGUITY_TAG}>one-line reason</${AMBIGUITY_TAG}>`,
    "and stop. A clean restart after the developer clarifies is correct; a guess is not (invariant 1).",
    "",
    "THE SPEC:",
    spec.markdown,
  ].join("\n");
}
