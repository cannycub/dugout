import { Orchestrator } from "../../core/orchestrator.js";
import { FakeJira } from "../../core/fakes/fake-jira.js";
import { FakeExecutor } from "../../core/fakes/fake-executor.js";
import { FakeGitHub } from "../../core/fakes/fake-github.js";
import { FakeEnvReplay } from "../../core/fakes/fake-env-replay.js";
import type { ExecutorPort } from "../../core/ports/executor.js";
import type { RepoScope } from "../../core/repo-scope.js";

import type { Ticket } from "../../core/ports/jira.js";
import type { DraftOutcome } from "../../core/ports/executor.js";
import type { MetricsPort, MetricEvent } from "../../core/ports/metrics.js";
import type { LifecyclePort, LifecycleEvent } from "../../core/ports/lifecycle.js";
import type { DugoutApi, DugoutEvent, SettingsView, JiraCredentialsInput } from "../../shared/dugout-api.js";

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

  // Metrics never reach the renderer (#27 de-conflation): a silent best-effort sink, swapped for
  // the real Datadog adapter by #13. Lifecycle transitions are what the UI streams.
  const metrics: MetricsPort = {
    emit(_event: MetricEvent) {
      /* intentionally silent */
    },
  };
  const lifecycle: LifecyclePort = {
    emit(event: LifecycleEvent) {
      broadcast({ ...event, at: Date.now() });
    },
  };

  // In-process path (tests / a future web build): always the in-memory fakes — there's no real
  // kiro here. The shipped app's live drafting is wired in the Electron host (orchestrator-host.ts).
  const executor: ExecutorPort =
    seed.executor ?? new FakeExecutor({ draft: seed.draft ?? { result: "drafted", specs: [] } });

  const orchestrator = new Orchestrator({
    jira: new FakeJira({ tickets: seed.tickets }),
    executor,
    github: new FakeGitHub(),
    metrics,
    lifecycle,
    envReplay: new FakeEnvReplay(),
    repoScope: seed.repoScope,
  });

  // In-memory settings state (#17): same DugoutApi surface as the Electron host, no persistence —
  // the e2e/App tests drive the settings UI against this; the real stores are main-process glue.
  const settingsState: { roots: string[]; jira: JiraCredentialsInput | null; github: string | null } = {
    roots: [],
    jira: null,
    github: null,
  };
  const settingsView = async (): Promise<SettingsView> => ({
    workspaceRoots: settingsState.roots,
    jira: {
      baseUrl: settingsState.jira?.baseUrl ?? "",
      email: settingsState.jira?.email ?? "",
      configured: settingsState.jira !== null,
    },
    github: { configured: settingsState.github !== null },
    encryptionAvailable: true,
  });

  return {
    listTickets: () => orchestrator.listAssignedTickets(),
    getStory: async (key) => orchestrator.getStory(key) ?? null,
    draft: (key, repos, clarifications) =>
      orchestrator.draftStory(key, {
        repos,
        ...(clarifications ? { clarifications } : {}),
      }),
    searchRepos: (query) => orchestrator.searchRepos(query),
    declareRepos: (names) => orchestrator.declareRepos(names),
    rescanRepos: () => orchestrator.rescanRepos(),
    listWorkspaceRoots: () => orchestrator.listWorkspaceRoots(),
    approve: (key, preflight) => orchestrator.approveStory(key, preflight),
    run: (key) => orchestrator.runStory(key),
    resume: (key) => orchestrator.resumeAfterReview(key),
    restart: (key) => orchestrator.restartStory(key),
    createPullRequests: (key) => orchestrator.createPullRequests(key),
    submitReviewFeedback: (key, feedback) => orchestrator.submitReviewFeedback(key, feedback),
    reviseDraft: (key, feedback) => orchestrator.reviseDraft(key, feedback),
    editSpecDraft: (key, specId, markdown) => orchestrator.editSpecDraft(key, specId, markdown),
    amendSpec: (key, specId, markdown) => orchestrator.amendSpec(key, specId, markdown),
    getSettings: settingsView,
    saveWorkspaceRoots: async (roots) => {
      settingsState.roots = roots.map((r) => r.trim()).filter(Boolean);
      await orchestrator.rescanRepos();
      return settingsView();
    },
    saveJiraCredentials: async (creds) => {
      settingsState.jira = creds;
      return settingsView();
    },
    clearJiraCredentials: async () => {
      settingsState.jira = null;
      return settingsView();
    },
    saveGitHubToken: async (token) => {
      settingsState.github = token;
      return settingsView();
    },
    clearGitHubToken: async () => {
      settingsState.github = null;
      return settingsView();
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
