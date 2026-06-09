import { join } from "node:path";
import { readFile } from "node:fs/promises";
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
import { createSandbox } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { KiroExecuteAdapter, REPORT_STDOUT_TAIL_CHARS } from "../core/adapters/kiro-execute-adapter.js";
import { kiroExecuteAgent } from "../core/adapters/kiro-agent-provider.js";
import { readRepoConfig, type Toolchain } from "../core/repo-config.js";
import { JiraCredentialStore, jiraCredentialsFromEnv } from "./jira-credentials.js";
import { notifyNative } from "./notifications.js";
import { KiroCredentialStore, kiroApiKeyFromEnv } from "./kiro-credentials.js";
import type { RunStateStore } from "../core/store/run-state-store.js";
import type { MetricsPort, MetricEvent } from "../core/ports/metrics.js";
import type { LifecyclePort, LifecycleEvent } from "../core/ports/lifecycle.js";
import type { JiraPort } from "../core/ports/jira.js";
import type { DraftOutcome, ExecutorPort, ExecuteInput, ExecuteOutcome } from "../core/ports/executor.js";
import { CHANNELS, type DugoutEvent } from "../shared/dugout-api.js";
import { SEED_TICKET, SEED_DRAFT, SEED_CATALOG } from "./seed.js";

/** Broadcast a telemetry event to every renderer window. */
function broadcast(event: DugoutEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.event, event);
  }
}

/**
 * Metrics sink: a no-op until the real Datadog adapter lands (#13). Metrics must NEVER broadcast to
 * the renderer (#27 de-conflation) — the old MetricsForwarder that did so was a leak, not a feature.
 */
class NoopMetrics implements MetricsPort {
  emit(_event: MetricEvent): void {
    // Intentionally silent: best-effort port kept warm so instrumentation call sites stay exercised.
  }
}

/**
 * Lifecycle port → renderer + OS: stamp the wire time and broadcast to every window (#27), and
 * surface the pass/fail/review-stop transitions as native notifications so the developer can walk
 * away during a run (#14). Both sinks are best-effort.
 */
const lifecycleBroadcaster: LifecyclePort = {
  emit(event: LifecycleEvent): void {
    broadcast({ ...event, at: Date.now() });
    notifyNative(event);
  },
};

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
 * Wrap the fake executor's execute so the e2e can drive the failed → restart-clean recovery path
 * through real Electron IPC. With `DUGOUT_SEED_FAIL` set, the FIRST execute returns `red` (the story
 * fails); the clean restart re-runs every spec to green. Sibling of the `DUGOUT_SEED_CLARIFY` seam —
 * dev/test only, no effect on the shipped app (env unset).
 */
function fakeExecuteSeam(fake: FakeExecutor): (input: ExecuteInput) => Promise<ExecuteOutcome> {
  if (!process.env["DUGOUT_SEED_FAIL"]) return (input) => fake.execute(input);
  let failedOnce = false;
  return (input) => {
    if (!failedOnce) {
      failedOnce = true;
      return Promise.resolve({ result: "red", reason: "seed: simulated red on first attempt (DUGOUT_SEED_FAIL)" });
    }
    return fake.execute(input);
  };
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

  const gitWorkspace = new GitWorkspace({ roots: workspaceRoots() });
  const repoScope = new RepoScope(new GitHubCatalog(github), gitWorkspace);

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
    createSandbox,
    // The Repo config's `toolchain` selects the Dugout-owned kiro+toolchain image (ADR-0015 clause 4;
    // `build:sandbox` targets). Overridable per toolchain for local image iteration.
    sandboxFor: (toolchain: Toolchain, env) =>
      docker({
        imageName:
          process.env[`DUGOUT_SANDBOX_IMAGE_${toolchain.toUpperCase()}`] ?? `dugout-sandbox-${toolchain}:local`,
        // Our images bake the `agent` user at uid/gid 1000 (sandbox/Dockerfile.base). Pin the container
        // to it so Sand Castle's UID preflight — which otherwise expects the host uid — matches the
        // image. Aligning bind-mount ownership across host OSes is part of the deferred
        // image-distribution question (we can't rebuild per-machine yet; see README + onboarding #18).
        containerUid: 1000,
        containerGid: 1000,
        // Inject the build agent's env (KIRO_API_KEY, …) at container launch — Sand Castle does not
        // apply agent env per-exec on the createSandbox path (ADR-0015 / kiro-execute-adapter).
        env,
        // Don't tail-truncate the suite's report off stdout (Sand Castle defaults to 64 KiB).
        maxOutputTailChars: REPORT_STDOUT_TAIL_CHARS,
      }),
    makeAgent: (apiKey) => kiroExecuteAgent({ apiKey }),
    // The clone path (Sand Castle cwd), rescanning once if the cache is stale (ADR-0013). A
    // genuinely-missing clone throws — an operational error the orchestrator unwinds cleanly.
    resolveClonePath: (repo) => repoScope.resolveClonePath(repo),
    // Read the committed `.dugout/config.yaml` off the host clone; a missing/invalid one throws
    // (operational, never red — ADR-0015 clause 4).
    loadConfig: (cwd) => readRepoConfig(cwd, { readFile: (p) => readFile(p, "utf8") }),
    // Re-fork the spec branch clean each run so a restart never resumes a failed attempt (invariant 1).
    clearSpecBranch: (cwd, branch) => gitWorkspace.deleteBranch(cwd, branch),
    ...(kiroApiKey ? { apiKey: kiroApiKey } : {}),
  });
  const fakeExecute = fakeExecuteSeam(fake);
  const executor: ExecutorPort = {
    draft: (input) => draftExecutor.draft(input),
    execute:
      process.env["DUGOUT_EXECUTOR"] === "fakes"
        ? fakeExecute
        : (input) => kiroExecute.execute(input),
  };

  const orchestrator = new Orchestrator({
    jira,
    executor,
    github,
    metrics: new NoopMetrics(),
    lifecycle: lifecycleBroadcaster,
    envReplay: new FakeEnvReplay(),
    specStore: new InMemorySpecStore(),
    store: openRunStateStore(userDataDir),
    repoScope,
    // Seed each spec from the per-repo story branch's HEAD if it exists, else the repo default
    // (ADR-0013). Today the story branch is never materialised, so this is always the default — once
    // #8 creates and accumulates `story/<key>`, the same resolver seeds spec N from the accumulated
    // HEAD with no further change here. Gated by the same fakes seam as `execute`: under
    // `DUGOUT_EXECUTOR=fakes` there is no real clone on disk (e2e), so base resolution must NOT touch
    // the filesystem — it returns a placeholder the fake executor ignores.
    resolveBaseBranch:
      process.env["DUGOUT_EXECUTOR"] === "fakes"
        ? async () => "main"
        : async (repo, storyKey) =>
            gitWorkspace.seedBranch(await repoScope.resolveClonePath(repo), `story/${storyKey}`),
    // Land each green spec branch on the per-repo story branch locally (ADR-0014): create
    // `story/<key>` from the repo default if absent, then `git merge --no-ff` the spec branch, so
    // spec N+1 (seeded from the updated story HEAD above) builds on the accumulated work. Gated by
    // the same fakes seam as `execute`/`resolveBaseBranch`: under `DUGOUT_EXECUTOR=fakes` there is no
    // real clone on disk (e2e), so this must not touch the filesystem — it's a no-op.
    mergeToStoryBranch:
      process.env["DUGOUT_EXECUTOR"] === "fakes"
        ? async () => {}
        : async (repo, storyKey, specId) =>
            gitWorkspace.mergeIntoStoryBranch(await repoScope.resolveClonePath(repo), storyKey, specId),
  });
  return orchestrator;
}

export { broadcast };
