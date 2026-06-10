import type {
  Story,
  Spec,
  SpecContent,
  StorySpecs,
  StoryRunState,
  Preflight,
  ReviewThreadEntry,
} from "./domain.js";
import type { ExecutorPort, ClarifyingQuestion, ClarificationRound } from "./ports/executor.js";
import { assertNever } from "./exhaustive.js";
import type { JiraPort, Ticket } from "./ports/jira.js";
import type { GitHubPort, PullRequest } from "./ports/github.js";
import type { MetricsPort, MetricEvent } from "./ports/metrics.js";
import type { LifecyclePort, LifecycleEvent } from "./ports/lifecycle.js";
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

/** Code feedback at a review-required stop (#9): behavioural-as-a-test, or quality/structural. */
export interface ReviewFeedback {
  kind: "test" | "quality";
  content: string;
}

/** Spec-review feedback (#5): the developer's note at one of the three granularities. */
export interface DraftFeedback {
  scope: ReviewThreadEntry["scope"];
  content: string;
}

/**
 * Jira write-back configuration (#11): the event→transition map is per-project (workflow names
 * differ across Jira projects), so it is injected, not hardcoded. Presence of the config object
 * enables the projection; every write is best-effort and degrades to a warning (invariant 4/7).
 */
export interface JiraWriteBackConfig {
  transitions?: {
    /** Applied when drafting lands (the developer picked the ticket up). */
    pickup?: string;
    /** Applied when every spec is merged (dev-complete) — e.g. "Ready for QA", never "Done". */
    devComplete?: string;
    /** Applied when the agent kicks the ticket back as needs-info. */
    needsInfo?: string;
  };
}

/** The five ports orchestration depends on (CONTEXT.md). Adapters swap; orchestration does not. */
export interface OrchestratorDeps {
  jira: JiraPort;
  executor: ExecutorPort;
  github: GitHubPort;
  metrics: MetricsPort;
  envReplay: EnvReplayPort;
  /**
   * Story/spec transition stream for the UI (#27). Optional and best-effort: absent ⇒ no emissions;
   * a throwing sink degrades to a warning, never into a transition. Deliberately a separate port
   * from `metrics` — lifecycle reaches the renderer, metrics reach Datadog, never each other.
   */
  lifecycle?: LifecyclePort;
  /** Enables the Jira write-back projection (#11); absent ⇒ no Jira writes at all. */
  jiraWriteBack?: JiraWriteBackConfig;
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
  /** Feedback rounds per story within a review stop (#9) — in-memory; see submitReviewFeedback. */
  private readonly feedbackRounds = new Map<string, number>();

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
        this.emitMetric({ name: "draft.needs_info", tags: { story: ticket.key } });
        await this.jiraBestEffort("needs-info kickback", async () => {
          if (!this.deps.jiraWriteBack) return;
          const needsInfo = this.deps.jiraWriteBack.transitions?.needsInfo;
          if (needsInfo) await this.deps.jira.transitionTicket(ticket.key, needsInfo);
          await this.deps.jira.addComment(
            ticket.key,
            `Dugout: the drafting agent kicked this ticket back as needs-info — ${outcome.reason}`,
          );
        });
        return { outcome: "needs-info", reason: outcome.reason };

      case "needs-clarification":
        // The agent can spec but needs answers first; surface the questions for a re-draft.
        // A clarification round is a near-perfect ticket-quality signal (invariant 9): rounds are
        // 1-based and count this stop, so round N means the Nth set of questions.
        this.emitMetric({
          name: "draft.clarification_round",
          tags: { story: ticket.key, round: (opts.clarifications?.length ?? 0) + 1 },
        });
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
          reviewRecommended: drafted.reviewRecommended ?? false, // agent's call-out; dev confirms (#6)
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
        this.emitStory(story.key, "drafted");
        const rounds = opts.clarifications?.length ?? 0;
        if (rounds > 0) {
          // Rounds-to-converge per ticket: pairs with draft.clarification_round (ticket-quality).
          this.emitMetric({ name: "draft.clarification_converged", tags: { story: story.key, rounds } });
        }
        this.emitMetric({ name: "story.drafted", tags: { story: story.key, specs: specs.length } });
        await this.jiraBestEffort("pickup transition", async () => {
          const pickup = this.deps.jiraWriteBack?.transitions?.pickup;
          if (pickup) await this.deps.jira.transitionTicket(story.key, pickup);
        });
        return { outcome: "drafted", story };
      }

      default:
        return assertNever(outcome, "draftStory: unhandled draft outcome");
    }
  }

  /**
   * One round of the spec review loop (#5): the developer's conversational feedback — at set, spec,
   * or section granularity — drives a consistent re-draft of the whole set (an AC change updates
   * the test plan and fan-out). The agent sees the CURRENT canonical set plus the rendered
   * feedback; a `drafted` outcome replaces the contract (ids regenerate — the fan-out may split or
   * merge); the stop outcomes surface exactly like a first draft. The thread entry persists with
   * the contract either way a draft lands.
   */
  async reviseDraft(storyKey: string, feedback: DraftFeedback): Promise<DraftStoryResult> {
    const story = this.requireStory(storyKey);
    if (story.status !== "drafted") {
      throw new Error(`Story ${storyKey} is ${story.status}, cannot revise (expected drafted)`);
    }
    const content = this.specStore.get(storyKey)!;
    const thread = content.reviewThread ?? [];
    const entry: ReviewThreadEntry = {
      scope: feedback.scope,
      content: feedback.content,
      round: thread.length + 1,
      kind: "feedback",
    };

    // Re-bind the declared repos fresh (clone bindings may have moved since the draft). Without a
    // repo scope (fake-port unit path) fall back to identity-only declarations — the fake executor
    // never reads clones.
    const repos = this.deps.repoScope
      ? await this.declareRepos(story.declaredRepos)
      : story.declaredRepos.map((name) => ({
          identity: { name, remote: "" },
          clone: { status: "not-cloned" as const },
        }));
    const outcome = await this.deps.executor.draft({
      ticket: { key: story.key, title: story.title, description: "" },
      repos,
      revision: {
        specs: story.specs.map((s) => ({ repo: s.repo, markdown: s.markdown })),
        feedback: renderDraftFeedback(entry, thread),
      },
    });
    this.emitMetric({ name: "draft.review_round", tags: { story: story.key, scope: feedback.scope.kind } });

    switch (outcome.result) {
      case "needs-info":
        return { outcome: "needs-info", reason: outcome.reason };
      case "needs-clarification":
        return { outcome: "needs-clarification", questions: outcome.questions };
      case "drafted": {
        const specs: Spec[] = outcome.specs.map((drafted, order) => ({
          id: `${story.key}-spec-${order + 1}`,
          repo: drafted.repo,
          markdown: drafted.markdown,
          status: "drafted",
          isReplaySpec: false,
          reviewRequired: false,
          reviewRecommended: drafted.reviewRecommended ?? false,
          order,
        }));
        const revised: Story = { ...story, specs, reviewThread: [...thread, entry] };
        this.persistContent(revised);
        this.persistRun(revised);
        this.emitStory(revised.key, "drafted");
        return { outcome: "drafted", story: this.requireStory(storyKey) };
      }
      default:
        return assertNever(outcome, "reviseDraft: unhandled draft outcome");
    }
  }

  /**
   * The direct-edit escape hatch (#5): the developer's markdown is applied VERBATIM to the drafted
   * contract — never overridden by the agent — and recorded on the thread, so the next
   * conversational revision sees the edit and is directed to flag (not fix) any inconsistencies it
   * introduced.
   */
  async editSpecDraft(storyKey: string, specId: string, markdown: string): Promise<Story> {
    const story = this.requireStory(storyKey);
    if (story.status !== "drafted") {
      throw new Error(`Story ${storyKey} is ${story.status}, cannot edit the draft (expected drafted)`);
    }
    const spec = story.specs.find((s) => s.id === specId);
    if (!spec) throw new Error(`Story ${storyKey} has no spec ${specId}`);
    spec.markdown = markdown;
    const thread = this.specStore.get(storyKey)!.reviewThread ?? [];
    const entry: ReviewThreadEntry = {
      scope: { kind: "spec", specId },
      content: "The developer directly edited this spec's markdown.",
      round: thread.length + 1,
      kind: "direct-edit",
    };
    this.persistContent({ ...story, reviewThread: [...thread, entry] });
    return this.requireStory(storyKey);
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
    this.emitStory(story.key, "approved");
    this.emitMetric({
      name: "story.approved",
      tags: {
        story: story.key,
        specs: story.specs.length,
        review_required: story.specs.filter((s) => s.reviewRequired).length,
        replay: story.specs.filter((s) => s.isReplaySpec).length,
      },
    });
    await this.ensureJiraSubtasks(story);
    return story;
  }

  /**
   * Ensure each spec has its ONE Jira subtask (#11), re-entrant and idempotent: a spec whose
   * contract already carries a subtask key is skipped, so re-entry (restart, repeated sync) never
   * duplicates. Best-effort per spec — a failed create is skipped (warned) and retried on the next
   * sync, not fatal.
   */
  async syncJiraSubtasks(storyKey: string): Promise<void> {
    const story = this.requireStory(storyKey);
    await this.ensureJiraSubtasks(story);
  }

  private async ensureJiraSubtasks(story: Story): Promise<void> {
    if (!this.deps.jiraWriteBack) return;
    let changed = false;
    for (const spec of story.specs) {
      if (spec.jiraSubtaskKey) continue;
      const title = spec.markdown.split("\n", 1)[0]?.replace(/^#\s*/, "") ?? spec.id;
      await this.jiraBestEffort(`subtask for ${spec.id}`, async () => {
        const created = await this.deps.jira.createSubtask(story.key, `${spec.id}: ${title}`);
        spec.jiraSubtaskKey = created.key;
        changed = true;
      });
    }
    // The subtask key is the idempotency record — canonical, so it survives run-state resets.
    if (changed) this.persistContent(story);
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
    this.emitStory(story.key, "executing");
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
    this.emitStory(story.key, "executing");
    this.emitMetric({ name: "story.resumed_after_review", tags: { story: story.key } });
    return this.advanceFrom(story, next === -1 ? story.specs.length : next);
  }

  /**
   * Iterate in place at a review-required stop (#9): run the developer's code feedback as a
   * refinement pass on top of the story branch — behavioural feedback as a must-pass failing test,
   * quality/structural feedback as an NL change-request with the suite-stays-green gate. A green
   * refinement merges onto the story branch; the SAME stop continues (the developer resumes when
   * satisfied). A failed refinement throws with the grade's reason and leaves the merged story
   * untouched at the stop — deliberate, human-directed iteration on completed green code, not the
   * banned mid-build resume (invariant 1).
   */
  async submitReviewFeedback(storyKey: string, feedback: ReviewFeedback): Promise<Story> {
    const story = this.requireStory(storyKey);
    if (story.status !== "awaiting-review") {
      throw new Error(
        `Story ${storyKey} is ${story.status}, cannot take code feedback (expected awaiting-review)`,
      );
    }
    // The spec under review: the most recently merged spec (the one whose stop we are in).
    const spec = [...story.specs].reverse().find((s) => s.status === "merged");
    if (!spec) throw new Error(`Story ${storyKey} is awaiting review but has no merged spec`);

    // Rounds restart at 1 after an app restart — safe, because execute() re-forks (clears) an
    // existing branch of the same name rather than resuming it (ADR-0013).
    const round = (this.feedbackRounds.get(storyKey) ?? 0) + 1;
    this.feedbackRounds.set(storyKey, round);
    const refinementId = `${spec.id}-fb${round}`;

    const baseBranch = await (this.deps.resolveBaseBranch?.(spec.repo, story.key) ??
      Promise.resolve("main"));
    const outcome = await this.deps.executor.execute({
      specId: refinementId,
      repo: spec.repo,
      markdown: feedbackMarkdown(feedback),
      storyKey: story.key,
      baseBranch,
    });
    if (outcome.result !== "green") {
      // The refinement failed — surface why, but the story (already merged, already green) is
      // untouched and still paused at the stop for another attempt or a resume.
      const reason = outcome.result === "red" ? outcome.reason : outcome.reason;
      throw new Error(`Review feedback round ${round} did not go green: ${reason}`);
    }
    await this.deps.mergeToStoryBranch?.(spec.repo, story.key, refinementId);
    this.emitMetric({
      name: "review.feedback_round",
      tags: { story: story.key, spec: spec.id, kind: feedback.kind, round },
    });
    return this.requireStory(storyKey);
  }

  /**
   * "The spec was wrong" (#9): amend the canonical contract and re-run it clean from the current
   * story-branch HEAD (no magic-rewind). Downstream specs that had already merged are invalidated —
   * the cascade — flagged in the return value and reset to re-run in order from the corrected HEAD
   * (pausing at any review-required stop on the way; never silent).
   */
  async amendSpec(
    storyKey: string,
    specId: string,
    markdown: string,
  ): Promise<{ story: Story; cascade: string[] }> {
    const story = this.requireStory(storyKey);
    if (story.status !== "awaiting-review" && story.status !== "dev-complete") {
      throw new Error(
        `Story ${storyKey} is ${story.status}, cannot amend a spec ` +
          `(expected awaiting-review or dev-complete; edit the draft via the review loop instead)`,
      );
    }
    const index = story.specs.findIndex((s) => s.id === specId);
    if (index === -1) throw new Error(`Story ${storyKey} has no spec ${specId}`);

    const spec = story.specs[index]!;
    spec.markdown = markdown;
    this.persistContent(story); // the corrected contract is canonical

    // Cascade: downstream specs whose merged work now stacks on an invalidated contract.
    const cascade = story.specs.slice(index + 1).filter((s) => s.status === "merged").map((s) => s.id);
    for (let i = index; i < story.specs.length; i++) {
      story.specs[i]!.status = "approved";
    }
    story.status = "executing";
    this.persistRun(story);
    this.emitStory(story.key, "executing");
    this.emitMetric({
      name: "spec.amended",
      tags: { story: story.key, spec: specId, cascade: cascade.length },
    });
    const advanced = await this.advanceFrom(story, index);
    return { story: advanced, cascade };
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
    this.emitStory(story.key, "executing");
    // A clean restart is the dev correcting the agent — the code-level correction signal.
    this.emitMetric({ name: "story.restarted", tags: { story: story.key } });
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
    this.emitStory(story.key, "pr-created");
    this.emitMetric({ name: "story.pr_created", tags: { story: story.key, prs: prs.length } });
    return prs;
  }

  /** Run specs from `startIndex` in fixed order, stopping at a review-required green spec. */
  private async advanceFrom(story: Story, startIndex: number): Promise<Story> {
    for (let i = startIndex; i < story.specs.length; i++) {
      const spec = story.specs[i]!;
      spec.status = "running";
      this.persistRun(story);
      this.emitSpec(story.key, spec.id, "running");
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
        this.emitSpec(story.key, spec.id, "failed");
        this.emitStory(story.key, "failed");
        // The grade (red vs ambiguous) is the agent-correction discriminator at code level.
        this.emitMetric({
          name: "spec.failed",
          tags: { story: story.key, repo: spec.repo, result: outcome.result },
        });
        return story;
      }
      spec.status = "green";
      this.emitSpec(story.key, spec.id, "green");
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
        this.emitStory(story.key, "awaiting-review");
        return story;
      }
    }

    story.status = "dev-complete";
    this.persistRun(story);
    this.emitStory(story.key, "dev-complete");
    this.emitMetric({ name: "story.dev_complete", tags: { story: story.key } });
    await this.jiraBestEffort("dev-complete transition", async () => {
      const devComplete = this.deps.jiraWriteBack?.transitions?.devComplete;
      if (devComplete) await this.deps.jira.transitionTicket(story.key, devComplete);
    });
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
    this.emitSpec(story.key, spec.id, "merged");
    this.emitMetric({ name: "spec.merged", tags: { story: story.key, repo: spec.repo } });
    if (spec.jiraSubtaskKey) {
      const subtaskKey = spec.jiraSubtaskKey;
      await this.jiraBestEffort(`close subtask ${subtaskKey}`, () =>
        this.deps.jira.closeSubtask(
          subtaskKey,
          `Dugout: ${spec.id} went green and merged into story/${story.key} ` +
            `(full suite green over baseline, harness-observed; story status: ${story.status}).`,
        ),
      );
    }
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
    this.emitSpec(story.key, spec.id, "failed");
    this.emitStory(story.key, "failed");
    throw err;
  }

  /**
   * Run a Jira write best-effort (#11): failures degrade to a warning and never block the build
   * (invariant 7). Awaitable so call sites stay deterministic, but a rejection cannot escape.
   */
  private async jiraBestEffort(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.warn(`[dugout] jira write-back (${label}) failed (non-blocking): ${String(err)}`);
    }
  }

  /** Emit a metric best-effort: a side-effect failure degrades to a warning, never the build. */
  private emitMetric(event: MetricEvent): void {
    try {
      this.deps.metrics.emit(event);
    } catch (err) {
      console.warn(`[dugout] metrics emit failed (non-blocking): ${String(err)}`);
    }
  }

  /** Emit a story-level transition best-effort (#27): never throws into the state machine. */
  private emitStory(storyKey: string, status: Story["status"]): void {
    this.emitLifecycle({ kind: "story", storyKey, status });
  }

  /** Emit a spec-level transition best-effort (#27): never throws into the state machine. */
  private emitSpec(storyKey: string, specId: string, status: Spec["status"]): void {
    this.emitLifecycle({ kind: "spec", storyKey, specId, status });
  }

  private emitLifecycle(event: LifecycleEvent): void {
    try {
      this.deps.lifecycle?.emit(event);
    } catch (err) {
      console.warn(`[dugout] lifecycle emit failed (non-blocking): ${String(err)}`);
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

  /** Write the canonical contract (markdown + approved plan + review thread) to the SpecStore. */
  private persistContent(story: Story): void {
    const specs: SpecContent[] = story.specs.map((s) => ({
      id: s.id,
      repo: s.repo,
      markdown: s.markdown,
      isReplaySpec: s.isReplaySpec,
      reviewRequired: s.reviewRequired,
      reviewRecommended: s.reviewRecommended,
      order: s.order,
      ...(s.jiraSubtaskKey ? { jiraSubtaskKey: s.jiraSubtaskKey } : {}),
    }));
    const content: StorySpecs = {
      key: story.key,
      title: story.title,
      specs,
      ...(story.reviewThread ? { reviewThread: story.reviewThread } : {}),
    };
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
  return {
    key: content.key,
    title: run.title,
    status: run.status,
    specs,
    declaredRepos: run.declaredRepos,
    ...(content.reviewThread ? { reviewThread: content.reviewThread } : {}),
  };
}

/**
 * Render a review-loop feedback entry (+ relevant thread context) into the revision request the
 * draft agent sees (#5). Scope becomes plain language; prior direct edits are called out so the
 * agent flags (never overrides) inconsistencies they introduced.
 */
function renderDraftFeedback(entry: ReviewThreadEntry, thread: ReviewThreadEntry[]): string {
  const scopeLine =
    entry.scope.kind === "set"
      ? "Scope: the whole spec set / fan-out (split, merge, reorder, repo boundaries)."
      : entry.scope.kind === "spec"
        ? `Scope: spec ${entry.scope.specId}.`
        : `Scope: the "${entry.scope.section}" section of spec ${entry.scope.specId}.`;
  const lines = [scopeLine, "", entry.content];
  const directEdits = thread.filter((t) => t.kind === "direct-edit");
  if (directEdits.length > 0) {
    lines.push(
      "",
      "Note: the developer has directly edited " +
        directEdits
          .map((t) => (t.scope.kind === "set" ? "the set" : t.scope.specId))
          .join(", ") +
        " — their edits are authoritative. Do NOT override them; if an edit introduced an" +
        " inconsistency, FLAG it in the affected spec instead of fixing it silently.",
    );
  }
  return lines.join("\n");
}

/**
 * Frame the developer's code feedback as the refinement run's spec markdown (#9). The executor
 * treats it like any spec build: red→green for the supplied test, suite-green gate either way.
 */
function feedbackMarkdown(feedback: ReviewFeedback): string {
  if (feedback.kind === "test") {
    return [
      "# Review feedback — behavioural, expressed as a must-pass failing test",
      "",
      "The reviewer supplied this failing test. Add it to the suite verbatim (adapt only imports/",
      "placement), confirm it fails, then change the code to make it green:",
      "",
      feedback.content,
    ].join("\n");
  }
  return [
    "# Review feedback — quality/structural (no behaviour change)",
    "",
    feedback.content,
    "",
    "Do NOT change externally observable behaviour: the full suite must stay green, with no tests",
    "modified or removed.",
  ].join("\n");
}

/**
 * Fully-linked PR body (#10): maximum context for the peer reviewer — the story, every spec that
 * landed in this repo (flags + resting status + the full canonical markdown, which carries the AC
 * mapping and test plan), and what the per-spec green actually proved.
 */
function prBody(story: Story, repoSpecs: Spec[]): string {
  const summary = repoSpecs
    .map(
      (s) =>
        `- \`${s.id}\` — ${s.status}` +
        `${s.isReplaySpec ? " · replay spec" : ""}${s.reviewRequired ? " · review-required" : ""}`,
    )
    .join("\n");
  const specSections = repoSpecs
    .map((s) =>
      [
        `<details><summary><code>${s.id}</code> — full spec (AC mapping + test plan)</summary>`,
        "",
        s.markdown,
        "",
        "</details>",
      ].join("\n"),
    )
    .join("\n\n");
  return [
    `Story: ${story.key} — ${story.title}`,
    "",
    "Specs in this PR:",
    summary,
    "",
    "Test results: each spec merged at green — the full local suite passed over the pre-existing-",
    "failure baseline, observed by the harness in the sandbox (never self-reported by the agent).",
    "One `--no-ff` merge bubble per spec on this branch; commits are stamped with the spec id.",
    "",
    specSections,
    "",
    "_Opened by Dugout. Never auto-merged — the merge decision is yours (peer review)._",
  ].join("\n");
}
