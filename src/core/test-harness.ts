import { Orchestrator } from "./orchestrator.js";
import { FakeJira } from "./fakes/fake-jira.js";
import { FakeExecutor } from "./fakes/fake-executor.js";
import { FakeGitHub } from "./fakes/fake-github.js";
import { FakeMetrics } from "./fakes/fake-metrics.js";
import { FakeEnvReplay } from "./fakes/fake-env-replay.js";
import { InMemoryRunStateStore } from "./store/in-memory-run-state-store.js";
import { InMemorySpecStore } from "./store/in-memory-spec-store.js";
import type { DraftedSpec, ExecuteOutcome } from "./ports/executor.js";
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
  /** Drafted fan-out the fake executor returns. */
  draft: DraftedSpec[];
  /** Per-spec execute outcomes (specs not listed default to green). */
  execute?: Record<string, ExecuteOutcome>;
  /** Run-state store override; defaults to a fresh in-memory store. */
  store?: RunStateStore;
  /** Spec content store override; defaults to a fresh in-memory store. */
  specStore?: SpecStore;
}

/** Builds an Orchestrator wired to all five fake ports + both stores, exposed for assertions. */
export function makeHarness(options: HarnessOptions) {
  const jira = new FakeJira({ tickets: options.tickets ?? [DEFAULT_TICKET] });
  const executor = new FakeExecutor({
    draft: { specs: options.draft },
    ...(options.execute ? { execute: options.execute } : {}),
  });
  const github = new FakeGitHub();
  const metrics = new FakeMetrics();
  const envReplay = new FakeEnvReplay();
  const store = options.store ?? new InMemoryRunStateStore();
  const specStore = options.specStore ?? new InMemorySpecStore();
  const orchestrator = new Orchestrator({ jira, executor, github, metrics, envReplay, store, specStore });
  return { orchestrator, jira, executor, github, metrics, envReplay, store, specStore };
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
