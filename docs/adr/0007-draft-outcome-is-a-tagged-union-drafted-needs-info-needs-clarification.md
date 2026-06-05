# Draft outcome is a tagged union: drafted | needs-info | needs-clarification

`ExecutorPort.draft()` is the primary testable seam and now has more than one honest outcome.
Until issue #4 it returned `DraftResult = { specs: DraftedSpec[] }` — the only shape was a
successful fan-out. The real draft-mode adapter (headless kiro, read-only, no sandbox) must also
be able to **stop rather than guess** (CONTEXT.md invariant 1). It stops in two materially
different ways, so `draft()` returns a **closed, discriminated union** keyed on `result` —
mirroring the existing `ExecuteOutcome` (`{ result: "green" | "ambiguous" }`) so both port methods
read the same way at every call site and across IPC:

```ts
export type DraftOutcome =
  | { result: "drafted"; specs: DraftedSpec[] }
  | { result: "needs-info"; reason: string }
  | { result: "needs-clarification"; questions: ClarifyingQuestion[] };
```

- **`drafted`** — the fan-out succeeded; `specs` are ready for the approval gate. `DraftedSpec` is
  `{ repo, markdown }`. (It originally also carried `isReplaySpec?`; **ADR-0008** removed that — the
  developer, not the draft agent, designates replay specs at the approval gate.)
- **`needs-info`** — the ticket is too thin to spec **at all**. A *terminal* kickback: there is
  nothing to answer in-app; the **ticket itself** must be enriched out of band. Maps 1:1 to the
  existing `needs-info` glossary state and Jira label. Carries a prose `reason`.
- **`needs-clarification`** — the agent **can** spec, but is blocked on specific, answerable
  questions. A *resumable* round-trip: the developer answers, the harness re-assembles the prompt
  and calls `draft()` again. Carries structured `ClarifyingQuestion[]` (`{ id, prompt }`).

### Why two stop outcomes, not one

They look alike ("stop, don't guess") but differ on the axis the orchestrator routes on: **is
there a forward move the developer can make in-app, or must the ticket change?** `needs-info` is
terminal-to-Jira; `needs-clarification` is a loop. Their payloads are honestly different shapes (a
reason vs. a question set) and they drive different UI (a kickback banner vs. a question form).
Issue #4 also lists *"asks clarifying questions"* and *"needs-info kickback"* as **two separate
acceptance criteria**. Collapsing them would force one arm to carry an optional `reason` *and* an
optional `questions`, reintroducing the "which field is set?" ambiguity a tagged union exists to
kill. (Note: the agent never guesses regardless — invariant 1 — so neither outcome is "the agent
chose to ask instead of proceeding"; the split is about the *resolution path*, not agent latitude.)

### Continuity for the round-trip (kiro is one-shot)

kiro headless (`kiro-cli chat --no-interactive`) has **no mid-session input** — a question outcome
ends the run. Continuity is reconstructed by the **harness**, not a session: `DraftInput` gains
`priorClarifications?: ClarificationRound[]`, the oldest-first history of question rounds and the
developer's answers. The adapter folds these into the freshly-assembled prompt each call, so a
re-draft converges without kiro holding any state. The port stays a pure function of its input;
the CLI's statelessness never leaks past the adapter.

### Exhaustiveness is compiler-enforced

`draft()` feeds an irreversible workflow (spec approval → sandboxed execution → PRs). Silently
dropping a `needs-info` would let a thin ticket slide toward a guessed build — the exact failure
invariant 1 forbids. Consumers `switch (outcome.result)` with a final `assertNever(outcome)`
(`src/core/exhaustive.ts`), so adding a future variant is a **build error**, not a runtime
surprise. Reaching `outcome.specs` is only possible inside `case "drafted"`, which makes the
ADR-0006 repo-scope validation (every drafted spec targets a declared repo) unmissable.

## Considered Options

- **One stop outcome carrying `questions` for both** (the minimal design) — rejected: it cannot
  distinguish "rewrite the ticket" from "answer X and re-draft" without the consumer re-inspecting
  the payload, and it muddies the `needs-info` → Jira-label mapping. Honest only if drafting could
  never produce answerable questions, which #4 explicitly requires it to.
- **Optional `kickback?` field on a `{ specs }` record** (drafted as the bare record) — rejected:
  it is ergonomic on the happy path but lets a careless consumer iterate `specs` straight past an
  unhandled kickback (silent empty fan-out), and it breaks consistency with `ExecuteOutcome`'s
  `{ result }` discriminant. The seam is too load-bearing for an optional-discriminant footgun.
- **Rich outcome now** (per-spec `confidence`/`reviewRecommended`, partial drafts via `deferred[]`,
  cascade `dependsOn`, fan-out `rationale`) — deferred: each is named in the PRD but none is in #4.
  They slot into this union/`DraftedSpec` additively when a slice reaches for them; building them
  now widens the contract and the fakes for no current consumer.

## Consequences

- `DraftResult` is replaced by `DraftOutcome`; `DraftInput` gains `priorClarifications?`. New
  exported types: `ClarifyingQuestion` (`{ id, prompt }`), `ClarificationRound`. New shared
  `assertNever` helper.
- `Orchestrator.draftStory` switches on `outcome.result`; `drafted` is the current path verbatim
  (incl. the ADR-0006 declared-repo check). The two stop outcomes surface to the developer; their
  full lifecycle parking (Jira label, the answer→re-draft loop, run-state for a parked story) is
  drawn only as far as #4's adapter-focused ACs require — deeper lifecycle is a follow-up.
- `FakeExecutor.config.draft` widens from `DraftResult` to `DraftOutcome`; every outcome is a
  one-line literal a test can hand it (no real kiro in tests — #4 AC + CLAUDE.md).
- The real adapter wraps `kiro-cli chat --no-interactive` with read-only tool trust
  (`--trust-tools=read,grep`, never `write`) pointed at a source mount (the declared clones
  symlinked side-by-side) beside a writable specs dir. Read-only is enforced by that **tool trust**,
  not the filesystem — the symlinks expose the real clones, so the trust boundary is what keeps them
  unmutated. The kiro invocation is dependency-injected (as `JiraReadAdapter` injects `fetch`), so
  the whole adapter is tested through the port with the CLI faked.
