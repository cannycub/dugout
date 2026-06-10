import type { SandboxProvider, AgentProvider } from "@ai-hero/sandcastle";
import type { ExecuteInput, ExecuteOutcome } from "../ports/executor.js";
import type { CreateSandbox } from "./sandcastle.js";
import { gradeExecuteRuns } from "../grade-execute.js";
import { reportParserFor } from "../report-parser.js";
import type { RepoConfig, Toolchain } from "../repo-config.js";
import { commandRunnerAgent } from "./command-runner-agent.js";
import { executeMethodology, AMBIGUITY_TAG, COMPLETION_TAG } from "./execute-methodology.js";
import { stripAnsi } from "./kiro-runner.js";

/** Idle window for the command-runner suite runs. A cold `npm install`/`dotnet restore` or a slow,
 *  buffered compile can be silent past Sand Castle's 600s default and would otherwise throw. */
export const COMMAND_RUNNER_IDLE_TIMEOUT_SECONDS = 1800;

/**
 * Max stdout retained per run, passed to the sandbox provider (`docker({ maxOutputTailChars })`).
 * Sand Castle tail-bounds exec stdout (default 64 KiB), which would head-truncate a large suite's
 * JSON/TRX report — evicting its opening `{`/`<TestRun>` token so the `ReportParser` can't find the
 * report and throws operational on every big repo. The full report must reach the host, so the
 * provider must raise this. 64 MiB is far above any realistic report yet well under V8's string cap.
 */
export const REPORT_STDOUT_TAIL_CHARS = 64 * 1024 * 1024;

export interface KiroExecuteDeps {
  /** Injected Sandcastle createSandbox() — the test seam (ADR-0015 clause 2). */
  createSandbox: CreateSandbox;
  /**
   * The sandbox provider for a toolchain — selects the Dugout-owned kiro+toolchain image — with the
   * build agent's env injected into the *container* (`docker({ env })`). Sand Castle applies an
   * `AgentProvider`'s `env` only on the top-level `run()` path; the persistent `createSandbox()`
   * handle starts the container once with an empty agent env and never re-applies it per exec (it
   * execs into the running container). So the build agent's secrets — kiro's `KIRO_API_KEY` — must
   * ride the sandbox provider's launch env to reach kiro at all.
   *
   * May be async: the docker wiring resolves the toolchain image tag to its immutable ID first,
   * which shells out to the docker CLI (stale-tag immunity, #37).
   */
  sandboxFor: (
    toolchain: Toolchain,
    env: Record<string, string>,
  ) => SandboxProvider | Promise<SandboxProvider>;
  /** Build the kiro *build* agent provider, given the api key resolved at call time. */
  makeAgent: (apiKey: string) => AgentProvider;
  /** Resolve a declared repo name to its local clone path (Sandcastle cwd). */
  resolveClonePath: (repo: string) => Promise<string>;
  /** Read + validate the repo's `.dugout/config.yaml` (testCommand/reportFormat/toolchain). */
  loadConfig: (cwd: string) => Promise<RepoConfig>;
  /**
   * Remove the spec branch from the clone if it exists (pruning any pinned worktree first), so Sand
   * Castle re-forks it clean from `baseBranch`. Called before createSandbox: Sand Castle ignores
   * `baseBranch` when the branch already exists, which would resume a failed attempt's commits rather
   * than restart clean (invariant 1; ADR-0013).
   */
  clearSpecBranch: (cwd: string, branch: string) => Promise<void>;
  /** kiro api key source; defaults to process.env.KIRO_API_KEY. */
  apiKey?: string;
}

/** All `<tag>…</tag>` bodies in `stdout`, in order, with the index they appear at. */
function tagOccurrences(stdout: string, tag: string): Array<{ index: number; body: string }> {
  return [...stdout.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => ({
    index: m.index ?? 0,
    body: m[1]!.trim(),
  }));
}

/**
 * kiro's build-run disambiguation (ADR-0015 clause 6). kiro now builds only — it emits no report —
 * so the sole control tags are `<dugout-ambiguous>` (it refused to guess) and the COMPLETION tag (it
 * finished). Either may be **echoed** from the prompt template mid-narration, so neither is a signal
 * on its own; the *last control tag wins*. kiro is ambiguous iff its final control tag is an
 * ambiguity tag — i.e. it ended by refusing — never when it ended on completion. Returns the
 * ambiguity reason (or undefined when kiro proceeded).
 */
function ambiguityReason(stdout: string): string | undefined {
  const ambiguities = tagOccurrences(stdout, AMBIGUITY_TAG);
  if (ambiguities.length === 0) return undefined;
  const lastAmbiguity = ambiguities[ambiguities.length - 1]!;
  const completions = tagOccurrences(stdout, COMPLETION_TAG);
  const lastCompletion = completions[completions.length - 1];
  if (lastCompletion && lastCompletion.index > lastAmbiguity.index) return undefined; // ended on completion
  return lastAmbiguity.body || "kiro flagged ambiguity without a reason";
}

/**
 * Execute mode adapter (ADR-0011, ADR-0015). Creates one persistent Sand Castle sandbox and brackets
 * kiro's build with two harness-run suite passes — baseline → build → after — then grades the diff
 * host-side. kiro never authors the grade inputs (invariant 8).
 */
export class KiroExecuteAdapter {
  constructor(private readonly deps: KiroExecuteDeps) {}

  async execute(input: ExecuteInput): Promise<ExecuteOutcome> {
    const apiKey = this.deps.apiKey ?? process.env["KIRO_API_KEY"];
    if (!apiKey) {
      throw new Error("execute mode needs KIRO_API_KEY (kiro.dev/docs/cli/headless).");
    }
    const cwd = await this.deps.resolveClonePath(input.repo);

    // The Repo config supplies the test command, the parser discriminant, and the image selector. A
    // missing/invalid config throws (operational) — a misconfigured repo fails loudly, never red.
    const config = await this.deps.loadConfig(cwd);

    // Spec branch is a sibling of the story branch (`spec/<key>/<specId>` vs `story/<key>`), never
    // nested under it — git stores refs as files, so a nested name would D/F-collide with the story
    // branch ref once #8 materialises it (ADR-0013).
    const specBranch = `spec/${input.storyKey}/${input.specId}`;

    // Re-fork the spec branch clean every run: delete any leftover from a failed attempt so Sand
    // Castle creates it anew from baseBranch (it ignores baseBranch when the branch exists). A retry
    // therefore restarts, never resumes (invariant 1; ADR-0013).
    await this.deps.clearSpecBranch(cwd, specBranch);

    // createSandbox throwing is an operational failure (sandbox/docker/kiro infra) — let it propagate.
    // The orchestrator resolves `baseBranch` (story HEAD if it exists, else the repo default), so the
    // seed is deterministic and accumulates onto the story branch once #8 lands (ADR-0013).
    // Build the kiro agent up front so its declared env (KIRO_API_KEY, NO_COLOR…) can be injected into
    // the container at launch — Sand Castle won't apply it per-exec on the createSandbox path (see
    // sandboxFor). The same key is harmlessly present for the command-runner suite runs.
    const buildAgent = this.deps.makeAgent(apiKey);
    const sandbox = await this.deps.createSandbox({
      branch: specBranch,
      baseBranch: input.baseBranch,
      sandbox: await this.deps.sandboxFor(config.toolchain, buildAgent.env),
      cwd,
    });
    try {
      const runner = commandRunnerAgent(config.testCommand);
      // A suite run can be legitimately silent for a long stretch — a cold `npm install` / `dotnet
      // restore`, or a slow compile with buffered output — which would trip Sand Castle's default
      // 600s idle timeout and turn a valid grade into an operational throw. Give the command-runner
      // runs a generous idle window; kiro's build run streams continuously, so it keeps the default.
      const suiteRun = { agent: runner, prompt: config.testCommand, idleTimeoutSeconds: COMMAND_RUNNER_IDLE_TIMEOUT_SECONDS };

      // 1) Baseline: the full suite on the seed, before any change (pre-existing reds — invariant 8).
      const baseline = await sandbox.run(suiteRun);

      // 2) Build: kiro implements the spec test-first. It may refuse on a genuine ambiguity.
      const build = await sandbox.run({
        agent: buildAgent,
        prompt: executeMethodology({ markdown: input.markdown, specId: input.specId }),
      });
      // kiro emits ANSI even with NO_COLOR when piped (#8352) — strip before tag parsing.
      const reason = ambiguityReason(stripAnsi(build.stdout ?? ""));
      if (reason !== undefined) {
        // Genuine ambiguity short-circuits: skip the after-run, return for a clean restart (inv. 1).
        return { result: "ambiguous", reason };
      }

      // 3) After: the full suite again. The harness grades the diff — an unparseable report from
      //    either suite run means the harness could not run the suite and throws (operational, not
      //    red; ADR-0015 clause 6).
      const after = await sandbox.run(suiteRun);
      const parser = reportParserFor(config.reportFormat);
      const graded = gradeExecuteRuns(parser, stripAnsi(baseline.stdout ?? ""), stripAnsi(after.stdout ?? ""));
      return graded.result === "green" ? { result: "green", branch: sandbox.branch } : graded;
    } finally {
      // Always tear the sandbox down — even on red/ambiguous/throw — so a restart re-forks clean.
      await sandbox.close();
    }
  }
}
