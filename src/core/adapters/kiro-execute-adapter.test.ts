import { describe, it, expect } from "vitest";
import { KiroExecuteAdapter } from "./kiro-execute-adapter.js";
import { TEST_REPORT_TAG, AMBIGUITY_TAG } from "./execute-methodology.js";
import type { SandcastleRun } from "./sandcastle.js";

const baseInput = { specId: "s1", repo: "api", markdown: "# Spec", storyBranch: "dugout/DUG-1/api" };

/** A fake run() returning a canned RunResult; records the options it was called with. */
function fakeRun(result: any): { run: SandcastleRun; calls: any[] } {
  const calls: any[] = [];
  const run = (async (opts: any) => {
    calls.push(opts);
    return result;
  }) as unknown as SandcastleRun;
  return { run, calls };
}

const deps = (run: SandcastleRun) => ({
  run,
  sandbox: { __fake: "sandbox" } as any,
  makeAgent: () => ({ name: "kiro" }) as any,
  resolveClonePath: async (_repo: string) => "/ws/api",
});

/** kiro prints the report INTO stdout (we don't use Sandcastle's Output extraction — spike note). */
const reportStdout = (baselineFailures: string[], afterFailures: string[]) =>
  `building...\n<${TEST_REPORT_TAG}>${JSON.stringify({ baselineFailures, afterFailures })}</${TEST_REPORT_TAG}>\n<promise>COMPLETE</promise>`;

describe("KiroExecuteAdapter", () => {
  it("returns green with the produced branch when the report shows no new failures", async () => {
    const { run, calls } = fakeRun({
      branch: "dugout/DUG-1/api/s1",
      commits: [{ sha: "abc" }],
      stdout: reportStdout(["x"], ["x"]),
    });
    const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
    expect(out).toEqual({ result: "green", branch: "dugout/DUG-1/api/s1" });
    // seeds from the story branch, cwd is the resolved clone, branch strategy names the spec branch
    expect(calls[0].cwd).toBe("/ws/api");
    expect(calls[0].branchStrategy).toEqual({ type: "branch", branch: "dugout/DUG-1/api/s1" });
  });

  it("returns red when the report shows a new failure", async () => {
    const { run } = fakeRun({ branch: "b", commits: [], stdout: reportStdout([], ["new-test"]) });
    const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
    expect(out.result).toBe("red");
    expect(out.result === "red" && out.reason).toMatch(/new-test/);
  });

  it("returns ambiguous when kiro emitted the ambiguity marker (no grading)", async () => {
    const { run } = fakeRun({
      branch: "b",
      commits: [],
      stdout: `thinking...\n<${AMBIGUITY_TAG}>which auth scheme?</${AMBIGUITY_TAG}>\n`,
    });
    const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
    expect(out).toEqual({ result: "ambiguous", reason: "which auth scheme?" });
  });

  it("returns red when the report is missing/unparseable", async () => {
    const { run } = fakeRun({ branch: "b", commits: [], stdout: "no report here" });
    const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
    expect(out.result).toBe("red");
    expect(out.result === "red" && out.reason).toMatch(/report/i);
  });

  it("rethrows operational failures (run() throws) — not a spec outcome", async () => {
    const run = (async () => {
      throw new Error("docker daemon not reachable");
    }) as unknown as SandcastleRun;
    await expect(new KiroExecuteAdapter(deps(run)).execute(baseInput)).rejects.toThrow(/docker/i);
  });
});
