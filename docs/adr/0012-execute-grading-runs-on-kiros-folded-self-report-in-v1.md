# Execute grading runs on kiro's folded self-report in v1 (amends ADR-0011 §3)

ADR-0011 §3 decided: *"Dugout owns grading; kiro never self-reports green. After kiro's completion
signal, **the harness runs the full suite in the sandbox** and compares the failing set to a baseline
captured on the seed."* The #7 implementation spike (Task 0,
`docs/superpowers/notes/2026-06-08-sandcastle-spike.md`, divergence 2) found that **Sand Castle 0.7
offers no channel for that as designed**: its lifecycle hooks (`host.onWorktreeReady`,
`sandbox.onSandboxReady`, …) are fire-and-forget command arrays with **no way to read a command's
output back on the host**. So the host cannot, via the assumed path, run the suite in the box and
observe the result. This ADR records what v1 ships instead, and why it is a real — but bounded and
temporary — weakening of invariant 8.

## Decision

**In v1, kiro produces the grade inputs; the harness only diffs them.** The execute-mode prompt
(`execute-methodology.ts`) instructs kiro to run the **full** suite twice inside the box — once
before any change (`baselineFailures`) and once after the build (`afterFailures`) — and emit both
failing-id lists in one `<dugout-test-report>{…}</dugout-test-report>` on stdout. The adapter parses
that tag and `grade-execute.ts` grades green iff `afterFailures ⊆ baselineFailures`. The grading
function stays pure and is still the highest-value unit target — but its **inputs are
agent-authored, not harness-observed.**

This **amends ADR-0011 §3**: "the harness runs the full suite in the sandbox" is **deferred**;
"kiro never self-reports green" is, in v1, **not true** — kiro reports both the baseline and the
after sets, and the harness trusts them. ADR-0011 §1, §2, §4, §5 (wrap Sand Castle, custom kiro
provider, the three-arm outcome, the injected-`run` seam) are unchanged.

This is acceptable for v1 only because **invariant 8's own final clause makes the PR's real CI the
final gate** — a false local green is caught downstream by CI before it can merge. The local green
gate is an early, fallible signal, not the authority it was specified to be.

## Considered Options

- **Host-driven in-sandbox suite run via the persistent `Sandbox` handle** (`createSandbox()` →
  `sandbox` exec returning `ExecResult` *with stdout*, rather than the fire-and-forget hooks the
  spike ruled out). This is the path that would **restore ADR-0011 §3 as written**: Dugout runs kiro
  for the *build only*, then itself execs the test command (machine reporter) before/after and parses
  the structured output host-side. The spike evaluated only the *hooks* channel and did not assess
  this one — so it is **deferred to a follow-up spike** (the companion issue), not adopted now.
- **Grade host-side against the merged-back branch.** Sand Castle bind-mounts the worktree and merges
  the produced branch back to the local clone, so the host *could* run the suite itself. Rejected for
  v1 as the default: the host toolchain need not match the sandbox image's (invariant 8 says "in the
  sandbox"), so a host run can disagree with the box. Still a viable fallback the spike should weigh.
- **Block #7 until true harness-side grading exists.** Rejected: ships nothing, and the folded report
  is a serviceable v1 expedient with CI as the backstop.

## Consequences

- **The green gate is gameable / fallible by construction.** Concretely, a build can be graded green
  when it is not: (a) kiro under-reports `afterFailures` (omits a still-failing test) — the most
  dangerous mode, since the builder grading itself biases toward success; (b) the two suite runs are
  not comparable — a subset, unstable test ids, or a dirty/partially-reverted tree make the set diff
  meaningless; (c) kiro fabricates a plausible report without running the suite. The harness cannot
  detect any of these because it witnesses neither run.
- **Partial mitigations only** (prompt-level, not enforcement): require the full suite, require stable
  test ids (file + test name). These ask the agent to behave; they do not verify it did.
- **This is in tension with the project's stance elsewhere** (`CONTEXT.md`: replay output is
  "human-verified, never agent-graded"). Execute grading is, in v1, agent-graded.
- **Must be revisited before #8.** Story-branch accumulation stacks later specs on earlier "green"
  ones, so a false green compounds — the cost of this tradeoff rises sharply once #8 lands. The
  follow-up spike (restore harness-observed grading) should be a blocker-or-companion on #8.
- `grade-execute.ts` is unaffected by the eventual fix: only the **source** of `DugoutTestReport`
  changes (host-observed machine output instead of kiro's tag), not the diff logic.
