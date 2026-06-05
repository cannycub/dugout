import type { Story, Spec, SpecContent, StorySpecs, StoryRunState, Preflight } from "./domain.js";
import type { ExecutorPort } from "./ports/executor.js";
import type { JiraPort, Ticket } from "./ports/jira.js";
import type { GitHubPort, PullRequest } from "./ports/github.js";
import type { MetricsPort, MetricEvent } from "./ports/metrics.js";
import type { EnvReplayPort } from "./ports/env-replay.js";
import type { DeclaredRepo, RepoScope, RepoMatch } from "./repo-scope.js";
import type { RunStateStore } from "./store/run-state-store.js";
import type { SpecStore } from "./store/spec-store.js";
import { InMemoryRunStateStore } from "./store/in-memory-run-state-store.js";
import { InMemorySpecStore } from "./store/in-memory-spec-store.js";

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

  /** Draft the fan-out for a selected ticket (read-only, no sandbox). */
  async draftStory(ticketKey: string, opts: { repos: DeclaredRepo[] }): Promise<Story> {
    const tickets = await this.deps.jira.listAssignedTickets();
    const ticket = tickets.find((t) => t.key === ticketKey);
    if (!ticket) {
      throw new Error(`Ticket ${ticketKey} is not assigned to this developer`);
    }

    const result = await this.deps.executor.draft({ ticket, repos: opts.repos });

    // The fan-out invariant (ADR-0006): every drafted spec must target a declared repo. A spec
    // for an undeclared repo would have no clone binding at execute time — reject it now.
    const declaredNames = new Set(opts.repos.map((r) => r.identity.name));
    for (const drafted of result.specs) {
      if (!declaredNames.has(drafted.repo)) {
        throw new Error(
          `Drafted spec targets undeclared repo "${drafted.repo}" (declared: ${[...declaredNames].join(", ") || "none"})`,
        );
      }
    }

    const specs: Spec[] = result.specs.map((drafted, order) => ({
      id: `${ticket.key}-spec-${order + 1}`,
      repo: drafted.repo,
      markdown: drafted.markdown,
      status: "drafted",
      isReplaySpec: drafted.isReplaySpec ?? false,
      reviewRequired: false, // finalized at pre-flight (approveStory)
      order,
    }));

    const story: Story = { key: ticket.key, title: ticket.title, status: "drafted", specs };
    this.persistContent(story);
    this.persistRun(story);
    return story;
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

    const markedReviewRequired = new Set(preflight.reviewRequired ?? []);
    for (const spec of story.specs) {
      // Replay specs default on; the developer may mark additional specs at pre-flight.
      spec.reviewRequired = spec.isReplaySpec || markedReviewRequired.has(spec.id);
      spec.status = "approved";
    }
    story.status = "approved";
    // The approved plan (reviewRequired) is part of the canonical contract — persist content too.
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
   * Resume after a `review-required` stop: the reviewed (green) spec merges into the story
   * branch and execution continues with the next spec. Deliberate, human-directed continuation
   * is not the banned "resume" of a failed build (invariant 1).
   */
  async resumeAfterReview(storyKey: string): Promise<Story> {
    const story = this.requireStory(storyKey);
    if (story.status !== "awaiting-review") {
      throw new Error(
        `Story ${storyKey} is ${story.status}, cannot resume (expected awaiting-review)`,
      );
    }
    const pausedIndex = story.specs.findIndex((s) => s.status === "green");
    const paused = story.specs[pausedIndex];
    if (!paused) {
      throw new Error(`Story ${storyKey} has no spec awaiting review`);
    }
    this.merge(story, paused);
    story.status = "executing";
    this.persistRun(story);
    return this.advanceFrom(story, pausedIndex + 1);
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
      const head = `dugout/${story.key}/${repo}`;
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
      const outcome = await this.deps.executor.execute({
        specId: spec.id,
        repo: spec.repo,
        markdown: spec.markdown,
        storyBranch: `dugout/${story.key}/${spec.repo}`,
      });
      if (outcome.result !== "green") {
        // Mid-build ambiguity: fail the spec and the story; the dev re-clarifies and restarts
        // clean (the agent never guesses, never stacks downstream work — invariant 1).
        spec.status = "failed";
        story.status = "failed";
        this.persistRun(story);
        return story;
      }
      spec.status = "green";
      if (spec.reviewRequired) {
        // Stop for the developer's code review before the next spec stacks on this one.
        story.status = "awaiting-review";
        this.persistRun(story);
        return story;
      }
      this.merge(story, spec);
    }

    story.status = "dev-complete";
    this.persistRun(story);
    return story;
  }

  /** Auto-merge a green spec's branch into the local story branch. */
  private merge(story: Story, spec: Spec): void {
    spec.status = "merged";
    this.persistRun(story);
    this.emitMetric({ name: "spec.merged", tags: { story: story.key, repo: spec.repo } });
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
  return { key: content.key, title: run.title, status: run.status, specs };
}

/** Fully-linked PR body: story id + the specs (and their AC) that landed in this repo. */
function prBody(story: Story, repoSpecs: Spec[]): string {
  const specList = repoSpecs
    .map((s) => `- \`${s.id}\`${s.isReplaySpec ? " (replay spec)" : ""}`)
    .join("\n");
  return [`Story: ${story.key} — ${story.title}`, "", "Specs in this PR:", specList].join("\n");
}
