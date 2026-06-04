/**
 * Dugout domain model. Vocabulary follows CONTEXT.md exactly.
 *
 * A {@link Story} is a Jira ticket the developer picks up; it decomposes into one or more
 * single-repo specs (the fan-out).
 *
 * Persistence is split along a hard line (CONTEXT.md invariant 4):
 *  - {@link SpecContent} is the canonical *contract* — markdown + the approved plan. It lives
 *    as markdown in git (the SpecStore seam).
 *  - {@link SpecStatus}/{@link StoryStatus} are *run-state* — the ephemeral, rebuildable
 *    lifecycle position. It lives in SQLite (the RunStateStore).
 * A {@link Spec}/{@link Story} is the assembled view the orchestrator hands callers and the UI.
 */

/** Lifecycle of a single spec as it moves through the harness. */
export type SpecStatus =
  | "drafted" // markdown drafted, under review
  | "approved" // part of an approved-as-a-unit set, ready to run
  | "running" // executing in a sandbox
  | "green" // passed (full suite, pre-existing reds baselined), not yet merged
  | "merged" // green branch auto-merged into the local story branch
  | "failed"; // mid-build ambiguity → fail + clean restart (invariant 1)

/** Lifecycle of a story (the fan-out as a whole). */
export type StoryStatus =
  | "drafted" // specs drafted, under review
  | "approved" // spec set approved as a unit
  | "executing" // running specs one-by-one in fixed order
  | "awaiting-review" // paused after a review-required spec went green
  | "dev-complete" // all specs merged into story branches; ready to push + open PRs
  | "pr-created" // fully-linked PR(s) opened (never auto-merged)
  | "failed"; // a spec hit mid-build ambiguity; awaits a clean restart (invariant 1)

/** Pre-flight choices the developer makes when approving the spec set as a unit. */
export interface Preflight {
  /** Spec ids the developer marks `review-required` (on top of the replay-spec default). */
  reviewRequired?: string[];
}

/**
 * Canonical spec contract — what the draft/approval gates produce. Lives as markdown in git;
 * everything here is durable and rebuildable, never ephemeral run-state.
 */
export interface SpecContent {
  /** Stable id derived from the story key + position in the fan-out. */
  id: string;
  /** The single repo this spec maps to (one spec → one repo → one branch → one PR). */
  repo: string;
  /** Canonical spec content (markdown-in-git model). */
  markdown: string;
  /**
   * A replay spec is verified by a replay (the team's primary testing method) and is
   * default-`review-required`. In v1 the replay itself is triggered manually outside Dugout.
   */
  isReplaySpec: boolean;
  /**
   * When set, execution stops after this spec goes green for the developer's code review
   * before the next spec stacks on it. Finalized at pre-flight (replay specs default on).
   */
  reviewRequired: boolean;
  /** Position in the fixed execution order. */
  order: number;
}

/** The contract for a whole story's fan-out (canonical-in-git). */
export interface StorySpecs {
  key: string;
  title: string;
  specs: SpecContent[];
}

/** Assembled view: a spec's contract plus its current lifecycle status. */
export interface Spec extends SpecContent {
  status: SpecStatus;
}

/** Assembled view of a story: contract + run-state, as handed to callers and the UI. */
export interface Story {
  /** Jira issue key, e.g. "DUG-1". */
  key: string;
  title: string;
  status: StoryStatus;
  /** The fan-out: ordered single-repo specs. */
  specs: Spec[];
}

/** Run-state for one spec: just its lifecycle position (ephemeral, rebuildable). */
export interface SpecRunState {
  specId: string;
  status: SpecStatus;
}

/** Run-state for a story: lifecycle position only. Spec contract lives in the SpecStore. */
export interface StoryRunState {
  key: string;
  title: string;
  status: StoryStatus;
  specs: SpecRunState[];
}
