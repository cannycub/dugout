import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir, realpath, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createSandbox } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { KiroExecuteAdapter, REPORT_STDOUT_TAIL_CHARS } from "./kiro-execute-adapter.js";
import { kiroExecuteAgent } from "./kiro-agent-provider.js";
import { readRepoConfig, type Toolchain } from "../repo-config.js";
import { GitWorkspace } from "./git-workspace.js";

const sh = promisify(execFile);

/**
 * Tier 3 — execute-mode agent integration against REAL kiro in a REAL Sand Castle (Docker) sandbox
 * (CLAUDE.md testing pyramid; #7, #33). Structurally excluded from `npm test` / CI (it's a
 * `*.agent.test.ts` file). Run with:
 *
 *   npm run build:sandbox      # build the node + dotnet images first (#37: refreshes stale tags)
 *   npm run test:agent         # needs KIRO_API_KEY and a reachable Docker daemon
 *
 * Prerequisites FAIL LOUDLY, never skip — a skip reports green and gives false confidence the agent
 * was tested. This is the only tier that proves the real pipeline end to end: the harness runs the
 * suite as a command before and after kiro's build (command-runner through Sand Castle's run() seam),
 * kiro builds the spec, and the adapter parses the two reporter stdouts and grades the diff host-side
 * (ADR-0015 — harness-observed grading).
 *
 * The #33 acceptance criterion is the **red-stays-red** proof: a build that leaves a genuinely-still-
 * failing test grades `red` despite kiro narrating success (COMPLETE). Proven for BOTH toolchains —
 * TS/vitest (vitest-json) and C#/dotnet (trx) — because kiro never authors the grade; the harness
 * witnesses the suite itself (invariant 8).
 */
const KIRO_API_KEY = process.env["KIRO_API_KEY"];

/** A throwaway git repo seeded with the given files, committed on `main`. */
async function makeRepo(prefix: string, files: Record<string, string>): Promise<string> {
  // realpath() is essential on macOS: tmpdir() is under /var (a symlink to /private/var), but git
  // records the worktree's gitdir as the canonical /private/var path. Sand Castle bind-mounts the git
  // dir at the path we hand it, so a non-canonical path leaves the in-container gitdir reference
  // unmounted ("not a git repository"). Pass the resolved path so the mounts line up.
  const clone = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await sh("git", ["init", "-q", "-b", "main"], { cwd: clone });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(clone, rel)), { recursive: true });
    await writeFile(join(clone, rel), content);
  }
  await sh("git", ["add", "-A"], { cwd: clone });
  await sh("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: clone });
  return clone;
}

/** The execute adapter wired exactly like production (orchestrator-host), against the real image. */
function makeAdapter(clone: string) {
  return new KiroExecuteAdapter({
    createSandbox,
    // containerUid/Gid pinned to the image's baked `agent` uid (sandbox/Dockerfile.base), matching the
    // live wiring — Sand Castle's UID preflight otherwise expects the host uid and rejects.
    sandboxFor: (toolchain: Toolchain, env) =>
      docker({
        imageName: `dugout-sandbox-${toolchain}:local`,
        containerUid: 1000,
        containerGid: 1000,
        env,
        maxOutputTailChars: REPORT_STDOUT_TAIL_CHARS,
      }),
    makeAgent: (apiKey) => kiroExecuteAgent({ apiKey }),
    resolveClonePath: async () => clone,
    loadConfig: (cwd) => readRepoConfig(cwd, { readFile: (p) => readFile(p, "utf8") }),
    // Real clean-restart: prune+delete the spec branch in the clone so Sand Castle re-forks it
    // fresh — exactly the production wiring (orchestrator-host) uses (ADR-0013).
    clearSpecBranch: (cwd, branch) => new GitWorkspace({ roots: [] }).deleteBranch(cwd, branch),
  });
}

beforeAll(async () => {
  if (!KIRO_API_KEY) {
    throw new Error(
      "execute agent suite needs KIRO_API_KEY (kiro.dev/docs/cli/headless). Run via " +
        "`npm run test:agent` with the key, a running Docker daemon, and the dugout-sandbox images.",
    );
  }
  await sh("docker", ["info"]).catch(() => {
    throw new Error(
      "execute agent suite needs a reachable Docker daemon (real sandcastle.run()). Start Docker " +
        "and build the images: `npm run build:sandbox`.",
    );
  });
}, 120_000);

// ── TypeScript / vitest (vitest-json) ───────────────────────────────────────────────────────────
// A repo carrying vitest as a devDependency and a passing smoke test (so the baseline run yields a
// valid, empty-failure report). testCommand installs deps then prints the vitest-json report to
// stdout; the command-runner forces exit 0, so a failing suite still reports rather than throwing.
const tsRepo = (extra: Record<string, string>) => ({
  "package.json": JSON.stringify({
    name: "ts-fixture",
    type: "module",
    devDependencies: { vitest: "^4.1.8" },
  }),
  ".dugout/config.yaml":
    "testCommand: npm install --silent --no-audit --no-fund >/dev/null 2>&1 && npx vitest run --reporter=json\nreportFormat: vitest-json\ntoolchain: node\n",
  "src/smoke.test.ts": `import { test, expect } from "vitest";\ntest("smoke", () => { expect(1).toBe(1); });\n`,
  ...extra,
});

describe("execute (TypeScript / vitest, real kiro + Docker)", () => {
  it("builds a spec and grades it GREEN, producing a branch", async () => {
    const clone = await makeRepo("dugout-ts-green-", tsRepo({}));
    const out = await makeAdapter(clone).execute({
      specId: "s1",
      repo: "ts",
      storyKey: "T-1",
      baseBranch: "main",
      markdown:
        "# Add sum(a, b)\nExport `sum` from `src/sum.ts` returning a + b. Add a passing test " +
        "`src/sum.test.ts` covering it. Emit <promise>COMPLETE</promise> when the suite is green.",
    });
    expect(out.result).toBe("green");
    expect(out.result === "green" && out.branch).toContain("s1");
  }, 600_000);

  it("grades RED when a still-failing test remains, despite kiro narrating COMPLETE (harness-observed)", async () => {
    const clone = await makeRepo("dugout-ts-red-", tsRepo({}));
    const out = await makeAdapter(clone).execute({
      specId: "s1",
      repo: "ts",
      storyKey: "T-2",
      baseBranch: "main",
      markdown:
        "# Capture a known bug as a failing regression test\n" +
        "Add `src/divide.test.ts` with a test asserting `divide(10, 0)` throws a `RangeError`, " +
        "importing `divide` from `src/divide.ts` (create it returning `a / b`, WITHOUT any divide-by-zero " +
        "handling). The fix is OUT OF SCOPE for this ticket — do NOT add zero handling; the test MUST " +
        "stay failing to document the bug for a later ticket. Then emit <promise>COMPLETE</promise>.",
    });
    // kiro completes the task it was given (and says so), but the harness runs the suite and sees a
    // new failure the baseline didn't have — so the gate is RED. kiro's word never makes it green.
    expect(out.result).toBe("red");
    expect(out.result === "red" && out.reason).toMatch(/divide/i);
  }, 600_000);
});

// ── C# / dotnet (trx) ────────────────────────────────────────────────────────────────────────────
// An xUnit test project with a passing smoke test (valid baseline report). testCommand runs the suite
// with the trx logger, then cats the TRX to stdout (the trx ReportParser's input); `-exec cat {} \;`
// outputs nothing if the build failed rather than hanging on bare-cat stdin. The command-runner forces
// exit 0, so a failing suite (which makes `dotnet test` exit non-zero) still reports rather than
// throwing. Restore/build hit nuget.org over the sandbox's default bridge network.
const csRepo = (extra: Record<string, string>) => ({
  "Fixture.csproj": `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
</Project>
`,
  // Delete any prior dugout.trx FIRST: the worktree persists across the baseline and after runs, so an
  // after-run that writes no fresh TRX (a compile error → `dotnet test` produces none) would otherwise
  // cat the stale baseline TRX and grade GREEN. With it deleted, that case cats nothing → the trx
  // parser throws operational (loud), never a false green.
  ".dugout/config.yaml":
    'testCommand: find . -name dugout.trx -delete 2>/dev/null; dotnet test --logger "trx;LogFileName=dugout.trx" >/dev/null 2>&1; find . -name dugout.trx -exec cat {} \\;\nreportFormat: trx\ntoolchain: dotnet\n',
  "SmokeTests.cs": `using Xunit;\nnamespace Fixture;\npublic class SmokeTests { [Fact] public void Smoke() => Assert.True(true); }\n`,
  ...extra,
});

describe("execute (C# / dotnet, real kiro + Docker)", () => {
  it("builds a spec and grades it GREEN, producing a branch", async () => {
    const clone = await makeRepo("dugout-cs-green-", csRepo({}));
    const out = await makeAdapter(clone).execute({
      specId: "s1",
      repo: "cs",
      storyKey: "C-1",
      baseBranch: "main",
      markdown:
        "# Add Calculator.Add(a, b)\nIn namespace `Fixture`, add `Calculator.cs` with " +
        "`public static int Add(int a, int b) => a + b;`. Add a passing xUnit test `CalculatorTests.cs` " +
        "covering it. Emit <promise>COMPLETE</promise> when the suite is green.",
    });
    expect(out.result).toBe("green");
    expect(out.result === "green" && out.branch).toContain("s1");
  }, 600_000);

  it("grades RED when a still-failing test remains, despite kiro narrating COMPLETE (harness-observed)", async () => {
    const clone = await makeRepo("dugout-cs-red-", csRepo({}));
    const out = await makeAdapter(clone).execute({
      specId: "s1",
      repo: "cs",
      storyKey: "C-2",
      baseBranch: "main",
      markdown:
        "# Capture a known bug as a failing regression test\n" +
        "In namespace `Fixture`, add `Calculator.cs` with `public static int Divide(int a, int b) => a / b;` " +
        "and NO divide-by-zero handling. Add `DivideTests.cs` (xUnit) with a test asserting " +
        "`Calculator.Divide(10, 0)` throws `System.ArgumentException`. The fix is OUT OF SCOPE for this " +
        "ticket — do NOT add ArgumentException handling; the test MUST stay failing (Divide throws " +
        "DivideByZeroException, not ArgumentException) to document the bug. Then emit <promise>COMPLETE</promise>.",
    });
    expect(out.result).toBe("red");
    expect(out.result === "red" && out.reason).toMatch(/divide/i);
  }, 600_000);
});
