import { Orchestrator } from "../../core/orchestrator.js";
import { FakeJira } from "../../core/fakes/fake-jira.js";
import { FakeExecutor } from "../../core/fakes/fake-executor.js";
import { FakeGitHub } from "../../core/fakes/fake-github.js";
import { FakeEnvReplay } from "../../core/fakes/fake-env-replay.js";
import type { RepoScope } from "../../core/repo-scope.js";
import type { Story } from "../../core/domain.js";
import type { Ticket } from "../../core/ports/jira.js";
import type { DraftResult } from "../../core/ports/executor.js";
import type { MetricsPort, MetricEvent } from "../../core/ports/metrics.js";
import type { DugoutApi, DugoutEvent } from "../../shared/dugout-api.js";

export interface LocalSeed {
  ticket: Ticket;
  draft: DraftResult;
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

  const orchestrator = new Orchestrator({
    jira: new FakeJira({ tickets: [seed.ticket] }),
    executor: new FakeExecutor({ draft: seed.draft }),
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
    draft: async (key, repos) => {
      const story = await orchestrator.draftStory(key, { repos });
      afterTransition(story);
      return story;
    },
    searchRepos: (query) => orchestrator.searchRepos(query),
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
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
