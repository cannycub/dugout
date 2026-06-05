/**
 * The renderer↔core contract. The renderer depends ONLY on this interface — never on Electron
 * APIs directly (ADR-0001 / CLAUDE.md). Today it's implemented over IPC (preload → main); later
 * it can be implemented over HTTP against a backend, with no change to the React components.
 */

import type { Story, Preflight } from "../core/domain.js";
import type { Ticket } from "../core/ports/jira.js";
import type { PullRequest } from "../core/ports/github.js";
import type { DeclaredRepo } from "../core/repo-scope.js";

/** A streamed telemetry event (metric emit or lifecycle transition) shown in the UI log. */
export type DugoutEvent =
  | { kind: "metric"; name: string; tags: Record<string, string | number>; at: number }
  | { kind: "lifecycle"; name: string; storyKey: string; status: string; at: number };

/** Stable IPC channel names, shared by preload and main so they can't drift. */
export const CHANNELS = {
  listTickets: "dugout:listTickets",
  getStory: "dugout:getStory",
  draft: "dugout:draft",
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
  draft(storyKey: string, repos: DeclaredRepo[]): Promise<Story>;
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
