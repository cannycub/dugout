# Merge-at-green: a green spec merges immediately, `review-required` is a post-merge stop (amends ADR-0011, ADR-0013)

ADR-0013 settled the branch *model* (spec-branch namespace, story-HEAD seed, clean restart) but left
the real `merge()` and the merge *timing* to #8. Implementing story-branch accumulation (#8) forced a
decision the single-spec code never had to make: **when does a green spec branch merge into the story
branch — immediately, or only after the developer approves a `review-required` stop?** The
pre-#8 code merged a `review-required` spec only on `resumeAfterReview` (merge gated on approval),
which left the green-but-unmerged spec sitting on its spec branch during the stop. That created an
ambiguity about *where the developer writes* during the stop — the spec branch (where the green code
lives, per invariant 1's review-feedback exception) or the story branch (per the glossary's "Stop =
single writer on the story branch"). The two readings imply different branches, and the difference is
exactly whether a merge can become a conflicting three-way merge.

## Decision

**Every green spec merges into `story/<key>` immediately, inside the spec loop. `review-required` is a
pause that happens *after* that merge, not a gate on it.**

1. **Merge-at-green, uniformly.** When a spec grades `green`, `advanceFrom` merges its
   `spec/<key>/<specId>` branch into `story/<key>` right away — `review-required` or not. A
   non-review spec then continues to the next spec; a `review-required` spec then stops at
   `awaiting-review`. The spec rests at status `merged` while the story rests at `awaiting-review`
   ("merged and integrated; paused for your review before the next spec runs").

2. **`resumeAfterReview` no longer merges.** The spec is already merged at the stop, so resume simply
   continues `advanceFrom` from the first still-`approved` spec.

3. **One developer write surface: always the story branch.** Because every green spec is merged
   *before* any stop is reached, there is never a pending spec branch for the developer to steer. All
   developer touch-ups (invariant 1's "iterating on completed, green code") land on the story branch —
   the surface that becomes the PR. This removes the spec-branch/story-branch ambiguity by
   construction.

4. **Merges are `--no-ff` and unconditionally fast-forwardable.** Because the merge fires the instant
   the spec is green — before any stop or developer commit can move story HEAD — the spec branch is
   *always* a descendant of the current story HEAD at merge time, in every path including
   `review-required`. So the merge can always fast-forward; we nonetheless use `git merge --no-ff` to
   force one explicit merge commit per spec, so the one-PR-per-repo reads as one merge bubble per spec
   under `git log --first-parent` (the PR is the human gate, invariant 5 — worth making legible).

5. **A failed merge is an operational error, never a spec grade.** A conflict cannot arise in v1's
   serial flow (point 4), so a merge that fails signals out-of-band manual git or a bug. It is handled
   like ADR-0013's `execute()` operational throws: `git merge --abort`, unwind the story to a
   restartable `failed` state, surface the error. It must **not** become a `red`/`ambiguous` outcome —
   the spec already graded green; a merge failure is mechanical, like a missing clone.

The `review-required` gate is still honoured: *"before the next spec stacks on it"* refers to the
**next** spec, which does not run until resume. Merging *this* spec is not "stacking the next one."

## Considered Options

- **Merge gated on approval (the pre-#8 behaviour): `review-required` stops *before* the merge, and
  `resumeAfterReview` performs it.** Rejected. It quarantines the green spec on its spec branch during
  the stop, which forces the developer's review-feedback commits onto the spec branch and contradicts
  the glossary's "single writer on the story branch." It also admits a real three-way merge: a
  developer commit to the story branch during the stop moves story HEAD while the pending spec branch
  is based on the old HEAD, so the resume-merge can conflict. Merge-at-green eliminates the ambiguity
  *and* the conflict class.
- **Keep merge-gated-on-approval but resolve the ambiguity by declaring a per-stop-type write
  surface** (spec branch at a `review-required` stop, story branch elsewhere). Rejected: it preserves
  the conflict class and asks the developer to hold two mental models of "where do I commit." A single
  always-the-story-branch surface is simpler and is what merge-at-green yields for free.
- **Plain fast-forward instead of `--no-ff`.** Rejected: a fast-forward flattens each spec's
  red→green→refactor micro-commits into one indistinguishable stream on the story branch. `--no-ff`
  keeps per-spec boundaries legible for the human reviewer at no real cost.

## Consequences

- **`advanceFrom` merges on green for all specs; `resumeAfterReview` drops its `merge()` call** and
  advances from the first `approved` spec. A `review-required` spec's resting status during the stop is
  `merged`, not `green`.
- **CONTEXT.md is sharpened** (done alongside this ADR): "Stop" states the write surface is always the
  story branch; "review-required" states the stop happens *after* the spec merges.
- **Conflict handling is a defensive backstop, not a designed-for flow.** v1 never exercises it; it
  exists so an out-of-band manual git state fails cleanly (abort + restartable `failed`) instead of
  wedging.
- **This decision is independent of how a spec is *graded* green.** Accumulation amplifies the
  ADR-0012 self-report risk (a false green now compounds across stacked specs); restoring
  harness-observed grading is tracked as the fast-follow companion #33, with CI-on-the-PR (invariant 8)
  and peer review (invariant 5) as the interim backstops. Merge-at-green does not change that risk
  surface — it only fixes *when* an already-green spec lands.
- **Scoped to serial v1.** The "always fast-forwardable" property relies on serial execution (nothing
  else writes the story branch between a spec's fork and its merge). Cross-repo parallelism is deferred
  to a follow-up issue; if it lands, the conflict class returns and this ADR's point 4–5 must be
  revisited (per-lane story branches already make different-repo merges independent, so the revisit is
  about *same-story concurrency*, not cross-repo).
