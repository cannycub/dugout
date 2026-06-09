/**
 * The renderer↔core contract. The renderer depends ONLY on this interface — never on Electron
 * APIs directly (ADR-0001 / CLAUDE.md). Today it's implemented over IPC (preload → main); later
 * it can be implemented over HTTP against a backend, with no change to the React components.
 */

import type { Story, Preflight, StoryStatus, SpecStatus } from "../core/domain.js";
import type { DraftStoryResult } from "../core/orchestrator.js";
import type { Ticket } from "../core/ports/jira.js";
import type { PullRequest } from "../core/ports/github.js";
import type { ClarificationRound } from "../core/ports/executor.js";
import type { DeclaredRepo, RepoMatch } from "../core/repo-scope.js";

/**
 * A streamed lifecycle transition (#27): the wire shape of the core's LifecycleEvent, stamped with
 * `at` by the transport. Typed per kind so the renderer can patch a held Story by specId. Metrics
 * are deliberately NOT on this stream — they go port → Datadog/no-op and never reach the renderer.
 */
export type DugoutEvent =
  | { kind: "story"; storyKey: string; status: StoryStatus; at: number }
  | { kind: "spec"; storyKey: string; specId: string; status: SpecStatus; at: number };

/** Stable IPC channel names, shared by preload and main so they can't drift. */
export const CHANNELS = {
  listTickets: "dugout:listTickets",
  getStory: "dugout:getStory",
  draft: "dugout:draft",
  searchRepos: "dugout:searchRepos",
  declareRepos: "dugout:declareRepos",
  rescanRepos: "dugout:rescanRepos",
  listWorkspaceRoots: "dugout:listWorkspaceRoots",
  approve: "dugout:approve",
  run: "dugout:run",
  resume: "dugout:resume",
  restart: "dugout:restart",
  createPullRequests: "dugout:createPullRequests",
  event: "dugout:event",
} as const;

/** The capability surface the renderer programs against. */
export interface DugoutApi {
  listTickets(): Promise<Ticket[]>;
  getStory(storyKey: string): Promise<Story | null>;
  /**
   * Draft the fan-out. Returns a discriminated {@link DraftStoryResult}: a `drafted` story, or a
   * `needs-info` / `needs-clarification` stop the agent returned rather than guess (ADR-0007).
   * On a re-draft, pass the developer's answered `clarifications` (oldest-first) to close the
   * needs-clarification loop; absent/empty on the first attempt.
   */
  draft(
    storyKey: string,
    repos: DeclaredRepo[],
    clarifications?: ClarificationRound[],
  ): Promise<DraftStoryResult>;
  /** Search the catalog; each match carries its clone binding. v1: local filter. */
  searchRepos(query: string): Promise<RepoMatch[]>;
  /** Bind chosen catalog names to local clones, re-resolved server-side against the current index. */
  declareRepos(names: string[]): Promise<DeclaredRepo[]>;
  /** Re-scan workspace roots (after the dev clones something mid-flight). */
  rescanRepos(): Promise<void>;
  /** The developer's configured workspace roots (for display). */
  listWorkspaceRoots(): Promise<string[]>;
  approve(storyKey: string, preflight: Preflight): Promise<Story>;
  run(storyKey: string): Promise<Story>;
  resume(storyKey: string): Promise<Story>;
  restart(storyKey: string): Promise<Story>;
  createPullRequests(storyKey: string): Promise<PullRequest[]>;
  /** Subscribe to streamed telemetry; returns an unsubscribe function. */
  onEvent(listener: (event: DugoutEvent) => void): () => void;
}

declare global {
  interface Window {
    /** The preload-injected implementation of {@link DugoutApi}. */
    dugout: DugoutApi;
  }
}
