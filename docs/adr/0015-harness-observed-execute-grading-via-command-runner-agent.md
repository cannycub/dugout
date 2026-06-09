# Harness-observed execute grading via a command-runner agent (supersedes ADR-0012, restores ADR-0011 §3)

ADR-0011 §3 specified that **Dugout owns grading and kiro never self-reports green** (invariant 8):
after the build, *the harness* runs the full suite in the sandbox and diffs the failing set against a
baseline. The #7 spike could not find a channel for that in Sand Castle 0.7 — its lifecycle hooks are
fire-and-forget with no host-readable output — so [ADR-0012](0012-execute-grading-runs-on-kiros-folded-self-report-in-v1.md)
shipped the inverse: **kiro** runs the suite twice and self-reports both failing-id lists, and the
harness only diffs them. That made the green gate gameable by construction (the builder grades
itself), and #8 (story-branch accumulation) compounds a false green by stacking later specs on it.
ADR-0012 flagged itself "must be revisited before #8."

This ADR records the result of the #33 spike, which assessed a path ADR-0012's spike never did: not
the fire-and-forget hooks, and not a raw host-side `exec`, but **driving a non-agent command through
Sand Castle's own agent seam**. It restores harness-observed grading and supersedes ADR-0012.

## Decision

**The harness observes the suite by running it as a command through Sand Castle's public `run()`
seam, before and after kiro's build, and grades the diff host-side. kiro builds only — it no longer
authors the grade inputs.**

1. **No public `exec`; the agent seam substitutes.** Sand Castle 0.7 exposes no host-readable
   arbitrary `exec`: `createSandbox()` returns a `Sandbox` whose only methods are `run(agent)`,
   `interactive(agent)`, `close()` (the provider handle's `exec` is closed over internally and never
   surfaced). But `Sandbox.run()` builds its command from the injected **`AgentProvider`** and execs
   it in the sandbox, returning stdout. So Dugout supplies a **command-runner `AgentProvider`** whose
   `buildPrintCommand` returns the repo's *test command* rather than an LLM invocation. This is
   public-API-only, **provider-agnostic** (works for bind-mount *and* isolated backends), and
   **language-agnostic** (it execs whatever command it is given).

2. **Persistent `createSandbox()`; the seam moves from `run` to `createSandbox`.** The grade is a
   diff of two suite runs bracketing the build, which must share one worktree/branch state. The
   adapter therefore creates a persistent `Sandbox` and issues three `run()` calls against it —
   baseline (command-runner) → build (kiro) → after (command-runner). This **amends ADR-0011 §5**:
   the injected test seam is now `typeof createSandbox` (a fake returns a `Sandbox` whose `run()` is
   scripted per call). `clearSpecBranch` still runs first, so the branch is re-forked clean per run
   (invariant 1; ADR-0013).

3. **The stdout channel.** The command-runner emits a machine report to stdout; the harness reads
   `RunResult.stdout` and parses it. Chosen over reading a reporter file off the bind-mounted
   worktree because the worktree is only host-readable for bind-mount providers — a file read would
   silently re-couple grading to Docker/Podman, against the provider-agnostic requirement. Because
   `run()` throws `AgentError` on a non-zero exit and a failing suite exits non-zero, Dugout wraps
   the configured command to force `exit 0`; pass/fail lives entirely in the emitted report.

4. **Per-repo Repo config drives it, language-agnostically.** A committed `.dugout/config.yaml`
   (CONTEXT.md **Repo config**) supplies `testCommand` (a shell snippet that runs the suite and
   prints a machine report to stdout), `reportFormat` (selects the host-side `ReportParser`), and
   `toolchain` (`node`/`dotnet`, mapped to a Dugout-owned kiro+toolchain sandbox image — distinct
   from the Sand Castle backend provider). A missing/invalid config is an **operational throw** with
   a fix-it message, not a spec `red`. Dugout never silently auto-generates it (assisting the
   developer to author one is a later concern).

5. **`grade-execute.ts` is unchanged; only the producer of `DugoutTestReport` changes.** A
   `ReportParser` per `reportFormat` turns reporter stdout into the failing-id list. v1 ships native
   **`vitest-json`** (TS) and **`trx`** (C#) parsers; stable ids come from each format's durable
   field — vitest's `file + full test name`, TRX's **fully-qualified test method name** (not the
   per-run `testId` GUID, which would make the baseline⊆after diff meaningless). The diff logic and
   the green/red outcome are untouched.

6. **Outcome mapping.** baseline-run → build-run → after-run → `gradeExecute`. kiro's
   `<dugout-ambiguous>` in the build run **short-circuits** to `ambiguous` and skips the after-run
   (invariant 1 unchanged). An **unparseable/absent report from a command-runner run is an
   operational throw, not `red`** — it means the harness could not run the suite (bad command,
   missing toolchain, missing config), which is an environment error to fix, not a restartable spec
   outcome. This **inverts ADR-0012's** "missing report ⇒ red": there, kiro authored the report and
   absence meant kiro misbehaved; here the harness authors it, so absence means our run failed. A
   genuinely-failing test still yields a *parseable* report naming it in `afterFailures` → real `red`.

7. **kiro's prompt shrinks to build-only.** `execute-methodology.ts` drops the run-suite-twice /
   `<dugout-test-report>` machinery (and `TEST_REPORT_TAG`); the adapter no longer parses kiro stdout
   for a report. It keeps red→green TDD, the `<dugout-ambiguous>` escape hatch, and
   `<promise>COMPLETE</promise>`.

This **restores ADR-0011 §3 as written** — the harness runs the full suite in the sandbox and kiro
never self-reports green — via a different Sand Castle primitive than §3 imagined (the agent seam,
not a raw `exec`). ADR-0011 §1, §2, §4 are unchanged; §5's seam is amended (clause 2 above).

## Considered Options

- **Keep ADR-0012's folded self-report.** Rejected: leaves the gameable green gate live, and #8 (now
  merged) compounds a false green across accumulated specs — the exact risk ADR-0012 said must be
  resolved before #8.
- **Read a reporter file off the bind-mounted worktree** (instead of stdout). Rejected as the
  default: only works for bind-mount providers, re-coupling grading to Docker/Podman and breaking
  provider-agnosticism. Simpler to parse, but the coupling is the thing we are avoiding.
- **Block on an upstream public `exec`** on Sand Castle's `Sandbox`. Rejected: external dependency on
  another maintainer's roadmap when the agent seam already gives us an in-sandbox, host-observed run
  today.
- **A single universal report format (JUnit XML) for all languages.** Rejected: one parser is
  cheaper, but it imposes a logger package on C# repos (and others), against "design for end users."
  Native per-ecosystem parsers keep repos dependency-free at the cost of one parser per format,
  behind a seam that makes adding pytest/cargo additive.
- **One combined kiro+node+dotnet sandbox image.** Rejected: bloats over time and carries every
  toolchain on every run. Per-language images selected by `toolchain` stay lean and generalize.

## Consequences

- The green gate is now **harness-observed**: ADR-0012's three failure modes (under-reported
  `afterFailures`, non-comparable runs, fabricated report) are eliminated — the harness witnesses
  both runs with the same command and format. Invariant 8 is finally true as specified.
- **New seams and surface:** the command-runner `AgentProvider`, the `createSandbox` test seam
  (replacing the injected `run`), the `ReportParser` registry (`vitest-json`, `trx`), Repo-config
  reading (`.dugout/config.yaml`, a YAML-parser dependency), and per-toolchain image builds
  (`build:sandbox` gains node + dotnet targets).
- **Operational vs spec failure is re-drawn:** "harness could not run the suite" now throws
  (config/toolchain error) rather than grading `red`, so a misconfigured repo fails loudly instead of
  looping clean-restarts. The build run throwing (kiro crash/timeout/sandbox) remains operational, per
  ADR-0011 §4.
- **Residual limitation:** test **flakiness** (pass-at-baseline / fail-after) can now produce a
  spurious `red` where the folded report would have hidden it; honest but unsolved here, and the
  clean-restart re-runs the suite. Not addressed in this ADR.
- **Agent tier:** #33 ships live red-stays-red proofs for **both** TS/vitest and C#/dotnet (a build
  with a genuinely-still-failing test grades `red` despite kiro's narration claiming success), each
  needing its toolchain image + a reachable Docker daemon; the parsers are additionally unit-tested
  against captured reporter samples (pure functions, no sandbox).
- **Deferred follow-ups:** assisted Repo-config authoring when absent; `pytest`/`cargo` parsers when
  those repos appear.
- Replacing this mechanism, or moving grading back into the agent, would require a new ADR
  superseding this one.
