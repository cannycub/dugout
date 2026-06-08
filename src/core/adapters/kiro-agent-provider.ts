import type { AgentProvider } from "@ai-hero/sandcastle";

/** Tools kiro may auto-approve in execute mode: read + write + run the test suite. Draft uses only
 *  `fs_read`; execute additionally needs to write code and run the suite. Verified end-to-end by the
 *  agent test (Task 8) — a wrong identifier surfaces there, not in CI. */
const EXECUTE_TRUST = ["fs_read", "fs_write", "execute_bash"] as const;

/**
 * A Sandcastle AgentProvider for headless kiro (execute mode). kiro runs --no-interactive with write
 * + bash-exec trust so it can build and run tests; the large prompt rides stdin (avoids the argv
 * limit and any shell-quoting of multiline markdown/JSON). kiro emits plain text (no JSON stream), so
 * each line is a `text` event and sessions are not captured. ADR-0011; mirrors the draft adapter's
 * kiro invocation (kiro-runner.ts).
 *
 * Note: NO trailing `-`. Verified against kiro-cli 2.6.0 (Task 0 spike): `chat` reads the prompt from
 * stdin when its positional [INPUT] is omitted; a `-` would be taken as a literal INPUT and suppress
 * stdin. `--wrap never` stops kiro wrapping our long lines, as in draft.
 */
export function kiroExecuteAgent(opts: { apiKey: string; bin?: string }): AgentProvider {
  const bin = opts.bin ?? "kiro-cli";
  return {
    name: "kiro",
    env: { KIRO_API_KEY: opts.apiKey, NO_COLOR: "1", KIRO_LOG_NO_COLOR: "1" },
    captureSessions: false,
    buildPrintCommand: ({ prompt }) => ({
      command: `${bin} chat --no-interactive --wrap never --trust-tools=${EXECUTE_TRUST.join(",")}`,
      stdin: prompt,
    }),
    parseStreamLine: (line) => [{ type: "text", text: line }],
  };
}
