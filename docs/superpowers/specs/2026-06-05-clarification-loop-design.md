# Design: needs-clarification → re-draft loop (issue #21)

**Date:** 2026-06-05 (grilled 2026-06-07) · **Branch:** `feat/21-clarification-loop` ·
**Issue:** cannycub/dugout#21

## Problem

Today a `needs-clarification` draft outcome is a **dead end** in the running app: `App.tsx`
surfaces the agent's questions in the error banner and stops. The port + adapter side already
exists (issue #4, merged) — the `clarifications` field on `DraftInput`, the `ClarificationRound` /
`ClarifyingQuestion` types, and the adapter's prompt-folding + continuity test. This issue is
purely the **orchestrator → IPC → UI** wiring so the loop closes end-to-end: dev answers →
harness re-drafts → converges to `drafted` (or falls through to `needs-info`).

ADR-0007 deferred "the answer→re-draft loop, run-state for a parked story" to a follow-up — this
is that follow-up, drawn as far as #21's ACs require.

## Decisions

1. **State model — stateless.** The renderer holds the growing `ClarificationRound[]` (and the
   `DeclaredRepo[]` from the first attempt) in component state and passes the full array on each
   `draft()` call. No new run-state, no DB changes. This keeps the port a pure function of its
   input (ADR-0007) and avoids persisting the dev's typed answers — which are **user input, not
   rebuildable** — as run-state, which would violate the "SQLite holds only ephemeral, rebuildable
   run-state" invariant. The loop is lost if the app closes mid-clarification, but nothing is
   committed yet, so the cost is just re-answering.

2. **Answer rules — all questions answered.** Re-draft is disabled until every question has a
   non-empty answer. The agent asked because it genuinely needs each answer to avoid guessing
   (invariant 1). The dev abandons the loop rather than half-answering.

3. **Loop & exit — show prior rounds read-only + abandon.** On round 2+, earlier rounds' Q&A
   render collapsed and read-only above the new question form. An explicit **Abandon** affordance
   drops the in-memory rounds and returns to the roster.

4. **Param name — `clarifications` everywhere.** Rename the shipped port field
   `DraftInput.priorClarifications` → `clarifications`, used identically across port →
   orchestrator → API → IPC → renderer impl. The temporal qualifier ("prior") was **dropped on
   purpose**: at submit time the rounds are the developer's *current* answers, not an archive —
   "prior" encoded the draft engine's POV, not the head coach's. The oldest-first / fed-back-in
   framing lives in the field's doc comment. The field carries `ClarificationRound[]` (answered
   rounds), distinct from the `ClarifyingQuestion` type. Touches the merged
   `kiro-draft-adapter.ts` + its continuity test. **ADR-0007 stays verbatim** with a dated
   "Updated" note recording the rename (decision unchanged) — done during the grill.

5. **Repos reused across rounds.** Since it's stateless, the renderer already holds the declared
   repos from the first attempt; each re-draft reuses them — no re-declaring per round.

6. **The loop is pre-story, not a "Stop."** During the round-trip there is **no `Story` and no
   story branch** — `draftStory` only persists a `Story` on the `drafted` outcome, and `getStory`
   returns `undefined` throughout. So the clarification loop is **not** a glossary "Stop" (which
   requires a story branch + single-writer-on-the-line semantics); it sits *before* the first Stop
   in the lifecycle. We do **not** introduce a `"drafting"` `StoryStatus` — persisting a
   content-less story would create a resumable-looking-but-not-resumable half-state (the status
   would survive but the ephemeral questions/rounds would not), and a `Story` is defined as
   canonical content + run-state, which a pre-draft story lacks.

7. **Explicit renderer view-state (no implicit `null`).** The phase is modeled as a discriminated
   union in `App.tsx`, not inferred from `story === null`:

   ```ts
   type View =
     | { type: "roster" }
     | { type: "declaring"; ticket: Ticket }
     | { type: "clarifying"; ticket: Ticket; repos: DeclaredRepo[];
         questions: ClarifyingQuestion[]; rounds: ClarificationRound[] }
     | { type: "story"; story: Story };
   ```

   `view.type === "clarifying"` is unambiguous, and the loop payload (questions + rounds) is
   co-located with the phase that owns it. Discriminant is **`type`** (conventional TS key; avoids
   `state.state` redundancy).

8. **Loop termination.** A re-draft can return any `DraftOutcome` arm:
   - `drafted` → `view` becomes `{ type: "story", story }`. Converged.
   - `needs-clarification` again → stay in `clarifying`, append the round, render new questions.
   - `needs-info` (mid-loop) → the ticket is now judged too thin to spec at all; surface through
     the **existing `needs-info` kickback banner**, **exit the clarifying view**, and **discard the
     in-memory rounds** — the path forward is editing the Jira ticket, not more answers
     (ADR-0007: `needs-info` is terminal-to-Jira).
   - **No hard round cap** — the **Abandon** button is the only exit besides convergence; live
     kiro asking repeatedly is itself a signal the head coach acts on.

## Section 1 — Orchestrator (`src/core/orchestrator.ts`)

`draftStory` gains an optional rounds parameter and forwards it straight to the port:

```ts
async draftStory(
  ticketKey: string,
  opts: { repos: DeclaredRepo[]; clarifications?: ClarificationRound[] },
): Promise<DraftStoryResult>
```

- Line ~106 becomes `executor.draft({ ticket, repos: opts.repos, clarifications: opts.clarifications })`.
- The `needs-clarification` arm is unchanged — it already passes `questions` through. **Nothing
  new is persisted** — consistent with the `DraftStoryResult` doc-comment ("nothing is persisted
  for a stop outcome") and decisions 1 & 6.
- Oldest-first ordering is the renderer's contract; the orchestrator forwards the array verbatim.

## Section 2 — API contract + IPC (`src/shared/dugout-api.ts` + 3 layers)

```ts
draft(storyKey: string, repos: DeclaredRepo[], clarifications?: ClarificationRound[]): Promise<DraftStoryResult>
```

- `src/main/index.ts` — `CHANNELS.draft` handler unpacks the third arg, passes to `draftStory`.
- `src/preload/index.ts` — forwards the arg over IPC.
- `src/renderer/src/local-dugout-api.ts` — same signature for the in-renderer test impl.
- Additive/optional → first-attempt callers unchanged. No new channel (`CHANNELS.draft` reused).

## Section 3 — UI (`src/renderer/src/App.tsx`, via `frontend-design`)

A pre-flight **answer form** rendered when `view.type === "clarifying"`. The `View` union
(decision 7) holds the `DeclaredRepo[]` from the first attempt and a growing
`ClarificationRound[]`.

- On a `needs-clarification` result: transition to `clarifying`, render one labelled input per
  `ClarifyingQuestion`; **re-draft disabled until all answers non-empty** (decision 2).
- On submit: build a `ClarificationRound` by pairing each `{id, prompt}` with its answer →
  `{ questionId: id, question: prompt, answer }`, append to the rounds array, call
  `draft(key, repos, rounds)`.
- Round 2+: prior rounds shown **collapsed, read-only** above the new questions; an **Abandon**
  button drops the rounds and returns to the roster (decision 3).
- Termination per decision 8 (`drafted` → story view; `needs-info` → kickback banner + exit).
- Scope guard: this is the **narrow** answer form, not issue #5's spec-review UI.
- **All UI work goes through `frontend-design`** (CLAUDE.md standing rule).

## Section 4 — Testing (all three tiers)

**Tier 1 — Unit (`npx vitest run`, fakes only):**
- Extend `FakeExecutor` to accept a **sequence** of draft outcomes (it currently returns one
  canned `config.draft`). Keep `draftCalls` recording inputs.
- Orchestrator test: round 1 → `needs-clarification`, round 2 (with `clarifications`) → `drafted`;
  assert via `draftCalls` that rounds forwarded **oldest-first** and the loop converges. Add a
  `needs-info`-mid-loop case (round 2 → `needs-info`).
- `App.test.tsx` answer-form path (IPC-faked), incl. the `View` transitions.
- Rename `priorClarifications` → `clarifications` in the existing adapter continuity test.

**Tier 2 — E2E (`npm run test:e2e`, UI → real IPC → fakes, deterministic):**
- Add a clarification round proving the orchestrator → IPC → UI plumbing end-to-end.

**Tier 3 — Agent integration (real kiro, NOT in CI):**
- Add a **multi-round** live case: underspecified ticket → real kiro asks → answer → converges to
  `drafted` (or `needs-info`). This is the real proof of "loop converges across multiple rounds" —
  Tier 1/2 can't establish agent convergence.
- **Formalize the suite** (new convention — CLAUDE.md updated during the grill):
  - File suffix **`*.agent.test.ts`** — rename the existing `kiro-draft-adapter.live.test.ts` →
    `kiro-draft-adapter.agent.test.ts`.
  - Runner **`npm run test:agent`** (points at an agent-only vitest config).
  - **No runtime flag.** The agent suite is **structurally excluded** from the default `npm test`
    via a vitest `exclude` for `**/*.agent.test.ts` — not gated by `KIRO_LIVE`. (A flag silently
    skips and reports green → false confidence the agent was tested.) Drop the `KIRO_LIVE` gate.
  - They consume `KIRO_API_KEY` (+ optional `KIRO_BIN`) as inputs and **fail loudly** if absent,
    never skip. The agent is stateless → parallel-safe.

**Live mode through the app:** `SwitchableExecutor` routes `draft()` to `KiroDraftAdapter` and
`draftStory` is the same path in both modes, so forwarding `clarifications` covers Live
automatically — confirm answers survive the IPC round-trip on Live (manual check fine).

## Docs touched (during the grill)

- **CONTEXT.md** — added glossary entries **`needs-clarification`** and **Clarification round**
  (the matched pair to `needs-info`; mirrors the ADR-0007 split).
- **ADR-0007** — dated "Updated 2026-06-07 (#21)" note recording the `priorClarifications` →
  `clarifications` rename (body verbatim; decision unchanged).
- **CLAUDE.md** — testing-pyramid tier 3 rewritten to the `*.agent.test.ts` / `npm run test:agent`
  / structural-exclusion / fail-loud convention.

## Out of scope (don't scope-creep)

- **#5** — spec review & feedback loop (broad PR-review-style HITL UI). The answer form is narrower.
- **#19** — replay-spec pre-flight UI.
- Persisted/parked run-state (a `"drafting"` status) for surviving an app restart mid-clarification
  (rejected — decision 6).
- **Metrics** — a clarification-round ticket-quality metric (invariant 9) was logged to the
  metrics issue **#13**, not built here.
