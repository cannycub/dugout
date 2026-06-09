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
    "NON-FUNCTIONAL DIRECTIVES — this is a performance-sensitive system; tests prove behaviour, not",
    "efficiency or thread-safety, so these are on you:",
    "- Performance: do not add work to a hot path (per-item processing, request handling, tight",
    "  loops). Avoid avoidable allocation in loops; prefer streaming over buffering whole datasets;",
    "  do not introduce synchronous I/O on a latency-sensitive path.",
    "- Concurrency: treat shared mutable state as suspect. Honour the locking discipline the",
    "  surrounding code already uses; never hold a lock across I/O or a callback; keep anything",
    "  reachable from concurrent code thread-safe.",
    "- Never weaken existing checks: do not disable, skip, or loosen the repo's linters, analyzers,",
    "  race detectors, or test strictness to get to green.",
    "- Surface your NON-FUNCTIONAL ASSUMPTIONS for the human reviewer: state any assumption you made",
    "  about load, ordering, concurrency, or acceptable latency in the relevant commit message body",
    "  (a short 'Non-functional assumptions:' paragraph). If you made none, say nothing.",
    "",
    "THE SPEC:",
    spec.markdown,
  ].join("\n");
}
