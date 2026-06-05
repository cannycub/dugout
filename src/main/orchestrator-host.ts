import { join } from "node:path";
import { BrowserWindow, safeStorage } from "electron";
import { Orchestrator } from "../core/orchestrator.js";
import { FakeJira } from "../core/fakes/fake-jira.js";
import { FakeExecutor } from "../core/fakes/fake-executor.js";
import { FakeGitHub } from "../core/fakes/fake-github.js";
import { FakeEnvReplay } from "../core/fakes/fake-env-replay.js";
import { InMemorySpecStore } from "../core/store/in-memory-spec-store.js";
import { InMemoryRunStateStore } from "../core/store/in-memory-run-state-store.js";
import { SqliteRunStateStore } from "../core/store/sqlite-run-state-store.js";
import { RepoScope } from "../core/repo-scope.js";
import { GitHubCatalog } from "../core/adapters/github-catalog.js";
import { GitWorkspace } from "../core/adapters/git-workspace.js";
import { JiraReadAdapter } from "../core/adapters/jira-read-adapter.js";
import { JiraCredentialStore } from "./jira-credentials.js";
import type { RunStateStore } from "../core/store/run-state-store.js";
import type { MetricsPort, MetricEvent } from "../core/ports/metrics.js";
import type { JiraPort } from "../core/ports/jira.js";
import { CHANNELS, type DugoutEvent } from "../shared/dugout-api.js";
import { SEED_TICKET, SEED_DRAFT, SEED_CATALOG } from "./seed.js";

/** Broadcast a telemetry event to every renderer window. */
function broadcast(event: DugoutEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.event, event);
  }
}

/** Metrics port that forwards every emit to the renderer as a telemetry event (best-effort). */
class MetricsForwarder implements MetricsPort {
  emit(event: MetricEvent): void {
    broadcast({ kind: "metric", name: event.name, tags: event.tags ?? {}, at: Date.now() });
  }
}

/**
 * Open the SQLite run-state store, falling back to in-memory only if the file can't be opened
 * (e.g. a read-only disk). node:sqlite is built into the runtime, so there's no native ABI to
 * rebuild — the same store works under Node and Electron.
 */
function openRunStateStore(userDataDir: string): RunStateStore {
  try {
    return new SqliteRunStateStore(join(userDataDir, "run-state.sqlite"));
  } catch (err) {
    console.warn(`[dugout] SQLite run-state unavailable (${String(err)}); using in-memory store.`);
    return new InMemoryRunStateStore();
  }
}

/** Developer-configured workspace roots to scan for clones (colon-separated env, like PATH).
 * A roots-config UI is out of scope for #3; until then this env is the only knob. Empty ⇒ no
 * clones discovered, so every catalog repo binds as "not-cloned" (still selectable). */
function workspaceRoots(): string[] {
  const raw = process.env["DUGOUT_WORKSPACE_ROOTS"];
  return raw ? raw.split(":").filter(Boolean) : [];
}

/**
 * Wires the orchestrator. The executor stays fake (no kiro yet); the repo-scope seam is real
 * (GitHub-org catalog — still seeded via FakeGitHub until a real list adapter lands — + local
 * clone discovery). Jira is the real API-token adapter only when the developer has saved
 * credentials (ADR-0005); otherwise the seed fake keeps dev/test working without live Jira.
 */
export async function createOrchestrator(userDataDir: string): Promise<Orchestrator> {
  const github = new FakeGitHub(SEED_CATALOG);

  let jira: JiraPort = new FakeJira({ tickets: [SEED_TICKET] });
  const creds = await new JiraCredentialStore(join(userDataDir, "jira.cred"), safeStorage).load();
  if (creds) jira = new JiraReadAdapter(creds);

  const repoScope = new RepoScope(
    new GitHubCatalog(github),
    new GitWorkspace({ roots: workspaceRoots() }),
  );

  return new Orchestrator({
    jira,
    executor: new FakeExecutor({ draft: SEED_DRAFT }),
    github,
    metrics: new MetricsForwarder(),
    envReplay: new FakeEnvReplay(),
    specStore: new InMemorySpecStore(),
    store: openRunStateStore(userDataDir),
    repoScope,
  });
}

export { broadcast };
