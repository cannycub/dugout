import type { AgentProvider } from "@ai-hero/sandcastle";

/**
 * A non-agent `AgentProvider` that runs a fixed shell command in the sandbox instead of invoking an
 * LLM (ADR-0015 clause 1). Sand Castle 0.7 exposes no host-readable `exec`, but `Sandbox.run()`
 * builds its command from the injected provider and returns stdout — so a provider whose
 * `buildPrintCommand` returns the repo's *test command* lets the harness observe the suite
 * in-sandbox, provider- and language-agnostically.
 *
 * The command is forced to **`exit 0`**: Sand Castle's `run()` throws `AgentError` on a non-zero
 * exit, and a failing suite exits non-zero — so pass/fail must live entirely in the report the
 * command prints to stdout, never in the exit code (ADR-0015 clause 3).
 *
 * `RunResult.stdout` is captured from the raw exec output by Sand Castle, independent of
 * `parseStreamLine` (the parsed `text` events only feed completion-signal detection, which we don't
 * use). `parseStreamLine` is a required `AgentProvider` method, so we give it a trivial line-as-text
 * implementation; it has no effect on the report the host-side `ReportParser` reads. Sessions are not
 * captured — there is no LLM session to resume.
 */
export function commandRunnerAgent(testCommand: string): AgentProvider {
  return {
    name: "command-runner",
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({ command: `${testCommand}\nexit 0` }),
    parseStreamLine: (line) => [{ type: "text", text: line }],
  };
}
