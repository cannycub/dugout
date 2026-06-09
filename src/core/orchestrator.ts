import type { Story, Spec, SpecContent, StorySpecs, StoryRunState, Preflight } from "./domain.js";
import type { ExecutorPort, ClarifyingQuestion, ClarificationRound } from "./ports/executor.js";
import { assertNever } from "./exhaustive.js";
import type { JiraPort, Ticket } from "./ports/jira.js";
import type { GitHubPort, PullRequest } from "./ports/github.js";
import type { MetricsPort, MetricEvent } from "./ports/metrics.js";
import type { EnvReplayPort } from "./ports/env-replay.js";
import type { DeclaredRepo, RepoScope, RepoMatch } from "./repo-scope.js";
import type { RunStateStore } from "./store/run-state-store.js";
import type { SpecStore } from "./store/spec-store.js";
import { InMemoryRunStateStore } from "./store/in-memory-run-state-store.js";
import { InMemorySpecStore } from "./store/in-memory-spec-store.js";

/**
 * Outcome of drafting a story (ADR-0007), surfaced to the caller (IPC/renderer). Mirrors the
 * executor's {@link DraftOutcome}: only `drafted` yields a {@link Story}; the two stop outcomes
 * carry the agent's reason/questions straight through. The deeper kickback lifecycle (Jira label,
 * the answer→re-draft loop) is deferred — nothing is persisted for a stop outcome.
 */
export type DraftStoryResult =
  | { outcome: "drafted"; story: Story }
  | { outcome: "needs-info"; reason: string }
  | { outcome: "needs-clarification"; questions: ClarifyingQuestion[] };

/** The five ports orchestration depends on (CONTEXT.md). Adapters swap; orchestration does not. */
export interface OrchestratorDeps {
  jira: JiraPort;
  executor: ExecutorPort;
  github: GitHubPort;
  metrics: MetricsPort;
  envReplay: EnvReplayPort;
  /** Canonical spec content (git); defaults to in-memory. */
  specStore?: SpecStore;
  /** Ephemeral run-state (SQLite); defaults to in-memory. */
  store?: RunStateStore;
  /** Catalog + clone discovery for the declare-repos step (Part A). Optional in tests. */
  repoScope?: RepoScope;
  /**
   * Resolve the base branch a spec's sandbox seeds (forks) from: the story branch
   * `story/<storyKey>` if it exists in the repo's clone, else the repo default (ADR-0013). The host
   * injects the real resolver (GitWorkspace-backed); absent ⇒ a benign `"main"` default for the
   * fake-executor unit path, where the value is unused.
   */
  resolveBaseBranch?: (repo: string, storyKey: string) => Promise<string>;
  /**
   * Merge a green spec's branch into the per-repo story branch, locally (ADR-0014). The host injects
   * the real GitWorkspace-backed merge (create `story/<key>` from the default if absent, then
   * `git merge --no-ff spec/<key>/<specId>`); absent ⇒ a no-op for the fake-executor unit path, where
   * there is no clone on disk. A throw is an operational error the orchestrator unwinds to a
   * restartable `failed` state — never a spec grade (ADR-0011 §4, ADR-0014).
   */
  mergeToStoryBranch?: (repo: string, storyKey: string, specId: string) => Promise<void>;
}

/**
 * Drives the spec/story lifecycle. The developer is the head coach — every gate is theirs;
 * the orchestrator only moves state in response to their decisions and the ports' results.
 *
 * Persistence is split: the spec contract goes to the SpecStore (canonical-in-git), the
 * lifecycle position to the RunStateStore (ephemeral SQLite). A {@link Story} is assembled from
 * both whenever one is read.
 */
export class Orchestrator {
  private readonly specStore: SpecStore;
  private readonly runState: RunStateStore;

  constructor(private readonly deps: OrchestratorDeps) {
    this.specStore = deps.specStore ?? new InMemorySpecStore();
    this.runState = deps.store ?? new InMemoryRunStateStore();
  }

  listAssignedTickets(): Promise<Ticket[]> {
    return this.deps.jira.listAssignedTickets();
  }

  /** Search the catalog for repos to declare; each match carries its local clone binding. */
  async searchRepos(query: string): Promise<RepoMatch[]> {
    return this.requireRepoScope().search(query);
  }

  /** Bind chosen catalog names to local clones for a story (CONTEXT.md "Declared repo"). */
  async declareRepos(names: string[]): Promise<DeclaredRepo[]> {
    return this.requireRepoScope().declare(names);
  }

  /** Re-scan workspace roots so newly-cloned repos bind (the dev clones mid-flight). */
  async rescanRepos(): Promise<void> {
    return this.requireRepoScope().rescan();
  }

  /** The developer's configured workspace roots (for display). */
  async listWorkspaceRoots(): Promise<string[]> {
    return this.requireRepoScope().roots();
  }

  private requireRepoScope(): RepoScope {
    if (!this.deps.repoScope) throw new Error("repo scope not configured");
    return this.deps.repoScope;
  }

  /** Assembled snapshot of an active story (contract + run-state), if one exists. */
  getStory(storyKey: string): Story | undefined {
    const content = this.specStore.get(storyKey);
    const run = this.runState.get(storyKey);
    if (!content || !run) return undefined;
    return assemble(content, run);
  }

  /**
   * Draft the fan-out for a selected ticket (read-only, no sandbox). Returns a discriminated
   * {@link DraftStoryResult}: a `drafted` story, or one of the two "stop, don't guess" outcomes
   * the agent can return (ADR-0007, invariant 1). Only `drafted` persists anything.
   */
  async draftStory(
    ticketKey: string,
    opts: { repos: DeclaredRepo[]; clarifications?: ClarificationRound[] },
  ): Promise<DraftStoryResult> {
    const tickets = await this.deps.jira.listAssignedTickets();
    const ticket = tickets.find((t) => t.key === ticketKey);
    if (!ticket) {
      throw new Error(`Ticket ${ticketKey} is not assigned to this developer`);
    }

    const outcome = await this.deps.executor.draft({
      ticket,
      repos: opts.repos,
      ...(opts.clarifications ? { clarifications: opts.clarifications } : {}),
    });

    switch (outcome.result) {
      case "needs-info":
        // Terminal kickback: the ticket is too thin to spec. Nothing drafted, nothing persisted —
        // the developer enriches the ticket out of band (deeper lifecycle is a follow-up).
        return { outcome: "needs-info", reason: outcome.reason };

      case "needs-clarification":
        // The agent can spec but needs answers first; surface the questions for a re-draft.
        return { outcome: "needs-clarification", questions: outcome.questions };

      case "drafted": {
        // The fan-out invariant (ADR-0006): every drafted spec must target a declared repo. A spec
        // for an undeclared repo would have no clone binding at execute time — reject it now.
        const declaredNames = new Set(opts.repos.map((r) => r.identity.name));
        for (const drafted of outcome.specs) {
          if (!declaredNames.has(drafted.repo)) {
            throw new Error(
              `Drafted spec targets undeclared repo "${drafted.repo}" (declared: ${[...declaredNames].join(", ") || "none"})`,
            );
          }
        }

        const specs: Spec[] = outcome.specs.map((drafted, order) => ({
          id: `${ticket.key}-spec-${order + 1}`,
          repo: drafted.repo,
          markdown: drafted.markdown,
          status: "drafted",
          isReplaySpec: false, // the developer designates replay specs at the gate (ADR-0008)
          reviewRequired: false, // finalized at pre-flight (approveStory)
          order,
        }));

        const story: Story = {
          key: ticket.key,
          title: ticket.title,
          status: "drafted",
          specs,
          declaredRepos: opts.repos.map((r) => r.identity.name),
        };
        this.persistContent(story);
        this.persistRun(story);
        return { outcome: "drafted", story };
      }

      default:
        return assertNever(outcome, "draftStory: unhandled draft outcome");
    }
  }

  /**
   * Approve the drafted spec set as a unit (CONTEXT.md: the fixed order and dependencies stay
   * coherent). The pre-flight choices finalize each spec's contract before any execution.
   */
  async approveStory(storyKey: string, preflight: Preflight): Promise<Story> {
    const story = this.requireStory(storyKey);
    if (story.status !== "drafted") {
      throw new Error(`Story ${storyKey} is ${story.status}, cannot approve (expected drafted)`);
    }

    const markedReplay = new Set(preflight.replaySpecs ?? []);
    const markedReviewRequired = new Set(preflight.reviewRequired ?? []);
    for (const spec of story.specs) {
      // The developer designates replay specs at the gate (ADR-0008); they default review-required,
      // and the developer may mark additional specs review-required on top.
      spec.isReplaySpec = markedReplay.has(spec.id);
      spec.reviewRequired = spec.isReplaySpec || markedReviewRequired.has(spec.id);
      spec.status = "approved";
    }
    story.status = "approved";
    // The approved plan (replay + reviewRequired) is part of the canonical contract — persist it too.
    this.persistContent(story);
    this.persistRun(story);
    return story;
  }

  /**
   * Run the approved specs one-by-one in fixed order. Each spec executes in a sandbox seeded
   * from the per-repo story-branch HEAD; on green its branch auto-merges into the local story
   * branch and the next spec stacks on it. The story is dev-complete once every spec is merged.
   */
  async runStory(storyKey: string): Promise<Story> {
    const story = this.requireStory(storyKey);
    if (story.status !== "approved") {
      throw new Error(`Story ${storyKey} is ${story.status}, cannot run (expected approved)`);
    }
    story.status = "executing";
    this.persistRun(story);
    return this.advanceFrom(story, 0);
  }

  /**
   * Resume after a `review-required` stop. The reviewed spec was already merged into the story
   * branch when it went green (ADR-0014), so resume simply continues from the next un-run spec —
   * which seeds from the now-reviewed (and possibly dev-amended) story HEAD. Deliberate,
   * human-directed continuation is not the banned "resume" of a failed build (invariant 1).
   */
  async resumeAfterReview(storyKey: string): Promise<Story> {
    const story = this.requireStory(storyKey);
    if (story.status !== "awaiting-review") {
      throw new Error(
        `Story ${storyKey} is ${story.status}, cannot resume (expected awaiting-review)`,
      );
    }
    // The reviewed spec is already merged; continue from the next un-run spec. If none remain (the
    // review-required spec was the last — e.g. a single replay spec), advancing past the end lets
    // advanceFrom's tail complete the story to dev-complete rather than wedging in awaiting-review.
    const next = story.specs.findIndex((s) => s.status === "approved");
    story.status = "executing";
    this.persistRun(story);
    return this.advanceFrom(story, next === -1 ? story.specs.length : next);
  }

  /**
   * Clean-restart a failed story: re-run from the failed spec on a fresh branch seeded from the
   * story-branch HEAD. Already-merged specs stay merged; the failed spec and any after it reset
   * to `approved` and re-execute from scratch. This is a restart, not a resume (invariant 1).
   */
  async restartStory(storyKey: string): Promise<Story> {
    const story = this.requireStory(storyKey);
    if (story.status !== "failed") {
      throw new Error(`Story ${storyKey} is ${story.status}, cannot restart (expected failed)`);
    }
    const failedIndex = story.specs.findIndex((s) => s.status === "failed");
    if (failedIndex === -1) {
      throw new Error(`Story ${storyKey} has no failed spec to restart`);
    }
    for (let i = failedIndex; i < story.specs.length; i++) {
      story.specs[i]!.status = "approved";
    }
    story.status = "executing";
    this.persistRun(story);
    return this.advanceFrom(story, failedIndex);
  }

  /**
   * Push each repo's story branch once and open a fully-linked PR per repo. Never auto-merged —
   * peer review and the merge decision stay with humans (invariant 5).
   */
  async createPullRequests(storyKey: string): Promise<PullRequest[]> {
    const story = this.requireStory(storyKey);
    if (story.status !== "dev-complete") {
      throw new Error(
        `Story ${storyKey} is ${story.status}, cannot open PRs (expected dev-complete)`,
      );
    }

    const repos = [...new Set(story.specs.map((s) => s.repo))];
    const prs: PullRequest[] = [];
    for (const repo of repos) {
      // The pushed head is the per-repo story branch the green spec branches accumulated onto
      // (`story/<key>`, ADR-0013/0014) — the branch `merge()` actually built, not the legacy name.
      const head = `story/${story.key}`;
      await this.deps.github.push({ repo, branch: head });
      const repoSpecs = story.specs.filter((s) => s.repo === repo);
      const pr = await this.deps.github.createPullRequest({
        repo,
        storyKey: story.key,
        title: `[${story.key}] ${story.title}`,
        body: prBody(story, repoSpecs),
        head,
      });
      prs.push(pr);
    }

    story.status = "pr-created";
    this.persistRun(story);
    this.emitMetric({ name: "story.pr_created", tags: { story: story.key, prs: prs.length } });
    return prs;
  }

  /** Run specs from `startIndex` in fixed order, stopping at a review-required green spec. */
  private async advanceFrom(story: Story, startIndex: number): Promise<Story> {
    for (let i = startIndex; i < story.specs.length; i++) {
      const spec = story.specs[i]!;
      spec.status = "running";
      this.persistRun(story);
      let outcome;
      try {
        // The orchestrator resolves the seed base (story HEAD if it exists, else repo default) and
        // hands the adapter only a key + a base — the adapter owns the spec-branch name (ADR-0013).
        const baseBranch = await (this.deps.resolveBaseBranch?.(spec.repo, story.key) ??
          Promise.resolve("main"));
        outcome = await this.deps.executor.execute({
          specId: spec.id,
          repo: spec.repo,
          markdown: spec.markdown,
          storyKey: story.key,
          baseBranch,
        });
      } catch (err) {
        // Operational failure (missing clone, Docker down, kiro crash) — NOT a spec grade (ADR-0011
        // §4). Don't leave the spec `running` / story `executing` (a wedged, unhandled rejection
        // mid-loop): unwind to a restartable `failed` state, then rethrow so the developer sees the
        // environment cause and recovers by fixing it and re-running (ADR-0013).
        this.failOperational(story, spec, err);
      }
      if (outcome.result !== "green") {
        // Mid-build ambiguity: fail the spec and the story; the dev re-clarifies and restarts
        // clean (the agent never guesses, never stacks downstream work — invariant 1).
        spec.status = "failed";
        story.status = "failed";
        this.persistRun(story);
        return story;
      }
      spec.status = "green";
      // Merge at green, uniformly (ADR-0014): the spec lands on the story branch the instant it is
      // green, before any stop or dev commit can move story HEAD — so the merge always fast-forwards
      // and review-required becomes a pause AFTER the merge, not a gate on it.
      try {
        await this.merge(story, spec);
      } catch (err) {
        // A merge failure is operational (out-of-band git), not a spec grade (ADR-0014): the spec
        // already graded green. Unwind out of the green/executing limbo to a restartable `failed`
        // and rethrow so the developer sees the cause — same contract as an execute() throw.
        this.failOperational(story, spec, err);
      }
      if (spec.reviewRequired) {
        // Pause for the developer's review of the now-integrated spec before the next spec runs.
        story.status = "awaiting-review";
        this.persistRun(story);
        return story;
      }
    }

    story.status = "dev-complete";
    this.persistRun(story);
    return story;
  }

  /**
   * Auto-merge a green spec's branch into the local per-repo story branch (ADR-0014). The git
   * mechanic is the injected dep; a throw is an operational error (out-of-band git), surfaced to the
   * caller to unwind — never a spec grade. On success the spec rests at `merged`.
   */
  private async merge(story: Story, spec: Spec): Promise<void> {
    await this.deps.mergeToStoryBranch?.(spec.repo, story.key, spec.id);
    spec.status = "merged";
    this.persistRun(story);
    this.emitMetric({ name: "spec.merged", tags: { story: story.key, repo: spec.repo } });
  }

  /**
   * Unwind a spec+story out of the `running`/`green`/`executing` limbo to a restartable `failed`
   * state after an operational failure (execute or merge throw — ADR-0011 §4, ADR-0014), then
   * rethrow so the caller sees the cause. NOT a spec grade: the agent's outcome is untouched.
   */
  private failOperational(story: Story, spec: Spec, err: unknown): never {
    spec.status = "failed";
    story.status = "failed";
    this.persistRun(story);
    throw err;
  }

  /** Emit a metric best-effort: a side-effect failure degrades to a warning, never the build. */
  private emitMetric(event: MetricEvent): void {
    try {
      this.deps.metrics.emit(event);
    } catch (err) {
      console.warn(`[dugout] metrics emit failed (non-blocking): ${String(err)}`);
    }
  }

  /** Assemble a story from its canonical contract + run-state, or throw if either is missing. */
  private requireStory(storyKey: string): Story {
    const story = this.getStory(storyKey);
    if (!story) {
      throw new Error(`No active story for ${storyKey}`);
    }
    return story;
  }

  /** Write the canonical contract (markdown + approved plan) to the SpecStore. */
  private persistContent(story: Story): void {
    const specs: SpecContent[] = story.specs.map((s) => ({
      id: s.id,
      repo: s.repo,
      markdown: s.markdown,
      isReplaySpec: s.isReplaySpec,
      reviewRequired: s.reviewRequired,
      order: s.order,
    }));
    const content: StorySpecs = { key: story.key, title: story.title, specs };
    this.specStore.putStory(content);
  }

  /** Write the lifecycle position (story + per-spec status) to the RunStateStore. */
  private persistRun(story: Story): void {
    const state: StoryRunState = {
      key: story.key,
      title: story.title,
      status: story.status,
      specs: story.specs.map((s) => ({ specId: s.id, status: s.status })),
      declaredRepos: story.declaredRepos,
    };
    this.runState.save(state);
  }
}

/** Merge the canonical contract with run-state into the assembled view. */
function assemble(content: StorySpecs, run: StoryRunState): Story {
  const statusById = new Map(run.specs.map((s) => [s.specId, s.status]));
  const specs: Spec[] = content.specs
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((c) => ({ ...c, status: statusById.get(c.id) ?? "drafted" }));
  return { key: content.key, title: run.title, status: run.status, specs, declaredRepos: run.declaredRepos };
}

/** Fully-linked PR body: story id + the specs (and their AC) that landed in this repo. */
function prBody(story: Story, repoSpecs: Spec[]): string {
  const specList = repoSpecs
    .map((s) => `- \`${s.id}\`${s.isReplaySpec ? " (replay spec)" : ""}`)
    .join("\n");
  return [`Story: ${story.key} — ${story.title}`, "", "Specs in this PR:", specList].join("\n");
}
