# Execute mode (#7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per the user's standing preference, execute each TDD task with the `tdd` skill.

**Goal:** Build one approved spec's code inside an isolated Sand Castle sandbox (real kiro, red→green TDD), grade it green/ambiguous/red, and land the produced branch on the local clone.

**Architecture:** A `KiroExecuteAdapter implements ExecutorPort.execute()` wraps the external `@ai-hero/sandcastle` `run()`. Sandcastle owns the sandbox lifecycle, the Docker (etc.) provider, the agent loop, and branch merge-back. Dugout owns: the kiro **agent provider**, the red→green **methodology** prompt, and **grading** (pure, harness-side, invariant 8). The `run` function is injected as the unit-test seam (like `runKiro` for draft); real Docker+kiro runs live in the agent tier.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, `@ai-hero/sandcastle`, headless kiro CLI, Docker.

**Reference:** `docs/superpowers/specs/2026-06-08-execute-mode-design.md` and `docs/adr/0011-execute-mode-wraps-sand-castle-dugout-owns-grading.md`. Domain language: `CONTEXT.md` (**Execute mode**, **Sand Castle**, **Execute outcome**).

**Scope:** single spec. Story-branch accumulation, the real `merge()`, and cross-repo parallelism are **#8** — out of scope.

---

## Shared definitions (used across tasks — keep names consistent)

- `ExecuteOutcome = { result: "green"; branch: string } | { result: "ambiguous"; reason: string } | { result: "red"; reason: string }`
- `DugoutTestReport = { baselineFailures: string[]; afterFailures: string[] }` — emitted by kiro inside the `<dugout-test-report>…</dugout-test-report>` tag and extracted via Sandcastle's `Output`.
- `TEST_REPORT_TAG = "dugout-test-report"`, `AMBIGUITY_TAG = "dugout-ambiguous"`.
- Adapter dependencies: `{ run, sandbox, makeAgent, resolveClonePath }` where `run: SandcastleRun` (= `typeof import("@ai-hero/sandcastle").run`), `sandbox: SandboxProvider`, `makeAgent: (key) => AgentProvider`, `resolveClonePath: (repo: string) => Promise<string>`.

---

## Task 0: Spike — de-risk the real Sandcastle API (NOT TDD)

**Why:** the unit tests below use a *fake* `run`, but that fake must match Sandcastle's real `run()` / `RunResult` / `Output` / `AgentProvider` shapes for the installed version (this plan was authored from `main`; the published version may differ). This task confirms reality before we build against it.

**Files:**
- Create (throwaway): `spike/sandcastle-probe.ts` (delete before merge)
- Create: `docs/superpowers/notes/2026-06-08-sandcastle-spike.md` (findings)

- [ ] **Step 1: Install the dependency**

Run: `npm i @ai-hero/sandcastle`
Expected: added to `package.json` dependencies; `node_modules/@ai-hero/sandcastle` present.

- [ ] **Step 2: Confirm the exported surface against the design**

Run: `node -e "console.log(Object.keys(require('@ai-hero/sandcastle')))"` and inspect `node_modules/@ai-hero/sandcastle/dist/*.d.ts`.
Record in the notes file, confirming or correcting each:
  - `run(options)` — exact `RunOptions` fields we use (`agent`, `sandbox`, `cwd`, `prompt`, `branchStrategy`, `completionSignal`, `output`) and `RunResult` fields (`commits`, `branch`, `stdout`, `output`, `completionSignal`).
  - `Output.object({ tag, schema })` import path + the schema flavour it expects (zod? JSON schema?).
  - The `AgentProvider` interface fields (`name`, `env`, `captureSessions`, `buildPrintCommand`, `parseStreamLine`).
  - `docker({ imageName, mounts })` import path (`@ai-hero/sandcastle/sandboxes/docker`).
  - **Baseline-reds mechanism:** confirm whether a pre-agent **sandbox hook** can run the suite AND have its output read back on the host (preferred), or whether we fold baseline+after into the agent's report (this plan's default — see Task 4/6). Record the decision.

- [ ] **Step 3: Smoke a trivial real run (optional but recommended)**

Write `spike/sandcastle-probe.ts` that runs `run({ agent: claudeCode(...), sandbox: docker(...), cwd: <throwaway repo>, prompt: "echo hello and emit <promise>COMPLETE</promise>", branchStrategy: { type: "branch", branch: "spike" } })` and logs the result. Run it with Docker up + a key.
Expected: a `RunResult` with a `branch`/`commits`; confirms Docker + Sandcastle work locally.

- [ ] **Step 4: Capture a typed alias for the seam**

In the notes file, write the final TypeScript alias the tasks below import:
```ts
// src/core/adapters/sandcastle.ts (created in Task 1)
import type { run } from "@ai-hero/sandcastle";
export type SandcastleRun = typeof run;
```
Adjust later tasks if the real types differ from what's written here.

- [ ] **Step 5: Commit the notes; delete the probe**

```bash
rm -rf spike
git add package.json package-lock.json docs/superpowers/notes/2026-06-08-sandcastle-spike.md
git commit -m "chore: add @ai-hero/sandcastle + spike notes (#7)"
```

---

## Task 1: Sandcastle seam type alias

**Files:**
- Create: `src/core/adapters/sandcastle.ts`

- [ ] **Step 1: Re-export the run type (the injected seam)**

```ts
// Thin re-export so the rest of the core depends on one alias for Sandcastle's run(),
// the injected test seam for execute mode (mirrors runKiro for draft). ADR-0011.
import type { run } from "@ai-hero/sandcastle";

/** The execute-mode test seam: Sandcastle's run(). Unit tests pass a fake of this shape. */
export type SandcastleRun = typeof run;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/adapters/sandcastle.ts
git commit -m "feat: SandcastleRun seam alias for execute mode (#7)"
```

---

## Task 2: `ExecuteOutcome` gains the `red` arm

**Files:**
- Modify: `src/core/ports/executor.ts` (the `ExecuteOutcome` union + its doc comment)
- Test: `src/core/orchestrator.ambiguity.test.ts` (add a `red` case alongside the ambiguous one)

- [ ] **Step 1: Write the failing test** (append to `orchestrator.ambiguity.test.ts`)

```ts
it("fails the spec and story on a red outcome (built, suite not green), restartable like ambiguity", async () => {
  const { orchestrator } = makeHarness({
    draft: [
      { repo: "web", markdown: "# Spec A" },
      { repo: "api", markdown: "# Spec B" },
    ],
    execute: {
      "DUG-1-spec-1": { result: "red", reason: "3 tests still failing after build" },
    },
  });
  await draftAndApprove(orchestrator, ["web", "api"]);

  const story = await orchestrator.runStory("DUG-1");

  expect(story.specs[0]!.status).toBe("failed");
  expect(story.status).toBe("failed");
  expect(story.specs[1]!.status).toBe("approved"); // never stacks downstream
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/orchestrator.ambiguity.test.ts`
Expected: FAIL — TypeScript rejects `{ result: "red", reason }` (not assignable to `ExecuteOutcome`).

- [ ] **Step 3: Add the `red` arm to the union**

In `src/core/ports/executor.ts`, replace the `ExecuteOutcome` definition + its doc comment:

```ts
/**
 * Outcome of an execute-mode run for one spec (ADR-0011; glossary "Execute outcome"):
 *  - `green`     — the per-spec green gate is met (invariant 8): the full suite passes in the
 *                  sandbox, pre-existing reds baselined. `branch` is the produced spec branch.
 *  - `ambiguous` — the agent hit a fork it cannot resolve without guessing and refused to proceed
 *                  (build-time analogue of `needs-clarification`); the dev re-clarifies, then the
 *                  spec clean-restarts.
 *  - `red`       — the agent completed *without* ambiguity but the green gate is not met (or the
 *                  test report was missing/unparseable — `reason` says so); nothing to clarify,
 *                  retry/investigate.
 * Any non-green outcome fails the spec and the story for a clean restart, never a resume (inv. 1).
 */
export type ExecuteOutcome =
  | { result: "green"; branch: string }
  | { result: "ambiguous"; reason: string }
  | { result: "red"; reason: string };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/orchestrator.ambiguity.test.ts`
Expected: PASS (the orchestrator's `result !== "green"` branch already handles it).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS. (The `FakeExecutor` already accepts any `ExecuteOutcome`; no change needed.)

- [ ] **Step 6: Commit**

```bash
git add src/core/ports/executor.ts src/core/orchestrator.ambiguity.test.ts
git commit -m "feat: ExecuteOutcome gains red arm (built-but-not-green) (#7, ADR-0011)"
```

---

## Task 3: `grade-execute.ts` — pure green/red grading

**Files:**
- Create: `src/core/grade-execute.ts`
- Test: `src/core/grade-execute.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { gradeExecute, type DugoutTestReport } from "./grade-execute.js";

describe("gradeExecute", () => {
  it("green when no test fails that wasn't already failing in the baseline", () => {
    const report: DugoutTestReport = { baselineFailures: ["a", "b"], afterFailures: ["a", "b"] };
    expect(gradeExecute(report)).toEqual({ result: "green" });
  });

  it("green when the build fixed a pre-existing red and added none", () => {
    const report: DugoutTestReport = { baselineFailures: ["a"], afterFailures: [] };
    expect(gradeExecute(report)).toEqual({ result: "green" });
  });

  it("red when a new failure appears that wasn't in the baseline", () => {
    const report: DugoutTestReport = { baselineFailures: ["a"], afterFailures: ["a", "c"] };
    const r = gradeExecute(report);
    expect(r.result).toBe("red");
    expect(r.result === "red" && r.reason).toMatch(/c/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/grade-execute.test.ts`
Expected: FAIL — `gradeExecute` not defined.

- [ ] **Step 3: Implement**

```ts
/** A spec's test results, baseline (on the seed) vs after the build. Both are stable test ids. */
export interface DugoutTestReport {
  /** Test ids failing on the seed before the build (pre-existing reds — invariant 8). */
  baselineFailures: string[];
  /** Test ids failing after the build. */
  afterFailures: string[];
}

/**
 * Pure per-spec green gate (invariant 8): green iff no test fails that wasn't already failing in the
 * baseline. New failures → red, naming them. The harness grades — kiro never self-reports (ADR-0011).
 */
export function gradeExecute(
  report: DugoutTestReport,
): { result: "green" } | { result: "red"; reason: string } {
  const baseline = new Set(report.baselineFailures);
  const newFailures = report.afterFailures.filter((t) => !baseline.has(t));
  if (newFailures.length === 0) return { result: "green" };
  return {
    result: "red",
    reason: `${newFailures.length} new test failure(s) not in baseline: ${newFailures.join(", ")}`,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/grade-execute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/grade-execute.ts src/core/grade-execute.test.ts
git commit -m "feat: pure execute grading (green iff no new failures vs baseline) (#7)"
```

---

## Task 4: `execute-methodology.ts` — the red→green prompt

**Files:**
- Create: `src/core/adapters/execute-methodology.ts`
- Test: `src/core/adapters/execute-methodology.test.ts`

The prompt instructs kiro to: run the full suite first (record `baselineFailures`), do red→green TDD for the spec, run the suite again (`afterFailures`), emit a single `<dugout-test-report>{json}</dugout-test-report>`, then emit the completion signal. If it hits a fork it cannot resolve without guessing, it must emit `<dugout-ambiguous>reason</dugout-ambiguous>` and stop — never guess, never ask (invariant 1).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { executeMethodology, TEST_REPORT_TAG, AMBIGUITY_TAG } from "./execute-methodology.js";

describe("executeMethodology", () => {
  const prompt = executeMethodology({ markdown: "# Add /health endpoint\nAC: returns 200." });

  it("embeds the spec markdown", () => {
    expect(prompt).toContain("# Add /health endpoint");
  });
  it("instructs red→green TDD", () => {
    expect(prompt).toMatch(/test-first|red.?→?.?green|failing test first/i);
  });
  it("requires the full suite be run for baseline and after, reported in the tag", () => {
    expect(prompt).toContain(TEST_REPORT_TAG);
    expect(prompt).toMatch(/baselineFailures/);
    expect(prompt).toMatch(/afterFailures/);
  });
  it("instructs the ambiguity escape hatch (never guess, never ask)", () => {
    expect(prompt).toContain(AMBIGUITY_TAG);
    expect(prompt).toMatch(/never guess|do not guess/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/adapters/execute-methodology.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export const TEST_REPORT_TAG = "dugout-test-report";
export const AMBIGUITY_TAG = "dugout-ambiguous";

/**
 * The execute-mode prompt: red→green TDD for one single-repo spec inside the sandbox, with the
 * harness-graded green gate (invariant 8) fed by a structured report. kiro runs --no-interactive and
 * never blocks for input; genuine mid-build ambiguity is an explicit escape hatch, never a guess
 * (invariant 1). ADR-0011.
 */
export function executeMethodology(spec: { markdown: string }): string {
  return [
    "You are implementing ONE single-repo spec inside a sandboxed clone. Follow strict red→green TDD:",
    "write a failing test first, then the minimal code to pass it, refactor, repeat.",
    "",
    "PROCEDURE:",
    "1. Before changing anything, run the repo's FULL test suite and record every failing test id",
    "   (these are pre-existing failures — the baseline).",
    "2. Implement the spec test-first.",
    "3. Run the FULL test suite again and record every failing test id (after).",
    `4. Emit EXACTLY ONE report block, on its own lines:`,
    `   <${TEST_REPORT_TAG}>{"baselineFailures":[...],"afterFailures":[...]}</${TEST_REPORT_TAG}>`,
    "   using stable test ids (file + test name). Then emit <promise>COMPLETE</promise>.",
    "",
    "NEVER GUESS. If you hit a decision you cannot resolve from the spec and code without guessing,",
    `do NOT proceed and do NOT ask a question. Emit <${AMBIGUITY_TAG}>one-line reason</${AMBIGUITY_TAG}>`,
    "and stop. A clean restart after the developer clarifies is correct; a guess is not (invariant 1).",
    "",
    "THE SPEC:",
    spec.markdown,
  ].join("\n");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/adapters/execute-methodology.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/execute-methodology.ts src/core/adapters/execute-methodology.test.ts
git commit -m "feat: execute-mode red→green methodology prompt (#7)"
```

---

## Task 5: `kiro-agent-provider.ts` — Sandcastle AgentProvider for headless kiro

**Files:**
- Create: `src/core/adapters/kiro-agent-provider.ts`
- Test: `src/core/adapters/kiro-agent-provider.test.ts`

> Reconcile the `AgentProvider` field set against the Task 0 spike notes. kiro stdout is plain text (no JSON stream), so `parseStreamLine` emits a single `text` event per line and `captureSessions` is false.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { kiroExecuteAgent } from "./kiro-agent-provider.js";

describe("kiroExecuteAgent", () => {
  const agent = kiroExecuteAgent({ apiKey: "k-123" });

  it("injects the kiro api key into the sandbox env", () => {
    expect(agent.env["KIRO_API_KEY"]).toBe("k-123");
  });
  it("does not capture sessions (kiro is stateless/headless)", () => {
    expect(agent.captureSessions).toBe(false);
  });
  it("builds a non-interactive kiro chat command with write+exec trust, prompt via stdin", () => {
    const cmd = agent.buildPrintCommand({ prompt: "DO THE THING", dangerouslySkipPermissions: true });
    expect(cmd.command).toMatch(/kiro-cli chat/);
    expect(cmd.command).toContain("--no-interactive");
    expect(cmd.command).toMatch(/--trust-tools=.*fs_write/);
    expect(cmd.stdin).toBe("DO THE THING"); // large prompt rides stdin, not argv
  });
  it("parses each stdout line as a text event", () => {
    expect(agent.parseStreamLine("building...")).toEqual([{ type: "text", text: "building..." }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/adapters/kiro-agent-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (field names/types per the spike notes)

```ts
import type { AgentProvider } from "@ai-hero/sandcastle";

/** Tools kiro may auto-approve in execute mode: read + write + run the test suite. Confirm the exact
 *  CLI identifiers against `kiro-cli chat --help` during the spike (draft uses `fs_read`). */
const EXECUTE_TRUST = ["fs_read", "fs_write", "execute_bash"] as const;

/**
 * A Sandcastle AgentProvider for headless kiro (execute mode). kiro runs --no-interactive with write
 * + bash-exec trust so it can build and run tests; the large prompt rides stdin (avoids the argv
 * limit). kiro emits plain text (no JSON stream), so each line is a `text` event and sessions are not
 * captured. ADR-0011; mirrors the draft adapter's kiro invocation.
 */
export function kiroExecuteAgent(opts: { apiKey: string; bin?: string }): AgentProvider {
  const bin = opts.bin ?? "kiro-cli";
  return {
    name: "kiro",
    env: { KIRO_API_KEY: opts.apiKey, NO_COLOR: "1", KIRO_LOG_NO_COLOR: "1" },
    captureSessions: false,
    buildPrintCommand: ({ prompt }) => ({
      command: `${bin} chat --no-interactive --wrap never --trust-tools=${EXECUTE_TRUST.join(",")} -`,
      stdin: prompt,
    }),
    parseStreamLine: (line) => [{ type: "text", text: line }],
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/adapters/kiro-agent-provider.test.ts && npm run typecheck`
Expected: PASS. (If `AgentProvider` requires more fields per the spike, add them minimally and re-run.)

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/kiro-agent-provider.ts src/core/adapters/kiro-agent-provider.test.ts
git commit -m "feat: kiro Sandcastle agent provider for execute mode (#7)"
```

---

## Task 6: `kiro-execute-adapter.ts` — wraps run(), grades, maps to ExecuteOutcome

**Files:**
- Create: `src/core/adapters/kiro-execute-adapter.ts`
- Test: `src/core/adapters/kiro-execute-adapter.test.ts`

The adapter implements `ExecutorPort["execute"]` (we only build execute here; `draft` is the kiro draft adapter). Deps are injected so unit tests never touch Docker/kiro. Decision tree (ADR-0011): ambiguity marker in `stdout` → `ambiguous`; else grade the `output` report → `green`/`red`; missing/unparseable report → `red`; `run()` throwing (infra) → rethrow.

- [ ] **Step 1: Write the failing tests** (fake `run`)

```ts
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

const report = (baselineFailures: string[], afterFailures: string[]) =>
  ({ baselineFailures, afterFailures });

it("returns green with the produced branch when the report shows no new failures", async () => {
  const { run, calls } = fakeRun({
    branch: "dugout/DUG-1/api/s1",
    commits: [{ sha: "abc" }],
    stdout: "...done... <promise>COMPLETE</promise>",
    output: report(["x"], ["x"]),
  });
  const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
  expect(out).toEqual({ result: "green", branch: "dugout/DUG-1/api/s1" });
  // seeds from the story branch, cwd is the resolved clone, branch strategy names the spec branch
  expect(calls[0].cwd).toBe("/ws/api");
  expect(calls[0].branchStrategy).toEqual({ type: "branch", branch: "dugout/DUG-1/api/s1" });
});

it("returns red when the report shows a new failure", async () => {
  const { run } = fakeRun({ branch: "b", commits: [], stdout: "x", output: report([], ["new-test"]) });
  const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
  expect(out.result).toBe("red");
  expect(out.result === "red" && out.reason).toMatch(/new-test/);
});

it("returns ambiguous when kiro emitted the ambiguity marker (no grading)", async () => {
  const { run } = fakeRun({
    branch: "b",
    commits: [],
    stdout: `thinking...\n<${AMBIGUITY_TAG}>which auth scheme?</${AMBIGUITY_TAG}>\n`,
    output: undefined,
  });
  const out = await new KiroExecuteAdapter(deps(run)).execute(baseInput);
  expect(out).toEqual({ result: "ambiguous", reason: "which auth scheme?" });
});

it("returns red when the report is missing/unparseable", async () => {
  const { run } = fakeRun({ branch: "b", commits: [], stdout: "no report here", output: undefined });
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/adapters/kiro-execute-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
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

const ambiguityReason = (stdout: string): string | undefined => {
  const m = stdout.match(new RegExp(`<${AMBIGUITY_TAG}>([\\s\\S]*?)</${AMBIGUITY_TAG}>`));
  return m ? m[1]!.trim() : undefined;
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
    const result: any = await this.deps.run({
      agent: this.deps.makeAgent(apiKey),
      sandbox: this.deps.sandbox,
      cwd,
      prompt: executeMethodology({ markdown: input.markdown }),
      branchStrategy: { type: "branch", branch: specBranch },
      output: { tag: TEST_REPORT_TAG }, // Output.object — finalize per spike (schema/import)
    } as any);

    // 1) Ambiguity short-circuits before grading (invariant 1).
    const reason = ambiguityReason(String(result.stdout ?? ""));
    if (reason) return { result: "ambiguous", reason };

    // 2) Grade the structured report; missing/unparseable ⇒ red (no evidence of green, invariant 8).
    const report = result.output as DugoutTestReport | undefined;
    if (!report || !Array.isArray(report.afterFailures) || !Array.isArray(report.baselineFailures)) {
      return { result: "red", reason: "kiro produced no parseable test report" };
    }
    const graded = gradeExecute(report);
    return graded.result === "green" ? { result: "green", branch: result.branch } : graded;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/adapters/kiro-execute-adapter.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/kiro-execute-adapter.ts src/core/adapters/kiro-execute-adapter.test.ts
git commit -m "feat: KiroExecuteAdapter — wrap Sandcastle run(), grade green/ambiguous/red (#7)"
```

---

## Task 7: Wire the real execute adapter into the Electron host

**Files:**
- Modify: `src/main/orchestrator-host.ts` (compose `execute` from the real adapter on the live path)

Today (post-#29) the composition is `{ draft: (fakes?fake:kiro).draft, execute: fake.execute }`. Replace the live `execute` with the Sandcastle adapter; the `DUGOUT_EXECUTOR=fakes` path stays fully fake. `resolveClonePath` uses the existing `RepoScope` (declare the repo, read its clone binding); throw clearly if not cloned.

- [ ] **Step 1: Add the docker sandbox provider import + adapter wiring**

In `src/main/orchestrator-host.ts`, add imports:
```ts
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { KiroExecuteAdapter } from "../core/adapters/kiro-execute-adapter.js";
import { kiroExecuteAgent } from "../core/adapters/kiro-agent-provider.js";
import { run as sandcastleRun } from "@ai-hero/sandcastle";
```

- [ ] **Step 2: Build the live execute adapter and compose it**

Replace the executor composition block (the `const executor: ExecutorPort = { draft, execute }` added in #29) with:
```ts
  const kiroExecute = new KiroExecuteAdapter({
    run: sandcastleRun,
    sandbox: docker({ imageName: process.env["DUGOUT_SANDBOX_IMAGE"] ?? "dugout-sandbox:local" }),
    makeAgent: (apiKey) => kiroExecuteAgent({ apiKey }),
    resolveClonePath: async (repo) => {
      const [declared] = await repoScope.declareRepos([repo]);
      if (!declared || declared.clone.status !== "cloned") {
        throw new Error(`execute mode needs a local clone of "${repo}" (not cloned).`);
      }
      return declared.clone.path;
    },
  });
  const executor: ExecutorPort = {
    draft: (input) => draftExecutor.draft(input),
    execute: process.env["DUGOUT_EXECUTOR"] === "fakes"
      ? (input) => fake.execute(input)
      : (input) => kiroExecute.execute(input),
  };
```

- [ ] **Step 3: Typecheck + full unit suite + e2e**

Run: `npm run typecheck && npx vitest run && npm run test:e2e`
Expected: all PASS. (e2e sets `DUGOUT_EXECUTOR=fakes`, so it never touches the real adapter.)

- [ ] **Step 4: Commit**

```bash
git add src/main/orchestrator-host.ts
git commit -m "feat: wire live execute mode (KiroExecuteAdapter) into the host (#7)"
```

---

## Task 8: Agent-integration test + sandbox image (real Docker + kiro, NOT in CI)

**Files:**
- Create: `src/core/adapters/kiro-execute-adapter.agent.test.ts`
- Create: `sandbox/Dockerfile` (the Sand Castle image with kiro + the toolchain)
- Modify: `README` or `docs/` note on building the image (one line)

> This tier is structurally excluded from CI (`*.agent.test.ts`, vitest `exclude`). It requires `KIRO_API_KEY` **and** a reachable Docker daemon **and** the built image; a missing prerequisite **fails loudly** (CLAUDE.md). Finalize the baseline mechanism per the Task 0 spike.

- [ ] **Step 1: Write the Dockerfile for the sandbox image**

```dockerfile
# Sand Castle sandbox image for Dugout execute mode: a toolchain + headless kiro.
FROM node:22-bookworm
# Install the kiro CLI (pin a version; see kiro.dev/docs/cli/headless).
RUN curl -fsSL https://kiro.dev/install.sh | sh && kiro-cli --version
WORKDIR /workspace
```
Build: `docker build -t dugout-sandbox:local sandbox/`

- [ ] **Step 2: Write the agent test (real run, throwaway repo + spec)**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as sandcastleRun } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { KiroExecuteAdapter } from "./kiro-execute-adapter.js";
import { kiroExecuteAgent } from "./kiro-agent-provider.js";

const sh = promisify(execFile);

describe("KiroExecuteAdapter (real kiro in a real Sand Castle sandbox)", () => {
  let clone: string;

  beforeAll(async () => {
    if (!process.env["KIRO_API_KEY"]) throw new Error("agent test requires KIRO_API_KEY");
    await sh("docker", ["info"]).catch(() => {
      throw new Error("agent test requires a reachable Docker daemon");
    });
    // A throwaway repo with one trivially-specifiable feature and an existing test runner.
    clone = await mkdtemp(join(tmpdir(), "dugout-exec-"));
    await sh("git", ["init", "-q"], { cwd: clone });
    await writeFile(join(clone, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
    await sh("git", ["add", "-A"], { cwd: clone });
    await sh("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: clone });
  }, 120_000);

  it("builds a spec red→green and grades it green, producing a branch", async () => {
    const adapter = new KiroExecuteAdapter({
      run: sandcastleRun,
      sandbox: docker({ imageName: "dugout-sandbox:local" }),
      makeAgent: (apiKey) => kiroExecuteAgent({ apiKey }),
      resolveClonePath: async () => clone,
    });
    const out = await adapter.execute({
      specId: "s1",
      repo: "x",
      markdown: "# Add sum(a,b)\nExport `sum` from index.js returning a+b. Add a passing node:test.",
      storyBranch: "dugout/T-1/x",
    });
    expect(out.result).toBe("green");
    expect(out.result === "green" && out.branch).toContain("s1");
  }, 600_000);
});
```

- [ ] **Step 3: Run the agent suite locally (with Docker up + key)**

Run: `npm run test:agent`
Expected: PASS (real kiro builds the trivial spec, suite green, branch produced). If kiro/Docker absent, it FAILS LOUDLY (never skips).

- [ ] **Step 4: Reconcile the spike's open items**

If the spike found that baseline must be captured by a pre-agent hook (not the folded report), adjust `execute-methodology.ts` (drop the baseline-in-prompt) and `kiro-execute-adapter.ts` (read the hook's report) accordingly, keeping `grade-execute.ts` unchanged. Re-run unit + agent suites.

- [ ] **Step 5: Commit**

```bash
git add sandbox/Dockerfile src/core/adapters/kiro-execute-adapter.agent.test.ts
git commit -m "test: real kiro-in-Sand-Castle execute agent test + sandbox image (#7)"
```

---

## Self-review notes (author)

- **Spec coverage:** every #7 acceptance criterion maps — sandbox-seeded build (Task 6/8), red→green (Task 4), green=full-suite-baselined (Task 3), ambiguity→fail/restart (Task 2/6), branch persisted (Sandcastle, exercised Task 8), fake-executor + grading tests (Tasks 2,3,6). Branch *accumulation* is correctly deferred to #8.
- **Open items intentionally gated by the spike (Task 0), not placeholders:** the exact `Output` schema/import, the `AgentProvider` field set, and the baseline mechanism (folded-report vs pre-agent hook). Tasks 4/5/6/8 state the default and the reconciliation step.
- **Type consistency:** `ExecuteOutcome` (green/ambiguous/red), `DugoutTestReport` (baselineFailures/afterFailures), `SandcastleRun`, `TEST_REPORT_TAG`/`AMBIGUITY_TAG`, and the adapter deps (`run`/`sandbox`/`makeAgent`/`resolveClonePath`) are used identically across tasks.
