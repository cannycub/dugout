# Dugout — Design Grilling Session

> **Dugout** — the head coach's command post. The developer is the head coach: all strategy
> and every final call (the spec, the corrections, the `review-required` stops, the merge)
> live with them. Dugout sends the players (agents) onto the field (sandboxes) to execute
> the plays — but the coach makes every decision.

**Date:** 2026-06-03
**Participants:** Ian Bear + Claude (grilling session)
**Status:** Design exploration complete; pending new GitHub repo, then PRD.

---

## The original idea

Build a harness that encapsulates the team's preferred workflow for working with
coding agents. High-level flow as originally pitched:

1. App connects to Jira and pulls tickets assigned to the developer.
2. Developer selects tickets.
3. The process turns each ticket into a spec (or specs) the agent can run asynchronously.
4. The developer runs through the specs one by one.
5. Starting a spec does the dev work, then automatically spools up a test environment,
   runs the new code, checks output, and returns pass/fail to the developer.

The agent's development approach has opinions baked in (e.g. test-first). The unique,
hard parts are: (a) pulling from Jira, and (b) spooling up a test environment, running a
**replay**, and analysing output pushed to S3 / a data source.

---

## What this product actually is (consolidated)

- A **standalone Electron app**, running **locally on each developer's machine** (v1).
- **Assistive, not autonomous** — it stops at "PR created, fully linked"; it never merges,
  and it does not replace peer review.
- Built around **two swappable ports** so ~80% survives the eventual cloud move:
  - **Executor port** — v1 adapter = generate a prompt file → headless **kiro CLI** in a
    checked-out repo inside a **Sand Castle** (Matt Pocock) Docker sandbox. Later adapter =
    cloud worker. Orchestration must only know `executeSpec(spec, checkout) → result`.
  - **Env / replay port** — `provision(branch) → env handle`, `runReplay(env, corpus) → S3 URI`.
    Stub/mock in v1; real ephemeral-env API swaps in later.
- **State model:** specs are **canonical as markdown in git** (version with the code,
  diffable in PRs, portable to cloud). Only ephemeral/rebuildable run-state lives in
  **SQLite**. **Jira is NOT the source of truth** — it is a coordination *projection*.
- **UI discipline:** React renderer talks to an abstraction (IPC → main process today,
  HTTP → backend later). No `ipcRenderer` sprawl through components, or the cloud move
  becomes a rewrite.

---

## The replay model (the unique core)

- "Replay" = **data-pipeline reprocessing**: a recorded input data stream replayed
  through the entire stack. Output is **gigabytes** in S3, **queryable via AWS Athena**.
- Gigabytes can't be agent-graded — so the agent **never reads the replay output**.
  Agent's job on replay = **guide**, not judge. Human makes the pass/fail call.
- **Comparison / baseline:** one **baseline replay at story start**, **tagged with a label**
  so it can be selected out of Athena later. Per-spec double-replays were rejected as too
  expensive; one baseline per story is acceptable.
- **Pass/fail split:**
  - **Per-spec** = automated **unit / component / mocked-integration** tests (agent-graded,
    cheap, hermetic — no live deps, which is what makes local sandbox green feasible).
  - **Per-story replay spec(s)** = spool env, run replay, **human verifies** via their own
    Athena exploration. Agent only suggests *where to look*.

---

## Decisions, by branch

### Specs & the unit of work
- **Spec = unit of work.** Each spec is **single-repo**. A story spanning repos becomes
  multiple single-repo specs; cross-repo coordination happens at the **story level** via
  **versioned / back-compat contracts** (the "tax" accepted to keep specs single-repo).
- Cross-repo stories are **uncommon**.
- **Replay specs** are a story-level gate (≥1 designated per story), not per spec.
- Specs **trace to AC**; AC in these tickets is **freeform (sometimes good, sometimes not)**,
  so traceability = **agent restates AC explicitly → human ratifies at the approval gate**,
  not a mechanical field mapping.
- Spec contains: plain-language change + restated AC checklist, **test plan** (defines
  per-spec pass/fail), whether it's a **replay spec** (+ expected-change hypothesis), and
  the **fan-out** rationale (1 ticket → N specs).

### Gates (all human)
1. **Spec approval** — agent drafts specs, human reviews/edits/approves *before any build*.
2. **Replay verification** (v1.5) — human verifies replay output before merge.
3. **Peer code review** on the PR — retained; tool is assistive.
Merge is always a deliberate human action. **Never auto-merge.**

### Generation flow
- User selects Jira ticket → declares which repos are in scope (agent may suggest from a
  catalog; human confirms — no auto-inference). → Agent analyses ticket + code → asks
  **clarifying questions up front** → drafts specs → human approves.
- **needs-info escape hatch:** if the ticket is too thin to spec, the agent **flags and
  stops** (and can move the Jira ticket to `needs-info`). New Jira labels: `needs-info`,
  `ready-for-agent`.

### Execution
- **v1 substrate:** local headless kiro CLI in Sand Castle Docker sandboxes.
- **Agents never guess.** Mid-build ambiguity (after approval) = **fail the spec, re-clarify,
  restart from a clean branch** (throwaway-and-restart, not resume). No mid-build blocking
  questions — async and "stop and wait for a human" are incompatible.
- **Sandbox seeding:** each spec's sandbox seeds from the **per-repo story-branch HEAD**
  (containing prior green specs), cuts the spec branch from there, runs. On green, the spec
  branch **auto-merges into the local story branch** (local only — no remote/PR/main).
  Persist the branch back to the host clone **before disposing** the sandbox, or accumulation
  silently breaks.
- Same-repo specs run **serial**; different-repo specs may run in **parallel**. Spec **order
  is fixed at approval**.
- **Known v1 limitation (accepted):** if building spec N reveals an earlier spec was wrong,
  no magic-rewind — the harness **detects and flags the cascade** and re-runs downstream
  specs from the corrected story-branch HEAD.

### CI / "green"
- **TDD inner loop:** tests start **red → green** per spec.
- **Per-spec green = local full suite** in the sandbox (full suite, no regressions),
  **baselining pre-existing reds** so the agent is only accountable for new failures.
- **Escalation:** local green per spec during build → **single push at story end** → PR →
  **real CI = final gate**.

### Branch / merge
- **Replay is a pre-merge gate** (v1.5). Unverified pipeline code never reaches main.
- Spec branches → per-repo **story branch** (local, accumulating). Story branches stay local
  until the end-of-story push. Then PR(s) created.

### PR
- Harness automates push + **PR creation**, **one per repo**, fully linked: specs, AC mapping,
  test results, what changed and why — maximum reviewer context. **Stops there.** Never merges.

### Jira coordination (write-back)
- **Projection, not source of truth.** Content is one-way (git → canonical; harness → Jira for
  status/comments). Jira edits do **not** mutate specs.
- **Never on the critical path** — best-effort, degrades to a warning; never blocks the build.
- **Configurable status map** per project (standardising workflow across teams; "In Progress"
  on pickup, ~"Ready for QA" on dev-complete+merged — *not* Done).
- Each spec = a **subtask** on the story (idempotent — subtask ID stored in spec frontmatter;
  reused on restart, never duplicated). On spec completion, subtask closed with a comment:
  what happened, story status, test results.
- On story dev-complete + merged → move ticket to the appropriate (post-dev) status.
- **Dev's own Jira identity / token**, never a shared/bot token.
- Board culture fine (teams work at story level).
- **ID-stamping:** task + story IDs in **commit messages**; story ID in **PR titles**.

---

## Drafting vs execution (the compute boundary)

A spec moves through two phases with very different needs. **Same tool (kiro), two
invocation modes — sandbox only at execution.**

| | **Draft mode** | **Execute mode** |
|---|---|---|
| What it does | reads ticket + code, writes/revises **markdown specs** | builds code, runs tests, mutates files |
| Sandbox | **none** | **Sand Castle** Docker sandbox |
| Repo access | **read-only** | read-write |
| Output | spec markdown | code + commits |
| Lifetime | re-invoked per edit (cheap) | one sandbox **per spec run**, disposed after |
| When | up to approval | only *after* approval |

- The executor port exposes `draft(...)` (kiro, no sandbox, RO) and `execute(...)`
  (kiro, sandboxed, RW). **No sandbox is spun up for spec edits** — only for execution.
- **Drafting reuses headless kiro** (not metered Claude-API), for cost. Confirm kiro's
  economics are flat/seat-based and won't hit usage/rate caps under chatty review loops.
- **Continuity lives in the harness, not kiro's memory.** Headless kiro is one-shot per
  call; on each edit the harness re-assembles the prompt = ticket + current specs + full
  feedback history + new comment → one kiro call → revised specs → diff. Same
  "generate prompt file → pass to kiro" pattern used for execution.
- **Guardrail:** in draft mode, point kiro at a **read-only** source mount + a writable
  specs dir, and capture only the spec markdown — kiro must not mutate source.
- **Multi-repo drafting:** lay declared repos side-by-side under one parent dir (RO),
  run kiro at the parent so it sees all context in one call.
- Keep prompts lean by letting kiro **explore the RO checkout** rather than stuffing whole
  files into the prompt each round.

---

## Spec feedback / review loop

**Modelled on PR review** — reuse devs' existing muscle memory. Agent = author,
dev = reviewer, revisions shown as **diffs**.

- **Three granularities, surfaced in this order:**
  1. **Fan-out / the set** — split/merge/reorder specs, change which is the replay spec,
     fix repo-boundary violations. Highest-leverage; review the decomposition *first*.
  2. **The spec** — feedback on a whole spec.
  3. **The section** — inline on AC restatement / test plan / approach / expected-diff.
- **Conversational-first** (primary): NL feedback → agent revises **all affected parts to
  stay internally consistent** (change AC → also updates test plan + fan-out) → re-presents
  a diff. **Direct markdown edit** is an escape hatch; on a hand-edit the agent **re-reads
  and flags inconsistencies** ("AC changed, test plan still asserts old shape — reconcile?")
  without silently overriding the human.
- **Loop:** draft → feedback → revise (diff) → … → **explicit approval**. Nothing executes
  until approved.
- **Persist the review thread** with the spec (git/sidecar) — explains *why* the spec is
  shaped this way and becomes context the executor prompt can see.
- **Approve the whole story's spec set as a unit** in v1 (order is fixed at approval; later
  specs depend on earlier — partial approval tangles the dependency story).
- **No spec-review chatter to Jira** — only the outcome (approved specs → subtasks) hits
  the board.

---

## Code feedback model

**Never mid-build** (agents take no steering during execution — async, fail-on-ambiguity,
never block). Code feedback happens at two checkpoints: the **per-spec boundary** (after
green, before the next stacks on it — catches cascades early) and the **PR** (with peer
review).

**Three mechanisms, in priority order:**
1. **Behavioural → express as a test** (TDD-native default, encouraged). Failing test pins
   the wanted behaviour; agent makes it green. Durable, regression-proof.
2. **Quality/structural → NL change-request, iterated in place** ("use the existing helper,"
   "too complex," "extract this"). Agent revises existing code on the branch, suite must
   stay green. **Direct edit always allowed** — it's the dev's branch; human commits flow
   forward via story-branch seeding and the agent must never clobber them.
3. **"Code revealed the spec was wrong" → amend spec, re-run clean** (+ flag cascade).

**Tension resolved:** in-place iteration (#2) is *not* the banned "resume." The no-resume
rule governs **the agent guessing on ambiguity mid-build**; code-review feedback is
**deliberate, human-directed refinement of completed, green code** — different situation,
in-place is fine.

### `review-required` flag (per spec)
- Boolean per spec. When set, execution **stops after the spec goes green** and waits for
  the dev's review + feedback before the next spec runs. Unflagged specs flow through.
- **Default ON for all replay specs.** Dev opts-in any others.
- Set at the **pre-flight stage**: specs drafted → content approved → **mark
  `review-required` flags** → execution begins. Last gate before anything runs.
- **Agent recommends** `review-required = on` for specs it judges to touch performance-
  critical or concurrent code; dev confirms — so a hot-path edit can't slip through as
  flow-through just because the dev forgot to flag it.

### Non-functional requirements (perf / thread-safety)
Tests verify *logic correctness*, **not** efficiency, thread-safety, allocation behaviour,
or lock correctness — critical on this perf-sensitive system. So:
- The **`review-required` stop does double duty** — it's the primary place a human verifies
  the non-functional properties tests can't.
- **Encode perf + concurrency directives into the methodology prompt** (not just
  "test-first"): hot-path/allocation/locking/thread-safety expectations, and require the
  agent to **flag its own non-functional assumptions** for the reviewer.
- **Add automated non-functional checks where cheap:** race/thread sanitizers (e.g. Go
  `-race`, TSan), concurrency linters, **perf-budget/benchmark tests** that fail on
  regression. Partial, but catch the obvious before a human looks. Decide which are
  v1-cheap (race detector often near-free) vs later (perf-budget harness).

---

## Metrics & analytics

**Purpose: improvement only.** Metrics grade the **agent's quality** and measure adoption to
drive **prompt/methodology improvement** — *never* developer ranking or surveillance.
Aggregate by spec / stage / repo / ticket-quality; per-dev data, if shown at all, is for that
dev's own eyes only.

- **Sink: Datadog**, centralised. Emission is **best-effort, non-blocking, off the critical
  path** (same discipline as Jira write-back). **Emit from day one** even if dashboards lag —
  adoption history can't be backfilled.
- **Capture is near-free** — derived from already-instrumented feedback loops (persisted
  review threads, diffs, flags) + lifecycle events.

**Core signal — "how often the dev must correct the agent":**
- **Spec level:** first-pass spec acceptance (% approved zero-edit) · feedback rounds to
  approval · draft→approved diff magnitude · correction type (fan-out / AC / test-plan /
  approach).
- **Code level:** % `review-required` stops that needed changes · code-review iterations ·
  direct-edit lines vs agent lines · correction type (behavioural-test / quality /
  spec-was-wrong-rerun).
- **Kickback signals:** ambiguity-fail rate · `needs-info` rate · cascade rate · restarts
  per spec.

**Adoption:** active devs (W/MAU) · tickets / specs / stories / PRs over time · funnel
(selected → approved → executed → PR'd → merged) and where devs drop out.

**Outcome / value:** ticket→PR cycle time · human touch-time vs walk-away time · PR
peer-review change-request rate · first-time CI pass at the PR gate · QA bounce-back rate
(if linkable via Jira).

**The payoff — closes the loop on the methodology prompt:** a high correction rate in one
area is the signal to improve *that* part of the prompt/standards (fan-out corrected often →
fix the drafting prompt; `review-required` keeps catching perf → strengthen the concurrency
directives).

---

## Scope split

### v1
Electron app · pull Jira (assigned tickets) · select ticket + declare repos · agent drafts
single-repo specs in **draft mode** (kiro, RO, no sandbox; questions up front, test-first,
AC restated + ratified, one flagged as the story's replay spec) · **PR-review-style spec
feedback loop** (conversational-first + edit hatch; approve set as a unit) · **pre-flight
`review-required` flags** (default-on replay) · run specs one-by-one in **execute mode**
(kiro in Sand Castle sandboxes seeded from story-branch HEAD) · TDD red→green · per-spec
local full-suite green with baselined reds · `review-required` specs **stop for code review**
(test-first / NL-iterate / direct-edit feedback) · ambiguity = fail + restart · specs
accumulate on per-repo story branch · single push at story end · PR(s) created and fully
linked, never auto-merged · Jira write-back (status, subtasks, completion comments,
ID-stamped commits/PRs) · `needs-info` escape hatch · methodology prompt carries perf +
concurrency directives · cheap automated non-functional checks (e.g. race detector) where
near-free.
**Human manually deploys + triggers replay + verifies outside the app for now.**

### v1.5
Auto-trigger replay (needs env port + ephemeral envs) · baseline replay at story start (tagged) ·
**"areas to investigate"** guide (prose pointers from expected-change hypothesis + code diff;
**no** written queries, **no** execution — engineers drive Athena themselves).

### Later
Agent-suggested **concrete Athena queries** → optional **auto-execution** with cost guards
(needs the parked schema/partition items solved).

---

## Parked follow-ups (need confirmation)

1. Is replay output registered in **Glue** with a real schema, or schemaless files needing DDL?
2. Do **code field-names survive to output column-names**, or does the pipeline transform them?
3. Is the **replay label / id a partition key** (cheap to isolate) or just a column
   (full-lake scan → ruinous Athena cost)? — biggest one.
4. Query suggestion → auto-exec with cost guards (depends on 1–3).
5. **Ephemeral-env API readiness** — v1.5 blocker. Today: replay API exists but only against
   **shared, long-lived** environments. Track the platform team's timeline; this harness is
   also a forcing function / business case for that work.
6. **Confirm kiro economics** — flat/seat-based, not metered underneath; won't hit usage/rate
   caps under chatty drafting + review loops.
7. **Which automated non-functional checks land in v1** vs later — race/thread sanitizers and
   concurrency linters (likely cheap) vs a perf-budget/benchmark harness (likely later).

---

## Why a custom harness is justified (the thesis)

Ordinary CI would suffice if per-spec tests fully validated pipeline output — they don't.
The differentiated value is the **differential, baseline-compared, real-data replay** plus the
**encoded team workflow** (Jira → restated-AC spec → approval → test-first build → per-spec green →
story-level replay gate → fully-linked PR → coordinated merge → Jira coordination). The harness
encapsulates that loop; the replay + ephemeral-env integration is the moat.

---

## Next steps

1. **(Ian)** Create the GitHub repo to house this project.
2. Write the **v1 PRD** (scope, port architecture, workflow state machine, v1/v1.5/later split,
   parked follow-ups) — use the `to-prd` skill, then `to-issues` to break it down.
3. Confirm the 5 parked follow-ups (esp. #3, the partition key) with the data/platform team.
