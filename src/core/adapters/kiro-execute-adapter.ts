import type { ExecuteInput, ExecuteOutcome } from "../ports/executor.js";
import type { SandcastleRun } from "./sandcastle.js";
import { gradeExecute, type DugoutTestReport } from "../grade-execute.js";
import { executeMethodology, TEST_REPORT_TAG, AMBIGUITY_TAG } from "./execute-methodology.js";

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
  /** kiro api key source; defaults to process.env.KIRO_API_KEY. */
  apiKey?: string;
}

/** Extract the trimmed contents of the first `<tag>…</tag>` in `stdout`, or undefined if absent. */
const tagContent = (stdout: string, tag: string): string | undefined => {
  const m = stdout.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1]!.trim() : undefined;
};

/**
 * Parse the `<dugout-test-report>` JSON out of stdout. We deliberately do NOT use Sandcastle's
 * `Output.object` extraction: a missing/invalid tag makes run() throw `StructuredOutputError` (which
 * carries no stdout), so an ambiguous run — which emits `<dugout-ambiguous>` and no report — would
 * throw and lose the reason. Parsing stdout ourselves keeps every outcome on one source and makes a
 * missing report a normal red, not an exception (Task 0 spike, divergence 1). Returns undefined when
 * the tag is absent or unparseable — both grade as red.
 */
const parseTestReport = (stdout: string): DugoutTestReport | undefined => {
  const raw = tagContent(stdout, TEST_REPORT_TAG);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const r = parsed as Partial<DugoutTestReport>;
    if (Array.isArray(r.baselineFailures) && Array.isArray(r.afterFailures)) {
      return { baselineFailures: r.baselineFailures, afterFailures: r.afterFailures };
    }
  } catch {
    // Unparseable tag is treated as a missing report (red) — no evidence of green (invariant 8).
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
    const specBranch = `${input.storyBranch}/${input.specId}`;

    // run() throwing is an operational failure (sandbox/docker/kiro infra) — let it propagate.
    const result = await this.deps.run({
      agent: this.deps.makeAgent(apiKey),
      sandbox: this.deps.sandbox,
      cwd,
      prompt: executeMethodology({ markdown: input.markdown }),
      branchStrategy: { type: "branch", branch: specBranch },
    } as never);

    const stdout = String(result.stdout ?? "");

    // 1) Ambiguity short-circuits before grading (invariant 1).
    const ambiguous = tagContent(stdout, AMBIGUITY_TAG);
    if (ambiguous) return { result: "ambiguous", reason: ambiguous };

    // 2) Grade the structured report parsed from stdout; missing/unparseable ⇒ red (no evidence of
    //    green — invariant 8).
    const report = parseTestReport(stdout);
    if (!report) {
      return { result: "red", reason: "kiro produced no parseable test report" };
    }
    const graded = gradeExecute(report);
    return graded.result === "green" ? { result: "green", branch: result.branch } : graded;
  }
}
