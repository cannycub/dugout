import { describe, it, expect } from "vitest";
import { KiroExecuteAdapter, type KiroExecuteDeps } from "./kiro-execute-adapter.js";
import { AMBIGUITY_TAG } from "./execute-methodology.js";
import type { RepoConfig } from "../repo-config.js";

const baseInput = { specId: "s1", repo: "api", markdown: "# Spec", storyKey: "DUG-1", baseBranch: "main" };

const config: RepoConfig = { testCommand: "npm test", reportFormat: "vitest-json", toolchain: "node" };

/** A vitest `--reporter=json` stdout naming the given failing full-test-names in one file. */
const report = (...failing: string[]) =>
  JSON.stringify({
    testResults: [
      {
        name: "suite.test.ts",
        status: failing.length ? "failed" : "passed",
        assertionResults: failing.map((f) => ({ fullName: f, status: "failed" })),
      },
    ],
  });

const kiroBuilt = `implementing...\n<promise>COMPLETE</promise>`;

interface FakeOpts {
  /** Per-`run()` stdout, in call order: [baseline, build, after]. */
  runs: string[];
  branch?: string;
  config?: RepoConfig;
  loadConfig?: (cwd: string) => Promise<RepoConfig>;
  createThrows?: Error;
}

/** A fake createSandbox seam: a persistent Sandbox whose run() returns scripted stdout per call. */
function fakeDeps(opts: FakeOpts) {
  const runCalls: any[] = [];
  const createCalls: any[] = [];
  const order: string[] = [];
  let closed = 0;
  let i = 0;
  const branch = opts.branch ?? "spec/DUG-1/s1";
  const sandbox = {
    branch,
    worktreePath: "/wt",
    run: async (o: any) => {
      runCalls.push(o);
      order.push("run");
      return { stdout: opts.runs[i++] ?? "", iterations: [], commits: [] };
    },
    interactive: async () => ({ commits: [], exitCode: 0 }),
    close: async () => {
      closed++;
      order.push("close");
    },
    [Symbol.asyncDispose]: async () => {},
  };
  const deps: KiroExecuteDeps = {
    createSandbox: (async (o: any) => {
      createCalls.push(o);
      order.push("create");
      if (opts.createThrows) throw opts.createThrows;
      return sandbox;
    }) as any,
    sandboxFor: (toolchain, env) => ({ __image: toolchain, __env: env }) as any,
    makeAgent: () => ({ name: "kiro", env: { KIRO_API_KEY: "k-test" } }) as any,
    resolveClonePath: async () => "/ws/api",
    loadConfig: opts.loadConfig ?? (async () => opts.config ?? config),
    clearSpecBranch: async () => {
      order.push("clear");
    },
    apiKey: "k-test",
  };
  return { deps, runCalls, createCalls, order, closed: () => closed };
}

describe("KiroExecuteAdapter", () => {
  it("grades green and returns the branch when the after-suite adds no failure over baseline", async () => {
    const f = fakeDeps({ runs: [report("pre"), kiroBuilt, report("pre")] });
    const out = await new KiroExecuteAdapter(f.deps).execute(baseInput);
    expect(out).toEqual({ result: "green", branch: "spec/DUG-1/s1" });
    // The persistent sandbox is forked on the spec branch from the orchestrator-supplied baseBranch,
    // in the toolchain image, anchored at the clone cwd.
    expect(f.createCalls[0]).toMatchObject({
      branch: "spec/DUG-1/s1",
      baseBranch: "main",
      cwd: "/ws/api",
      // The build agent's env (KIRO_API_KEY) must reach the container via the sandbox provider — Sand
      // Castle does not apply agent env per-exec on the createSandbox path.
      sandbox: { __image: "node", __env: { KIRO_API_KEY: "k-test" } },
    });
    // baseline → build → after = three runs against the one sandbox.
    expect(f.runCalls).toHaveLength(3);
  });

  it("awaits an async sandboxFor — image resolution may consult the docker CLI (#37)", async () => {
    const f = fakeDeps({ runs: [report("pre"), kiroBuilt, report("pre")] });
    f.deps.sandboxFor = async (toolchain, env) => ({ __image: `resolved-${toolchain}`, __env: env }) as any;
    const out = await new KiroExecuteAdapter(f.deps).execute(baseInput);
    expect(out).toEqual({ result: "green", branch: "spec/DUG-1/s1" });
    expect(f.createCalls[0]).toMatchObject({ sandbox: { __image: "resolved-node" } });
  });

  it("clears the spec branch before createSandbox so a restart re-forks clean (invariant 1)", async () => {
    const f = fakeDeps({ runs: [report(), kiroBuilt, report()] });
    await new KiroExecuteAdapter(f.deps).execute(baseInput);
    expect(f.order.slice(0, 2)).toEqual(["clear", "create"]);
  });

  it("grades red naming the new failure the build introduced", async () => {
    const f = fakeDeps({ runs: [report(), kiroBuilt, report("regression")] });
    const out = await new KiroExecuteAdapter(f.deps).execute(baseInput);
    expect(out.result).toBe("red");
    expect(out.result === "red" && out.reason).toMatch(/regression/);
  });

  it("short-circuits to ambiguous when kiro ends on the ambiguity tag — and SKIPS the after-run", async () => {
    const build = `thinking...\n<${AMBIGUITY_TAG}>which auth scheme?</${AMBIGUITY_TAG}>`;
    const f = fakeDeps({ runs: [report(), build /* no after-run */] });
    const out = await new KiroExecuteAdapter(f.deps).execute(baseInput);
    expect(out).toEqual({ result: "ambiguous", reason: "which auth scheme?" });
    expect(f.runCalls).toHaveLength(2); // baseline + build only; no after-suite
  });

  it("proceeds (last control tag wins) when an ambiguity tag is echoed but the build then COMPLETES", async () => {
    const build = `<${AMBIGUITY_TAG}>one-line reason</${AMBIGUITY_TAG}>\n...work...\n<promise>COMPLETE</promise>`;
    const f = fakeDeps({ runs: [report(), build, report()] });
    const out = await new KiroExecuteAdapter(f.deps).execute(baseInput);
    expect(out).toEqual({ result: "green", branch: "spec/DUG-1/s1" });
    expect(f.runCalls).toHaveLength(3);
  });

  it("treats a present-but-empty ambiguity tag (no completion) as ambiguous with a fallback reason", async () => {
    const f = fakeDeps({ runs: [report(), `<${AMBIGUITY_TAG}></${AMBIGUITY_TAG}>`] });
    const out = await new KiroExecuteAdapter(f.deps).execute(baseInput);
    expect(out.result).toBe("ambiguous");
    expect(out.result === "ambiguous" && out.reason.length).toBeGreaterThan(0);
  });

  it("grades through ANSI escapes in the command-runner report (#8352)", async () => {
    const ansi = `[32m${report("pre")}[0m`;
    const f = fakeDeps({ runs: [ansi, kiroBuilt, ansi] });
    const out = await new KiroExecuteAdapter(f.deps).execute(baseInput);
    expect(out).toEqual({ result: "green", branch: "spec/DUG-1/s1" });
  });

  it("THROWS (operational, not red) when a command-runner run yields no parseable report", async () => {
    // ADR-0015 clause 6 inverts ADR-0012: the harness authors the report now, so absence means the
    // harness could not run the suite (bad command/toolchain) — an environment error, not a spec red.
    const f = fakeDeps({ runs: [report(), kiroBuilt, "command not found"] });
    await expect(new KiroExecuteAdapter(f.deps).execute(baseInput)).rejects.toThrow(/report/i);
  });

  it("rethrows operational failures (createSandbox throws) — not a spec outcome", async () => {
    const f = fakeDeps({ runs: [], createThrows: new Error("docker daemon not reachable") });
    await expect(new KiroExecuteAdapter(f.deps).execute(baseInput)).rejects.toThrow(/docker/i);
  });

  it("rethrows when the Repo config is missing/invalid (operational, fix-it)", async () => {
    const f = fakeDeps({
      runs: [],
      loadConfig: async () => {
        throw new Error(".dugout/config.yaml not found");
      },
    });
    await expect(new KiroExecuteAdapter(f.deps).execute(baseInput)).rejects.toThrow(/config\.yaml/);
  });

  it("selects the parser by the Repo config's reportFormat (trx)", async () => {
    const trx = (outcome: string) => `<TestRun><Results>
      <UnitTestResult testId="g1" outcome="${outcome}" />
    </Results><TestDefinitions>
      <UnitTest id="g1"><TestMethod className="N.C, A" name="M" /></UnitTest>
    </TestDefinitions></TestRun>`;
    const f = fakeDeps({
      runs: [trx("Passed"), kiroBuilt, trx("Failed")],
      config: { testCommand: "dotnet test", reportFormat: "trx", toolchain: "dotnet" },
    });
    const out = await new KiroExecuteAdapter(f.deps).execute(baseInput);
    expect(out.result).toBe("red");
    expect(out.result === "red" && out.reason).toMatch(/N\.C\.M/);
  });

  it("always closes the sandbox, even on a red grade", async () => {
    const f = fakeDeps({ runs: [report(), kiroBuilt, report("regression")] });
    await new KiroExecuteAdapter(f.deps).execute(baseInput);
    expect(f.closed()).toBe(1);
    expect(f.order[f.order.length - 1]).toBe("close");
  });
});
