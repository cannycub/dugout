import { join } from "node:path";
import { BrowserWindow } from "electron";
import { Orchestrator } from "../core/orchestrator.js";
import { FakeJira } from "../core/fakes/fake-jira.js";
import { FakeExecutor } from "../core/fakes/fake-executor.js";
import { FakeGitHub } from "../core/fakes/fake-github.js";
import { FakeEnvReplay } from "../core/fakes/fake-env-replay.js";
import { InMemorySpecStore } from "../core/store/in-memory-spec-store.js";
import { InMemoryRunStateStore } from "../core/store/in-memory-run-state-store.js";
import { SqliteRunStateStore } from "../core/store/sqlite-run-state-store.js";
import type { RunStateStore } from "../core/store/run-state-store.js";
import type { MetricsPort, MetricEvent } from "../core/ports/metrics.js";
import { CHANNELS, type DugoutEvent } from "../shared/dugout-api.js";
import { SEED_TICKET, SEED_DRAFT } from "./seed.js";

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

/** Wires the orchestrator to fake ports and seeds the one fake ticket the skeleton drives. */
export function createOrchestrator(userDataDir: string): Orchestrator {
  return new Orchestrator({
    jira: new FakeJira({ tickets: [SEED_TICKET] }),
    executor: new FakeExecutor({ draft: SEED_DRAFT }),
    github: new FakeGitHub(),
    metrics: new MetricsForwarder(),
    envReplay: new FakeEnvReplay(),
    specStore: new InMemorySpecStore(),
    store: openRunStateStore(userDataDir),
  });
}

export { broadcast };
