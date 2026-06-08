# Execute mode — design (#7)

**Status:** approved design, pre-implementation. **Scope:** issue #7 (single-spec execute mode).
**Out of scope:** #8 (story-branch accumulation / stacking / cross-repo parallelism). The fan-out
(story → spec set) already exists in draft mode and is untouched here.

## Problem

Today `Orchestrator.execute()` always returns a fake `green` and `merge()` is a git no-op. There is
no real **execute mode** — the executor invocation that builds a single approved spec's code inside
an isolated **Sand Castle** sandbox (read-write), follows red→green TDD, and is graded green by the
full local test suite passing with pre-existing failing tests baselined. Mid-build ambiguity must
**fail the spec for a clean restart** — the agent never guesses and never blocks for input
(CONTEXT.md invariant 1).

## Decision: wrap Sandcastle; own only the grading

**Sand Castle is Matt Pocock's external `@ai-hero/sandcastle`** (`sandcastle.run()`) — a
provider-agnostic orchestrator for sandboxed coding agents. It owns the expensive, fiddly harness we
must NOT reimplement:

- sandbox lifecycle (create / run agent inside / dispose);
- **provider-agnosticism** — built-in `docker()`, `podman()`, `vercel()` (Firecracker), `no-sandbox`,
  + custom providers. This satisfies the "Docker now, custom/cloud later" requirement; the backend
  is a Sandcastle **provider (config)**, not a homegrown port;
- running the agent inside the box (iteration loop, completion signal, idle/completion timeouts,
  `AbortSignal`);
- **branch strategy + automatic git merge-back** of commits to the host clone.

What stays **Dugout's** (Sandcastle does not do these):

1. the `ExecutorPort.execute()` contract + orchestration (unchanged);
2. **green grading with pre-existing reds baselined** — Sandcastle has a completion signal, not a
   TDD-green test grade;
3. the execute-methodology (red→green) prompt;
4. mapping `{Sandcastle result} + {test grade}` → `ExecuteOutcome` (`green` | `ambiguous`) and the
   ambiguity → fail + clean-restart semantics (the orchestrator already implements the restart).

The agent inside the box is **kiro** (consistent with draft mode). Sandcastle ships `claudeCode`,
`codex`, `opencode`, etc. but not kiro, so we supply a **custom kiro `AgentProvider`**. Reading
Sandcastle's source: the provider interface is small — `buildPrintCommand(opts) → { command,
stdin? }` (the headless-kiro invocation we already have in `kiro-runner.ts`) + `parseStreamLine(line)
→ events` (kiro stdout is plain text → near-trivial; `captureSessions: false`). The expensive part
(harness) is Sandcastle's; the part we write (provider) is small.

Rationale and the considered alternatives (homegrown thin adapter; built-in Claude Code for execute)
are recorded in **ADR-0011** (written at implementation time). Sand Castle was already a CONTEXT.md
commitment; this affirms and details it.

## Components

| Module | Responsibility |
|---|---|
| `core/adapters/kiro-execute-adapter.ts` | implements `ExecutorPort.execute()`: build the `run()` config, invoke the injected `run`, grade the result → `ExecuteOutcome` |
| `core/adapters/kiro-agent-provider.ts` | a Sandcastle `AgentProvider` for headless kiro (`buildPrintCommand` + `parseStreamLine`), modelled on the `codex`/`opencode` built-ins |
| `core/adapters/execute-methodology.ts` | the red→green TDD prompt; instructs kiro to run the full suite and emit a `<dugout-test-report>` block + the completion signal |
| `core/grade-execute.ts` | **pure** grading: `(baselineReds, afterReport) → "green" \| { ambiguous, reason }`. The high-value unit-test target |

**Test seam:** the `run` function (type = Sandcastle's `run`) is **injected** into
`kiro-execute-adapter`, exactly as `runKiro` is injected into `kiro-draft-adapter` today. Unit tests
pass a fake `run` returning canned `{ commits, branch, output }`; no real Docker/kiro in unit tests.
The Docker/Vercel/custom **provider is config**, not our code.

## Execute flow (single spec)

1. **Baseline** — run the full suite on the seeded story-branch HEAD and capture the **failing-test
   set** (pre-existing reds). Captured once per story; for #7's single spec, just before the run.
2. **Build** — `run({ agent: kiroAgent, sandbox: <provider>, cwd: clonePath,
   prompt: methodology(spec), branchStrategy: { type: "branch", branch: specBranch },
   completionSignal, output: Output.object({ tag: "dugout-test-report", schema }) })`. kiro does
   red→green inside the box; commits land on `specBranch` and merge back to the host clone.
3. **Grade (pure)** — `green` iff `afterReport.failures \ baselineReds === ∅` (full suite passes,
   pre-existing reds baselined). Otherwise → `ambiguous`.
4. **Outcome** — `{ result: "green", branch: result.branch }` or `{ result: "ambiguous", reason }`.
   The orchestrator already treats non-green as fail + clean restart; nothing leaks downstream.

## Acceptance-criteria mapping (issue #7)

- *kiro in a Sand Castle sandbox seeded from a base branch* → `run()` + `branchStrategy`/`cwd` ✅
- *red→green TDD* → `execute-methodology` prompt ✅
- *per-spec green = full suite, pre-existing reds baselined* → `grade-execute.ts` ✅
- *ambiguity → fail + clean restart; no guessing/blocking* → kiro `--no-interactive`; `ambiguous`
  outcome; existing orchestrator restart ✅
- *branch persisted out before disposal* → Sandcastle branch merge-back (its job) ✅
- *tested via fake executor + git mechanics on temp repos* → fake `run` for grading logic; git
  mechanics are **Sandcastle's** to test, not ours ✅

## Testing (the pyramid)

- **Unit** — `grade-execute.ts` (pure: baseline-vs-after, green/ambiguous edges); `kiro-execute-
  adapter` against a fake `run` (config built correctly, outcome mapped correctly, ambiguity on
  missing/malformed report); `kiro-agent-provider` (`buildPrintCommand`/`parseStreamLine`) as pure
  string functions.
- **Agent integration** — `kiro-execute-adapter.agent.test.ts`: a real `sandcastle.run()` against
  Docker with real kiro on a throwaway repo + spec; proves kiro builds → commits → merges back and
  the suite goes green. **Not in CI** (slow/billable/non-deterministic); runnable via
  `npm run test:agent`; consumes `KIRO_API_KEY`; fails loudly if absent.
- **e2e** — unaffected (stays on the fakes; `execute` remains fake in the fakes path).

## New dependency

`@ai-hero/sandcastle`. The Docker image is dev/CI environment setup, exercised only in the agent
tier (never in the default `npm test`/CI).

## Residual item to pin during implementation (spike, not a blocker)

The **baseline-reds capture mechanism** — a sandbox `hook` that runs the suite and writes a report
we read, vs. a thin pre-pass. Both feasible with the documented API; confirmed against the real lib
while wiring the agent test. The **grading logic is pure and fully unit-testable regardless.**

Also confirm during the first real `run()`: the **test command per repo** (convention `npm test`
vs. configured) and the exact `<dugout-test-report>` schema kiro emits.
