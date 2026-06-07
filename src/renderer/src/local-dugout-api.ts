import { Orchestrator } from "../../core/orchestrator.js";
import { FakeJira } from "../../core/fakes/fake-jira.js";
import { FakeExecutor } from "../../core/fakes/fake-executor.js";
import { FakeGitHub } from "../../core/fakes/fake-github.js";
import { FakeEnvReplay } from "../../core/fakes/fake-env-replay.js";
import { SwitchableExecutor } from "../../core/switchable-executor.js";
import type { ExecutorPort } from "../../core/ports/executor.js";
import type { RepoScope } from "../../core/repo-scope.js";
import type { Story } from "../../core/domain.js";
import type { Ticket } from "../../core/ports/jira.js";
import type { DraftOutcome } from "../../core/ports/executor.js";
import type { MetricsPort, MetricEvent } from "../../core/ports/metrics.js";
import type { DugoutApi, DugoutEvent } from "../../shared/dugout-api.js";

export interface LocalSeed {
  /** The developer's assigned tickets (their roster). */
  tickets: Ticket[];
  /**
   * The fake draft outcome(s). A single {@link DraftOutcome} is returned for every draft() call; an
   * array is consumed in order to drive a clarification loop. Omit when supplying {@link executor}.
   */
  draft?: DraftOutcome | DraftOutcome[];
  /**
   * An explicit executor, used as the fake-mode backend instead of building one from {@link draft}.
   * Lets a test inject a {@link FakeExecutor} and assert on its recorded `draftCalls`.
   */
  executor?: ExecutorPort;
  /** Catalog + clone discovery backing the declare-repos step (ADR-0006). */
  repoScope: RepoScope;
}

/**
 * An in-process {@link DugoutApi} backed by the real core + fake ports — no Electron, no IPC.
 * Same interface the preload's IPC client implements, so React components are identical whether
 * driven by this (tests / a future web build) or by Electron. Telemetry is forwarded from the
 * metrics port and lifecycle transitions, mirroring the Electron host.
 */
export function createLocalDugoutApi(seed: LocalSeed): DugoutApi {
  const listeners = new Set<(event: DugoutEvent) => void>();
  const broadcast = (event: DugoutEvent) => listeners.forEach((l) => l(event));

  const metrics: MetricsPort = {
    emit(event: MetricEvent) {
      broadcast({ kind: "metric", name: event.name, tags: event.tags ?? {}, at: Date.now() });
    },
  };

  // In-process path (tests / a future web build): there's no real kiro, so "live" drafting is
  // unavailable — the mode still toggles (for the UI), but drafting live errors clearly.
  const liveUnavailable: ExecutorPort = {
    draft: async () => {
      throw new Error("the live (kiro) executor is not available in local mode");
    },
    execute: async () => {
      throw new Error("the live (kiro) executor is not available in local mode");
    },
  };
  const executor = new SwitchableExecutor({
    fake: seed.executor ?? new FakeExecutor({ draft: seed.draft ?? { result: "drafted", specs: [] } }),
    live: liveUnavailable,
    mode: "fakes",
  });

  const orchestrator = new Orchestrator({
    jira: new FakeJira({ tickets: seed.tickets }),
    executor,
    github: new FakeGitHub(),
    metrics,
    envReplay: new FakeEnvReplay(),
    repoScope: seed.repoScope,
  });

  const afterTransition = (story: Story) =>
    broadcast({
      kind: "lifecycle",
      name: `story.${story.status}`,
      storyKey: story.key,
      status: story.status,
      at: Date.now(),
    });

  return {
    listTickets: () => orchestrator.listAssignedTickets(),
    getStory: async (key) => orchestrator.getStory(key) ?? null,
    draft: async (key, repos, clarifications) => {
      const result = await orchestrator.draftStory(key, {
        repos,
        ...(clarifications ? { clarifications } : {}),
      });
      // Only a drafted fan-out is a lifecycle transition; the stop outcomes persist nothing.
      if (result.outcome === "drafted") afterTransition(result.story);
      return result;
    },
    searchRepos: (query) => orchestrator.searchRepos(query),
    declareRepos: (names) => orchestrator.declareRepos(names),
    rescanRepos: () => orchestrator.rescanRepos(),
    listWorkspaceRoots: () => orchestrator.listWorkspaceRoots(),
    approve: async (key, preflight) => {
      const story = await orchestrator.approveStory(key, preflight);
      afterTransition(story);
      return story;
    },
    run: async (key) => {
      const story = await orchestrator.runStory(key);
      afterTransition(story);
      return story;
    },
    resume: async (key) => {
      const story = await orchestrator.resumeAfterReview(key);
      afterTransition(story);
      return story;
    },
    restart: async (key) => {
      const story = await orchestrator.restartStory(key);
      afterTransition(story);
      return story;
    },
    createPullRequests: async (key) => {
      const prs = await orchestrator.createPullRequests(key);
      const story = orchestrator.getStory(key);
      if (story) afterTransition(story);
      return prs;
    },
    getExecutorMode: async () => executor.getMode(),
    setExecutorMode: async (mode) => {
      executor.setMode(mode);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
