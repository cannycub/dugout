import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KiroRun, KiroInvocation } from "./kiro-draft-adapter.js";

/** Injected child-process runner returning captured stdout. Defaults to a promisified execFile. */
type RunProcess = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface SpawnKiroOptions {
  /** The kiro CLI binary; found on PATH by default. */
  bin?: string;
  /**
   * The kiro API key for headless auth (kiro.dev/docs/cli/headless). Defaults to
   * `process.env.KIRO_API_KEY`. An explicit value lets the host source it from secure storage
   * (e.g. safeStorage) rather than relying on the ambient environment — important when the app is
   * launched from the GUI, which doesn't inherit a shell's exports.
   */
  apiKey?: string;
  /** Injectable process runner (tests pass a fake — no real kiro spawns in tests). */
  run?: RunProcess;
}

/**
 * The real {@link KiroRun}: shell out to headless kiro read-only
 * (`kiro-cli chat --no-interactive --wrap never --trust-tools=fs_read <prompt>`, cwd = the source
 * mount; kiro.dev/docs/cli/headless/). There is deliberately NO output-format flag: `--format` on
 * the installed CLI is for list commands only (`kiro-cli chat --help`), so chat just prints the
 * model's text response — interleaved with the tool-activity narration `--no-interactive` streams.
 * We hand that stdout (ANSI-stripped) straight back; the adapter locates the sentinel-delimited
 * DUGOUT block within it. `--wrap never` stops kiro terminal-width-wrapping our long sentinel and
 * markdown lines. Headless kiro authenticates via `KIRO_API_KEY`, injected into the child env (a
 * missing key fails clearly up front, not with a cryptic kiro auth error). The process runner is
 * injected so the mapping is unit-tested without a real kiro binary; a spawn failure (e.g. kiro not
 * installed) surfaces clearly.
 */
export function spawnKiroRunner(opts: SpawnKiroOptions = {}): KiroRun {
  const bin = opts.bin ?? "kiro-cli";
  const run: RunProcess = opts.run ?? (promisify(execFile) as unknown as RunProcess);
  return async ({ prompt, sourceDir, trustTools }: KiroInvocation) => {
    const apiKey = opts.apiKey ?? process.env["KIRO_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "kiro headless needs an API key — set KIRO_API_KEY (kiro.dev/docs/cli/headless).",
      );
    }
    const args = [
      "chat",
      "--no-interactive",
      "--wrap",
      "never",
      `--trust-tools=${trustTools.join(",")}`,
      prompt,
    ];
    let stdout: string;
    try {
      // maxBuffer is generous: a fan-out's spec markdown rides inline in stdout, and so does the
      // tool-activity narration around the DUGOUT block.
      ({ stdout } = await run(bin, args, {
        cwd: sourceDir,
        // NO_COLOR best-effort: kiro can still emit ANSI when piped (#8352), so we also strip below.
        env: { ...process.env, KIRO_API_KEY: apiKey, NO_COLOR: "1", KIRO_LOG_NO_COLOR: "1" },
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (err) {
      throw new Error(`kiro draft run failed (is kiro installed and on PATH?): ${String(err)}`);
    }
    return stripAnsi(stdout).trim();
  };
}

/**
 * Strip CSI (ESC `[` … final) and OSC (ESC `]` … BEL/ST) ANSI escape sequences. kiro can emit these
 * when its stdout is piped (#8352), which would otherwise break JSON.parse of the envelope. Built
 * via `new RegExp` from string escapes to keep raw control bytes out of the source.
 */
// eslint-disable-next-line no-control-regex
const ANSI = new RegExp("\\u001B(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\))", "g");
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}
