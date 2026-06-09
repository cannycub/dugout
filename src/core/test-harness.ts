import { Orchestrator } from "./orchestrator.js";
import { FakeJira } from "./fakes/fake-jira.js";
import { FakeExecutor } from "./fakes/fake-executor.js";
import { FakeGitHub } from "./fakes/fake-github.js";
import { FakeMetrics } from "./fakes/fake-metrics.js";
import { FakeEnvReplay } from "./fakes/fake-env-replay.js";
import { InMemoryRunStateStore } from "./store/in-memory-run-state-store.js";
import { InMemorySpecStore } from "./store/in-memory-spec-store.js";
import type { DraftedSpec, DraftOutcome, ExecuteOutcome } from "./ports/executor.js";
import type { Ticket } from "./ports/jira.js";
import type { RunStateStore } from "./store/run-state-store.js";
import type { SpecStore } from "./store/spec-store.js";
import type { DeclaredRepo } from "./repo-scope.js";

const DEFAULT_TICKET: Ticket = {
  key: "DUG-1",
  title: "Add widget",
  description: "AC: returns 200",
};

export interface HarnessOptions {
  tickets?: Ticket[];
  /**
   * What the fake executor's draft() returns. The common case is a drafted fan-out, so a bare
   * `DraftedSpec[]` is wrapped as `{ result: "drafted", specs }`; pass a full {@link DraftOutcome}
   * to exercise a `needs-info` / `needs-clarification` stop (ADR-0007). Omit when using
   * {@link drafts} to drive a multi-round clarification loop.
   */
  draft?: DraftedSpec[] | DraftOutcome;
  /**
   * A sequence of draft outcomes, consumed one per draft() call — to drive the clarification loop
   * across rounds (e.g. round 1 `needs-clarification`, round 2 `drafted`). Mutually exclusive with
   * {@link draft}.
   */
  drafts?: DraftOutcome[];
  /** Per-spec execute outcomes (specs not listed default to green). */
  execute?: Record<string, ExecuteOutcome>;
  /** Base-branch resolver the orchestrator passes into execute(); defaults to a fake returning "main". */
  resolveBaseBranch?: (repo: string, storyKey: string) => Promise<string>;
  /**
   * Story-branch merge the orchestrator invokes when a spec goes green (ADR-0014). Defaults to a
   * recording no-op (no real git) — exposed as `mergeCalls` for assertions. Pass an override to
   * exercise an operational merge failure (the unwind-to-failed backstop).
   */
  mergeToStoryBranch?: (repo: string, storyKey: string, specId: string) => Promise<void>;
  /** Run-state store override; defaults to a fresh in-memory store. */
  store?: RunStateStore;
  /** Spec content store override; defaults to a fresh in-memory store. */
  specStore?: SpecStore;
}

/** Builds an Orchestrator wired to all five fake ports + both stores, exposed for assertions. */
export function makeHarness(options: HarnessOptions) {
  const jira = new FakeJira({ tickets: options.tickets ?? [DEFAULT_TICKET] });
  if (options.draft !== undefined && options.drafts !== undefined) {
    throw new Error("makeHarness: pass either `draft` or `drafts`, not both");
  }
  if (options.draft === undefined && options.drafts === undefined) {
    throw new Error("makeHarness: one of `draft` or `drafts` is required");
  }
  const draft: DraftOutcome | DraftOutcome[] = options.drafts
    ? options.drafts
    : Array.isArray(options.draft)
      ? { result: "drafted", specs: options.draft }
      : options.draft!;
  const executor = new FakeExecutor({
    draft,
    ...(options.execute ? { execute: options.execute } : {}),
  });
  const github = new FakeGitHub();
  const metrics = new FakeMetrics();
  const envReplay = new FakeEnvReplay();
  const store = options.store ?? new InMemoryRunStateStore();
  const specStore = options.specStore ?? new InMemorySpecStore();
  const resolveBaseBranch = options.resolveBaseBranch ?? (async () => "main");
  const mergeCalls: Array<{ repo: string; storyKey: string; specId: string }> = [];
  const mergeToStoryBranch =
    options.mergeToStoryBranch ??
    (async (repo: string, storyKey: string, specId: string) => {
      mergeCalls.push({ repo, storyKey, specId });
    });
  const orchestrator = new Orchestrator({ jira, executor, github, metrics, envReplay, store, specStore, resolveBaseBranch, mergeToStoryBranch });
  return { orchestrator, jira, executor, github, metrics, envReplay, store, specStore, mergeCalls };
}

/**
 * Build a `DeclaredRepo` from a catalog name with a synthetic identity + local clone. Tests that
 * only care about the repo name (not clone resolution) use this to satisfy the widened `draft`
 * signature (ADR-0006) without restating the full shape each time.
 */
export function declared(name: string): DeclaredRepo {
  return {
    identity: { name, remote: `git@github.com:acme/${name}.git` },
    clone: { status: "cloned", path: `/ws/${name}` },
  };
}

/** Convenience: drive a story to `approved` with default pre-flight. Accepts repo names. */
export async function draftAndApprove(
  orchestrator: Orchestrator,
  repos: string[],
  ticketKey = "DUG-1",
) {
  await orchestrator.draftStory(ticketKey, { repos: repos.map(declared) });
  await orchestrator.approveStory(ticketKey, {});
}
