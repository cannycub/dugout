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
import { KiroDraftAdapter } from "../core/adapters/kiro-draft-adapter.js";
import { spawnKiroRunner } from "../core/adapters/kiro-runner.js";
import { SwitchableExecutor, type ExecutorMode } from "../core/switchable-executor.js";
import { JiraCredentialStore, jiraCredentialsFromEnv } from "./jira-credentials.js";
import { SettingsStore } from "./settings-store.js";
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

/** Runtime control over which executor backs drafting, persisting the choice across restarts. */
export interface ExecutorModeControl {
  get(): ExecutorMode;
  set(mode: ExecutorMode): void;
}

/**
 * Wires the orchestrator. Drafting runs through a {@link SwitchableExecutor}: the developer flips it
 * from the UI between the in-memory fakes and the real (kiro) live path; execute mode stays fake
 * (no sandbox adapter yet). The repo-scope seam is real (GitHub-org catalog — still seeded via
 * FakeGitHub until a real list adapter lands — + local clone discovery). Jira is the real API-token
 * adapter when the developer has saved credentials (ADR-0005) or set the `DUGOUT_JIRA_*` env vars (a
 * stopgap until the settings UI #17 lands); otherwise the seed fake keeps dev/test working without
 * live Jira.
 */
export async function createOrchestrator(
  userDataDir: string,
): Promise<{ orchestrator: Orchestrator; modeControl: ExecutorModeControl }> {
  const github = new FakeGitHub(SEED_CATALOG);

  // Live Jira when the developer has saved credentials (ADR-0005); else the env-var stopgap (until
  // the settings UI #17 lands — nothing yet calls save(), so env is the only path to live Jira);
  // else the seed fake keeps dev/test working without live Jira.
  let jira: JiraPort = new FakeJira({ tickets: [SEED_TICKET] });
  const saved = await new JiraCredentialStore(join(userDataDir, "jira.cred"), safeStorage).load();
  const creds = saved ?? jiraCredentialsFromEnv();
  if (creds) jira = new JiraReadAdapter(creds);

  const repoScope = new RepoScope(
    new GitHubCatalog(github),
    new GitWorkspace({ roots: workspaceRoots() }),
  );

  // Draft executor is switchable: fakes (seed) ↔ live (real kiro, read-only). Initial mode is the
  // developer's persisted choice; switching persists the new choice (best-effort).
  const settings = new SettingsStore(join(userDataDir, "settings.json"));
  const executor = new SwitchableExecutor({
    fake: new FakeExecutor({ draft: SEED_DRAFT }),
    live: new KiroDraftAdapter({
      workDir: join(userDataDir, "kiro-work"),
      runKiro: spawnKiroRunner(),
    }),
    mode: settings.load().executorMode,
  });
  const modeControl: ExecutorModeControl = {
    get: () => executor.getMode(),
    set: (mode) => {
      executor.setMode(mode);
      try {
        settings.save({ executorMode: mode });
      } catch (err) {
        console.warn(`[dugout] could not persist executor mode (non-blocking): ${String(err)}`);
      }
    },
  };

  const orchestrator = new Orchestrator({
    jira,
    executor,
    github,
    metrics: new MetricsForwarder(),
    envReplay: new FakeEnvReplay(),
    specStore: new InMemorySpecStore(),
    store: openRunStateStore(userDataDir),
    repoScope,
  });
  return { orchestrator, modeControl };
}

export { broadcast };
