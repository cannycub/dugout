# Replay specs are designated by the developer at the approval gate, not the draft agent

A **replay spec** is a spec whose verification is a replay (a recorded production input stream
re-run through the whole pipeline, the output **human-verified** via Athena) rather than the spec's
own automated tests. Replay specs default `review-required`. The question this ADR settles: **who
decides a spec is a replay spec?**

Originally (CONTEXT.md, ADR-0007) the **draft agent** proposed replay specs as part of the fan-out,
and the developer corrected it at the approval gate. Building the real draft adapter (#4) made the
flaw concrete: a one-shot agent reading a ticket + read-only code has **no reliable signal** for
"this spec will be verified by a replay." Replay-vs-test is a fact about the team's verification
strategy and the data-pipeline's role, not something inferable from the ticket text. Asking the
agent to flag it invites exactly the guessing invariant 1 forbids — and a wrong guess silently
mis-defaults `review-required`.

**Decision: the developer designates replay specs, at the approval gate. The draft agent never
flags them.**

- `DraftedSpec` (the agent's output) drops `isReplaySpec` — the agent's output type no longer
  carries a flag it cannot set. The draft-mode methodology prompt says nothing about replays.
- Drafted specs start `isReplaySpec: false`. The developer designates replay specs via
  `Preflight.replaySpecs` when approving; `approveStory` sets `spec.isReplaySpec` from it, and
  replay specs default `review-required` (the existing rule, now driven by the developer's choice).
- `isReplaySpec` remains canonical spec content (it shapes the approved plan persisted to git).

This keeps the agent honest (it only outputs what it can actually determine — single-repo specs,
restated AC, a test-first plan) and puts the verification-strategy call with the human who owns it
(the head coach), consistent with "human gates are sacred" (invariant 5).

## Considered Options

- **Agent proposes, developer corrects** (the prior model) — rejected: the agent's proposal is a
  guess with no grounding, and "correct it later" still anchors the developer on a bad default.
- **Agent flags only on an explicit ticket signal** (e.g. the ticket says "replay") — rejected as
  brittle and partial: it would miss the common case (replay-ness follows from the pipeline change,
  not the ticket wording) and re-introduce agent judgement about a non-functional property
  (invariant 6: tests prove logic, not non-functional properties — humans verify those).
- **Drop `isReplaySpec` entirely, treat replay specs as just review-required** — rejected: replay
  is a distinct, named verification method (CONTEXT.md) the UI surfaces and v1.5 will automate;
  collapsing it into a plain review-required flag loses that.

## Consequences

- Supersedes the part of CONTEXT.md's *Fan-out* / *Replay spec* entries (and ADR-0007's
  `DraftedSpec` note) that had the agent proposing replay specs; those are updated to say the
  developer designates them.
- `Preflight` gains `replaySpecs?: string[]`; `approveStory` designates `isReplaySpec` from it.
  Wired at the orchestrator/API level here; the **pre-flight UI** for the developer to toggle a
  spec as a replay spec is a follow-up (it is the only remaining piece, and is UI work →
  `frontend-design`). Until it lands, the walking-skeleton demo drives its review-required stop via
  the existing "mark review-required" toggle.
- The draft adapter, its methodology prompt, and the fakes/seed no longer set `isReplaySpec`.
