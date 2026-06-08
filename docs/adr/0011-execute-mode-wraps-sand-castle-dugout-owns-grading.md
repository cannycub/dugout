# Execute mode wraps Sand Castle; Dugout owns grading (green/ambiguous/red)

**Execute mode** (CONTEXT.md) builds one approved spec inside an isolated, read-write sandbox,
following red→green TDD, and is graded by the per-spec green gate (invariant 8: the full local suite
passes in the sandbox, pre-existing failing tests baselined). Mid-build ambiguity must fail the spec
for a **clean restart** — the agent never guesses and never blocks for input (invariant 1). This ADR
settles **how** execute mode is built (issue #7).

## Decision

**Wrap the external Sand Castle orchestrator; Dugout owns only the grading and the outcome.**

1. **Sand Castle is Matt Pocock's external `@ai-hero/sandcastle`** (`sandcastle.run()`), not our
   code. It owns the expensive, error-prone harness: sandbox lifecycle, the agent iteration loop
   (completion signal, idle/completion timeouts, abort), **provider-agnosticism** (built-in Docker,
   Podman, Vercel/Firecracker, custom), and **automatic git branch merge-back** to the host clone.
   The sandbox **backend is a Sand Castle provider (config)** — Docker in v1, others later — which
   is exactly the "swappable backend (Docker now, custom/cloud later)" requirement.

2. **The agent inside the box is kiro**, consistent with draft mode. Sandcastle ships `claudeCode`,
   `codex`, `opencode`, etc. but not kiro, so Dugout supplies a **custom Sandcastle `AgentProvider`**
   for headless kiro (`buildPrintCommand` — the invocation we already have in `kiro-runner.ts` — +
   `parseStreamLine`; `captureSessions: false`). The provider is small; the harness it rides on is
   Sandcastle's.

3. **Dugout owns grading; kiro never self-reports green** (invariant 8). After kiro's completion
   signal, the harness runs the full suite *in the sandbox* and compares the failing set to a
   baseline captured on the seed. The grading is a **pure function** (`grade-execute.ts`), the
   highest-value unit-test target.
   > **Amended by [ADR-0012](0012-execute-grading-runs-on-kiros-folded-self-report-in-v1.md).**
   > Sand Castle 0.7 exposes no host-readable in-sandbox suite run (its hooks are fire-and-forget),
   > so v1 ships the inverse of this clause: **kiro** runs the suite twice and self-reports both
   > failing-id lists, and the harness only diffs them. "The harness runs the full suite" and "kiro
   > never self-reports green" are deferred — see ADR-0012 for the integrity caveats and the path back.

4. **The `ExecutorPort` outcome contract gains a third arm** — `ExecuteOutcome` becomes
   `green | ambiguous | red`:
   - `green { branch }` — the green gate is met.
   - `ambiguous { reason }` — kiro hit a fork it cannot resolve without guessing and refused to
     proceed (the build-time analogue of `needs-clarification`); the developer re-clarifies, then the
     spec clean-restarts.
   - `red { reason }` — kiro completed *without* ambiguity but the green gate is not met (or the test
     report is missing/unparseable); nothing to clarify — retry or investigate.
   Both non-green arms fail the spec + story for a clean restart (invariant 1); the orchestrator's
   mechanism is unchanged (`result !== "green"` already means fail). Detection: ambiguity is
   kiro-signalled (explicit marker, `--no-interactive`); green/red is harness-graded; **operational
   failures** (sandbox won't start, kiro crash/timeout, Docker absent) **throw** — they are
   environment errors, not restartable spec outcomes.

5. **The test seam is the injected `run` function** (`typeof sandcastle.run`), mirroring how
   `runKiro` is injected into the draft adapter. Unit tests pass a fake `run`; real Docker + kiro
   runs live in the agent tier (`kiro-execute-adapter.agent.test.ts`, not in CI), which additionally
   requires a reachable Docker daemon + a Sand Castle image and fails loudly if absent.

Scope: **single spec** (#7). Story-branch creation and accumulation (the real `merge()`, seeding
spec N from the updated story-branch HEAD, same-repo-serial / cross-repo-parallel) are **#8**.

## Considered Options

- **Homegrown thin execute adapter** (our own `docker run` + kiro spawn + git seed/merge-back +
  a homegrown `SandboxPort`) — rejected: it reimplements the expensive part of Sandcastle
  (lifecycle, merge-back, the provider abstraction we specifically want for cloud later) and leaves
  us owning/maintaining the fiddly failure modes (orphaned containers, partial merges, lost
  branches). The part it would save us (avoiding a dependency) is outweighed by the part it costs.
  Sand Castle was already a CONTEXT.md commitment.
- **Use Sandcastle's built-in `claudeCode` for execute** — rejected: mode-asymmetric (kiro drafts,
  Claude Code builds) for no clear benefit. The custom kiro provider is small (kiro stdout is plain
  text), so consistency wins.
- **Keep the binary `green | ambiguous` outcome** — rejected: it forces a tests-still-red build to
  be mislabelled "ambiguous," corrupting the domain term. The third arm is nearly free (it does not
  touch the state machine) and keeps the head-coach's recovery path honest (re-clarify vs retry).

## Consequences

- New dependency `@ai-hero/sandcastle`. The Docker image is dev/CI environment setup, exercised only
  in the agent tier (never in default `npm test`/CI).
- `ExecuteOutcome` gains `red`; the fake executor, the adapter, and the `CONTEXT.md` glossary
  (**Execute outcome**) are updated. The orchestrator's fail-on-non-green logic is unchanged.
- `CONTEXT.md` gains a **Sand Castle** term and retunes **Execute mode** (Sand Castle ≠ Docker;
  Docker is one provider). `CLAUDE.md`'s agent tier notes the Docker/image prerequisite.
- Replay specs are **not** special-cased in execute mode: every spec is built and graded identically
  (invariant 8); a replay spec's true verification is the replay, reached as an additional human gate
  via `review-required` (manual, outside Dugout in v1). A replay spec may add few/no new tests, so
  for it `green` degrades to "the full suite still passes (no regressions)."
- Replacing Sand Castle, or moving grading into the agent, would require a new ADR superseding this.
  Moving grading into the agent is exactly what v1 did under the Sand Castle 0.7 constraint — recorded
  in [ADR-0012](0012-execute-grading-runs-on-kiros-folded-self-report-in-v1.md), which amends §3.
