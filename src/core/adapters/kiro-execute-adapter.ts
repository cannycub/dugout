import type { ExecuteInput, ExecuteOutcome } from "../ports/executor.js";
import type { SandcastleRun } from "./sandcastle.js";
import { gradeExecute, type DugoutTestReport } from "../grade-execute.js";
import { executeMethodology, TEST_REPORT_TAG, AMBIGUITY_TAG } from "./execute-methodology.js";
import { stripAnsi } from "./kiro-runner.js";

/** Minimal shapes we depend on from Sandcastle; widen against the spike notes if needed. */
type SandboxProvider = unknown;
type AgentProvider = unknown;

export interface KiroExecuteDeps {
  /** Injected Sandcastle run() — the test seam. */
  run: SandcastleRun;
  /** The sandbox provider (docker()/vercel()/custom) — config, not our code. */
  sandbox: SandboxProvider;
  /** Build the kiro agent provider, given the api key resolved at call time. */
  makeAgent: (apiKey: string) => AgentProvider;
  /** Resolve a declared repo name to its local clone path (Sandcastle cwd). */
  resolveClonePath: (repo: string) => Promise<string>;
  /**
   * Remove the spec branch from the clone if it exists (pruning any pinned worktree first), so Sand
   * Castle re-forks it clean from `baseBranch`. Called before every run: Sand Castle ignores
   * `baseBranch` when the branch already exists, which would resume a failed attempt's commits rather
   * than restart clean (invariant 1; ADR-0013).
   */
  clearSpecBranch: (cwd: string, branch: string) => Promise<void>;
  /** kiro api key source; defaults to process.env.KIRO_API_KEY. */
  apiKey?: string;
}

/** All `<tag>…</tag>` bodies in `stdout`, in order, trimmed (kiro narration can repeat a tag). */
const tagContents = (stdout: string, tag: string): string[] =>
  [...stdout.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]!.trim());

/** The LAST `<tag>…</tag>` body, or undefined if the tag never appears. Last-wins because kiro may
 *  echo the prompt's literal tag template while narrating before emitting the real, final one. */
const lastTagContent = (stdout: string, tag: string): string | undefined => {
  const all = tagContents(stdout, tag);
  return all.length ? all[all.length - 1] : undefined;
};

/** Strip a ```/```json code fence kiro may wrap the JSON in (LLMs do this); no-op otherwise. */
const unwrapFence = (s: string): string => {
  const m = s.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return m ? m[1]!.trim() : s;
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Parse the `<dugout-test-report>` JSON out of stdout. We deliberately do NOT use Sandcastle's
 * `Output.object` extraction: a missing/invalid tag makes run() throw `StructuredOutputError` (which
 * carries no stdout), so an ambiguous run — which emits `<dugout-ambiguous>` and no report — would
 * throw and lose the reason. Parsing stdout ourselves keeps every outcome on one source and makes a
 * missing report a normal red, not an exception (Task 0 spike, divergence 1).
 *
 * Robust against real kiro output (the agent test surfaced these): scans for the LAST *valid* report
 * (kiro may echo the prompt's `…[...]…` template, which is invalid JSON, before the real one),
 * tolerates a ```json fence, and requires both lists to be arrays *of strings* — a non-string id
 * would silently corrupt the Set-membership grade. Returns undefined when no valid report is present.
 */
const parseTestReport = (stdout: string): DugoutTestReport | undefined => {
  const raws = tagContents(stdout, TEST_REPORT_TAG);
  for (let i = raws.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(unwrapFence(raws[i]!)) as Partial<DugoutTestReport>;
      if (isStringArray(r.baselineFailures) && isStringArray(r.afterFailures)) {
        return { baselineFailures: r.baselineFailures, afterFailures: r.afterFailures };
      }
    } catch {
      // Invalid JSON (e.g. the echoed `[...]` template) — keep scanning earlier tags.
    }
  }
  return undefined;
};

/** Execute mode adapter: wraps Sandcastle's run() and grades the result (ADR-0011). */
export class KiroExecuteAdapter {
  constructor(private readonly deps: KiroExecuteDeps) {}

  async execute(input: ExecuteInput): Promise<ExecuteOutcome> {
    const apiKey = this.deps.apiKey ?? process.env["KIRO_API_KEY"];
    if (!apiKey) {
      throw new Error("execute mode needs KIRO_API_KEY (kiro.dev/docs/cli/headless).");
    }
    const cwd = await this.deps.resolveClonePath(input.repo);
    // Spec branch is a sibling of the story branch (`spec/<key>/<specId>` vs `story/<key>`), never
    // nested under it — git stores refs as files, so a nested name would D/F-collide with the story
    // branch ref once #8 materialises it (ADR-0013).
    const specBranch = `spec/${input.storyKey}/${input.specId}`;

    // Re-fork the spec branch clean every run: delete any leftover from a failed attempt so Sand
    // Castle creates it anew from baseBranch (it ignores baseBranch when the branch exists). A retry
    // therefore restarts, never resumes (invariant 1; ADR-0013).
    await this.deps.clearSpecBranch(cwd, specBranch);

    // run() throwing is an operational failure (sandbox/docker/kiro infra) — let it propagate.
    // The orchestrator resolves `baseBranch` (story HEAD if it exists, else the repo default), so the
    // seed is deterministic and accumulates onto the story branch once #8 lands — without changing
    // this adapter (ADR-0013).
    const result = await this.deps.run({
      agent: this.deps.makeAgent(apiKey),
      sandbox: this.deps.sandbox,
      cwd,
      prompt: executeMethodology({ markdown: input.markdown }),
      branchStrategy: { type: "branch", branch: specBranch, baseBranch: input.baseBranch },
    } as never);

    // kiro emits ANSI even with NO_COLOR when piped (#8352, as the draft runner documents), which
    // would otherwise break tag/JSON parsing — strip it once up front, like the draft path.
    const stdout = stripAnsi(String(result.stdout ?? ""));

    // 1) A valid report means kiro PROCEEDED (it ran the suite and reported) — grade it, even if an
    //    ambiguity tag is also present (an echoed instruction, not a refusal). A genuine ambiguity
    //    means kiro stopped *without* a report, so report-first never grades a real refusal and keeps
    //    invariant 1 intact while neutralising the prompt-echo footgun.
    const report = parseTestReport(stdout);
    if (report) {
      const graded = gradeExecute(report);
      return graded.result === "green" ? { result: "green", branch: result.branch } : graded;
    }

    // 2) No report: a present ambiguity tag means kiro refused to guess (invariant 1). A present-but-
    //    empty tag still signals refusal — surface it with a fallback reason rather than misgrading red.
    const ambiguous = lastTagContent(stdout, AMBIGUITY_TAG);
    if (ambiguous !== undefined) {
      return { result: "ambiguous", reason: ambiguous || "kiro flagged ambiguity without a reason" };
    }

    // 3) Neither a valid report nor an ambiguity signal ⇒ red (no evidence of green — invariant 8).
    return { result: "red", reason: "kiro produced no parseable test report" };
  }
}
