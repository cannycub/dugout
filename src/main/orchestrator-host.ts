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
import { run as sandcastleRun } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { KiroExecuteAdapter } from "../core/adapters/kiro-execute-adapter.js";
import { kiroExecuteAgent } from "../core/adapters/kiro-agent-provider.js";
import { JiraCredentialStore, jiraCredentialsFromEnv } from "./jira-credentials.js";
import { KiroCredentialStore, kiroApiKeyFromEnv } from "./kiro-credentials.js";
import type { RunStateStore } from "../core/store/run-state-store.js";
import type { MetricsPort, MetricEvent } from "../core/ports/metrics.js";
import type { JiraPort } from "../core/ports/jira.js";
import type { DraftOutcome, ExecutorPort } from "../core/ports/executor.js";
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
 * The fake executor's canned draft outcome(s). Normally the single seed fan-out. The e2e suite sets
 * `DUGOUT_SEED_CLARIFY` to swap in a deterministic two-round sequence (ask → draft) so a full
 * clarification loop can be driven through real Electron IPC against the fakes (#21) — the only
 * fake-config seam the built app exposes. No effect on the shipped app (env unset).
 */
function fakeDraftSeed(): DraftOutcome | DraftOutcome[] {
  if (process.env["DUGOUT_SEED_CLARIFY"]) {
    return [
      { result: "needs-clarification", questions: [{ id: "q1", prompt: "Soft-delete or hard-delete?" }] },
      SEED_DRAFT,
    ];
  }
  return SEED_DRAFT;
}

/**
 * Wires the orchestrator. The shipped app is **always live**: drafting runs the real (kiro)
 * adapter. Setting `DUGOUT_EXECUTOR=fakes` selects the in-memory fakes instead — a dev/test wiring
 * seam fixed at startup (ADR-0010), consistent with the `DUGOUT_SEED_CLARIFY` / `DUGOUT_JIRA_*`
 * stopgaps; there is no runtime toggle. Either way `execute` stays fake — no sandbox/execute adapter
 * yet (later slice, #7). The repo-scope seam is real (GitHub-org catalog — still seeded via
 * FakeGitHub until a real list adapter lands — + local clone discovery). Jira is the real API-token
 * adapter when the developer has saved credentials (ADR-0005) or set the `DUGOUT_JIRA_*` env vars (a
 * stopgap until the settings UI #17 lands); otherwise the seed fake keeps dev/test working without
 * live Jira.
 */
export async function createOrchestrator(userDataDir: string): Promise<Orchestrator> {
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

  // Source the kiro API key from secure storage (onboarding #18) or the env stopgap, ONCE, in the
  // main process — both kiro adapters take it explicitly rather than reading process.env lazily, so a
  // GUI-launched app (which doesn't inherit a shell's exports) can still reach kiro. undefined ⇒ the
  // adapters fall back to their own process.env read and fail loudly if it's absent too.
  const kiroApiKey =
    (await new KiroCredentialStore(join(userDataDir, "kiro.cred"), safeStorage).load()) ??
    kiroApiKeyFromEnv() ??
    undefined;

  // Draft executor: real kiro by default; `DUGOUT_EXECUTOR=fakes` selects the in-memory fakes
  // (dev/test seam, ADR-0010). The clarify demo seam also slows the fake draft so the waiting view is
  // observable in the e2e (real drafting is slow; instant fakes would flash past it). No effect on the
  // shipped app.
  const fake = new FakeExecutor({
    draft: fakeDraftSeed(),
    ...(process.env["DUGOUT_SEED_CLARIFY"] ? { draftDelayMs: 1200 } : {}),
  });
  const kiro = new KiroDraftAdapter({
    workDir: join(userDataDir, "kiro-work"),
    runKiro: spawnKiroRunner(kiroApiKey ? { apiKey: kiroApiKey } : {}),
  });
  const draftExecutor = process.env["DUGOUT_EXECUTOR"] === "fakes" ? fake : kiro;

  // Live execute: build the spec inside a real Sand Castle (Docker) sandbox with headless kiro and
  // grade harness-side (#7, ADR-0011). Constructing the adapter is side-effect-free — docker() builds
  // a provider config and never contacts the daemon until run() — so it's safe to build even under
  // fakes. The `DUGOUT_EXECUTOR=fakes` path keeps execute fully fake (e2e never touches Docker/kiro).
  const kiroExecute = new KiroExecuteAdapter({
    run: sandcastleRun,
    sandbox: docker({
      imageName: process.env["DUGOUT_SANDBOX_IMAGE"] ?? "dugout-sandbox:local",
      // Our image bakes the `agent` user at uid/gid 1000 (sandbox/Dockerfile). Pin the container to
      // it so Sand Castle's UID preflight — which otherwise expects the host uid — matches the image.
      // Aligning bind-mount ownership across host OSes is part of the deferred image-distribution
      // question (we can't rebuild per-machine yet; see README + onboarding #18).
      containerUid: 1000,
      containerGid: 1000,
    }),
    makeAgent: (apiKey) => kiroExecuteAgent({ apiKey }),
    resolveClonePath: async (repo) => {
      const [declared] = await repoScope.declare([repo]);
      if (!declared || declared.clone.status !== "cloned") {
        throw new Error(`execute mode needs a local clone of "${repo}" (not cloned).`);
      }
      return declared.clone.path;
    },
    ...(kiroApiKey ? { apiKey: kiroApiKey } : {}),
  });
  const executor: ExecutorPort = {
    draft: (input) => draftExecutor.draft(input),
    execute:
      process.env["DUGOUT_EXECUTOR"] === "fakes"
        ? (input) => fake.execute(input)
        : (input) => kiroExecute.execute(input),
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
  return orchestrator;
}

export { broadcast };
