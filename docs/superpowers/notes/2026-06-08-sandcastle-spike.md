# Task 0 spike — `@ai-hero/sandcastle` reality check (2026-06-08)

Gate before any execute-mode code (#7). The plan was authored against the lib's `main`; this
records what the **installed published version** actually exposes and reconciles the plan against it.

- **Installed version:** `@ai-hero/sandcastle@0.7.0` (ESM-only, `"type": "module"`, built on Effect;
  structured-output schemas are **Standard Schema** validators — zod v4 qualifies).
- **Inspected:** `dist/index.d.ts`, `dist/sandboxes/docker.d.ts`, `dist/SandboxProvider-*.d.ts`,
  `package.json`. (No real run yet — Docker daemon was down; see "Step 3" below.)

## Confirmed against the plan (no change needed)

- **`run(options)`** — exported from the package root. Overloaded: with `output: Output.object(...)`
  the result is `RunResult & { output: T }`; without `output`, a plain `RunResult`.
  `RunOptions` fields we use all exist: `agent`, `sandbox`, `cwd`, `prompt`, `branchStrategy`,
  `completionSignal`, `output`, plus useful extras (`idleTimeoutSeconds` default 600,
  `completionTimeoutSeconds` default 60, `signal`, `maxIterations` default 1, `hooks`, `logging`).
- **`completionSignal` default is `"<promise>COMPLETE</promise>"`** — exactly what the methodology
  prompt tells kiro to emit. No need to set it.
- **`RunResult`** has `stdout` (combined across iterations), `commits: { sha: string }[]`,
  `branch: string`, plus `iterations`, `completionSignal?`, `logFilePath?`, `preservedWorktreePath?`,
  `resume?`, `fork?`. The adapter reads `stdout` and `branch`. ✓
- **`branchStrategy: { type: "branch", branch }`** — confirmed (`NamedBranchStrategy`, optional
  `baseBranch`). ✓ The spec-branch naming in Task 6 is valid.
- **`AgentProvider`** — `kiroExecuteAgent` (Task 5) matches the real interface exactly:
  - `name: string`, `env: Record<string,string>`, `captureSessions: boolean` (required),
    `buildPrintCommand(opts): PrintCommand`, `parseStreamLine(line): ParsedStreamEvent[]`.
  - `AgentCommandOptions = { prompt, dangerouslySkipPermissions, resumeSession?, forkSession? }`.
  - `PrintCommand = { command, stdin? }` — `stdin` pipes the prompt to the child (avoids the argv
    limit), exactly as the plan uses it.
  - `ParsedStreamEvent` includes `{ type: "text"; text }` — `parseStreamLine` returning one text
    event per line is valid. Optional fields we skip: `sessionStorage`, `buildInteractiveArgs`,
    `parseSessionUsage`. `captureSessions: false` is correct (kiro is stateless/headless).
- **`docker({ imageName })`** — import `@ai-hero/sandcastle/sandboxes/docker`. ✓ Extra knobs
  available if needed: `mounts`, `network`, `env`, `containerUid/Gid`, `cpus`, `groups`, `devices`.
- **`Output.object({ tag, schema })` / `Output.string({ tag })`** — exported from the package root
  (NOT a subpath). Schema is `StandardSchemaV1` → a zod v4 object works directly.

## Divergences from the plan — RECONCILE BEFORE CODING

### 1. Do NOT use `output: { tag }` — and prefer NOT to use `Output` extraction at all (Tasks 4, 6)

Two problems with the plan's `output: { tag: TEST_REPORT_TAG }`:

- **Shape is wrong.** The real option is `output: Output.object({ tag, schema })` or
  `Output.string({ tag })` — a bare `{ tag }` won't typecheck.
- **Failure mode is wrong (the important one).** When the configured tag is absent or the contents
  fail JSON.parse / schema validation, `run()` **throws `StructuredOutputError`** — it does *not*
  return `output: undefined`. That error carries `commits`/`branch`/`sessionId` but **NOT `stdout`**.

Why that breaks the decision tree: on an **ambiguous** outcome kiro emits `<dugout-ambiguous>…` and
stops **without** a `<dugout-test-report>`. With `output` configured, `run()` would throw (tag not
found) and we'd have no `stdout` to read the ambiguity reason from — ambiguity would be
indistinguishable from infra failure.

**Decision (locked): the adapter does not configure `output`. It parses both tags out of
`result.stdout` itself**, single-source:
1. `<dugout-ambiguous>reason</dugout-ambiguous>` present → `ambiguous` (short-circuit, no grading).
2. else extract `<dugout-test-report>{json}</dugout-test-report>`, `JSON.parse`, shape-check
   (`baselineFailures`/`afterFailures` both string arrays) → `gradeExecute(report)` → `green`/`red`.
3. else (neither tag / unparseable) → `red` ("no parseable test report"). A non-throwing red.

This keeps every outcome on one source (`stdout`), makes "missing report" a normal red instead of an
exception, and preserves ambiguity detection.

- **Task 6 changes:** drop the `output:` option from the `run()` call; add a `parseTestReport(stdout)`
  helper alongside the existing `ambiguityReason(stdout)` regex; read `result.stdout` (not
  `result.output`). `grade-execute.ts` (Task 3) is unchanged — still pure over a `DugoutTestReport`.
- **Task 4 (prompt) unchanged in substance:** it must still instruct kiro to print exactly one
  `<dugout-test-report>…</dugout-test-report>` line to stdout, then `<promise>COMPLETE</promise>`.
  No zod schema needed (we parse + shape-check ourselves), so **no zod dependency** is pulled in.

### 2. Baseline-reds mechanism — FOLDED REPORT confirmed (the open question, now closed) (Tasks 4, 8)

`SandboxHooks` are `host.onWorktreeReady` / `host.onSandboxReady` / `sandbox.onSandboxReady` — arrays
of `{ command, timeoutMs?, sudo? }`. They are **fire-and-forget**: there is **no channel to read a
hook's output back on the host**. So the "pre-agent hook runs the suite and the host reads the
baseline" alternative is **not supported** by 0.7.0.

→ Use the plan's default: **kiro runs the full suite twice inside the box** (before any change =
`baselineFailures`, after the build = `afterFailures`) and folds both into the one
`<dugout-test-report>`. Task 8's "reconcile baseline mechanism" step resolves to "no change — folded
report stays." Grading remains harness-side and pure (invariant 8 satisfied: the harness, not kiro,
decides green by diffing the two lists).

### 3. kiro prompt rides stdin with NO trailing `-` (Task 5) — verified against kiro-cli 2.6.0

The plan's `buildPrintCommand` ends the command with ` -`. Verified locally (kiro-cli 2.6.0 is
installed; `printf 'Reply with only PONG' | kiro-cli chat --no-interactive --wrap never --trust-tools=`
returned `PONG`): `kiro chat` reads the prompt from **stdin when its positional `[INPUT]` is omitted**.
A trailing `-` would be taken as a literal `INPUT="-"` and **suppress** stdin reading. So the command
is `kiro-cli chat --no-interactive --wrap never --trust-tools=<tools>` with the prompt on
`PrintCommand.stdin` and **no `-`**. (The plan's unit test doesn't assert the `-`, so it stays green.)
Trust tools `fs_read,fs_write,execute_bash` are passed but the exact identifiers are only proven
end-to-end by the Task 8 agent test.

### 4. Minor notes

- `dangerouslySkipPermissions` is supplied to `buildPrintCommand` by the framework (required field on
  `AgentCommandOptions`). The kiro provider ignores it and always passes `--trust-tools=…` because
  execute mode is always non-interactive — fine; just don't rely on the flag.
- `maxIterations` defaults to 1 (good). We're not using `output`, so its "maxIterations must be 1"
  constraint doesn't bind us, but we have no reason to raise it.
- `run()` accepts an `AbortSignal` (`signal`) and `idleTimeoutSeconds` — out of scope for #7 but
  available when we add cancellation/live-progress later.

## Step 3 (real smoke run) — NOT DONE: Docker daemon down

`docker version` shows client **29.5.2** installed, but `docker info` fails (daemon unreachable —
Docker Desktop not running). Steps 1/2/4 (install + surface confirmation, the actual gate) needed
neither Docker nor a key and are complete. The real end-to-end smoke is **deferred to Task 8's agent
test** (`npm run test:agent`), which already requires Docker up + `KIRO_API_KEY` + the built sandbox
image and fails loudly if any is missing (CLAUDE.md). No separate throwaway probe was written.

## Typed seam alias (for Task 1)

```ts
// src/core/adapters/sandcastle.ts
import type { run } from "@ai-hero/sandcastle";
/** The execute-mode test seam: Sandcastle's run(). Unit tests pass a fake of this shape. */
export type SandcastleRun = typeof run;
```

`typeof run` captures all three overloads. Since the adapter no longer passes `output`, the relevant
overload is `run<A>(options: RunOptions<A>): Promise<RunResult>` — `result.stdout` / `result.branch`
are always present.
