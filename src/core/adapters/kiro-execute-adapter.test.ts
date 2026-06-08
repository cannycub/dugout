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

  it("grades green when the report JSON carries ANSI escapes (kiro emits them even with NO_COLOR)", async () => {
    // kiro still emits ANSI when piped (#8352); the draft path strips it, the execute path must too.
    const body = JSON.stringify({ baselineFailures: ["x"], afterFailures: ["x"] });
    const stdout = `building...\n<${TEST_REPORT_TAG}>[32m${body}[0m</${TEST_REPORT_TAG}>\n`;
    const { run } = fakeRun({ branch: "b", commits: [], stdout });
    const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
    expect(out).toEqual({ result: "green", branch: "b" });
  });

  it("grades green when the report JSON is wrapped in a ```json code fence", async () => {
    const body = JSON.stringify({ baselineFailures: [], afterFailures: [] });
    const stdout = `<${TEST_REPORT_TAG}>\`\`\`json\n${body}\n\`\`\`</${TEST_REPORT_TAG}>`;
    const { run } = fakeRun({ branch: "b", commits: [], stdout });
    const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
    expect(out).toEqual({ result: "green", branch: "b" });
  });

  it("uses the LAST valid report when kiro echoed the prompt's template earlier", async () => {
    // The methodology prompt embeds a literal <dugout-test-report>{...[...]...}</…> template; if kiro
    // narrates it before emitting the real report, the real (last, valid) one must win.
    const echoed = `<${TEST_REPORT_TAG}>{"baselineFailures":[...],"afterFailures":[...]}</${TEST_REPORT_TAG}>`;
    const real = `<${TEST_REPORT_TAG}>${JSON.stringify({ baselineFailures: [], afterFailures: ["c"] })}</${TEST_REPORT_TAG}>`;
    const { run } = fakeRun({ branch: "b", commits: [], stdout: `${echoed}\n...work...\n${real}\n` });
    const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
    expect(out.result).toBe("red");
    expect(out.result === "red" && out.reason).toMatch(/c/);
  });

  it("grades the report even when an ambiguity tag is also present (report-first: kiro proceeded)", async () => {
    const body = JSON.stringify({ baselineFailures: [], afterFailures: [] });
    const stdout = `<${AMBIGUITY_TAG}>echoed instruction</${AMBIGUITY_TAG}>\n<${TEST_REPORT_TAG}>${body}</${TEST_REPORT_TAG}>`;
    const { run } = fakeRun({ branch: "b", commits: [], stdout });
    const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
    expect(out).toEqual({ result: "green", branch: "b" });
  });

  it("treats a present-but-empty ambiguity tag as ambiguous (with a fallback reason), not red", async () => {
    const { run } = fakeRun({ branch: "b", commits: [], stdout: `<${AMBIGUITY_TAG}></${AMBIGUITY_TAG}>\n` });
    const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
    expect(out.result).toBe("ambiguous");
    expect(out.result === "ambiguous" && out.reason.length).toBeGreaterThan(0);
  });

  it("grades red when a report failure id is not a string", async () => {
    const stdout = `<${TEST_REPORT_TAG}>{"baselineFailures":[],"afterFailures":[{"name":"t"}]}</${TEST_REPORT_TAG}>`;
    const { run } = fakeRun({ branch: "b", commits: [], stdout });
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
