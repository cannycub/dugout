import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KiroRun, KiroInvocation } from "./kiro-draft-adapter.js";

/** Injected child-process runner: file + args + cwd. Defaults to a promisified node execFile. */
type RunProcess = (file: string, args: string[], opts: { cwd: string }) => Promise<unknown>;

export interface SpawnKiroOptions {
  /** The kiro CLI binary; found on PATH by default. */
  bin?: string;
  /** Injectable process runner (tests pass a fake — no real kiro spawns in tests). */
  run?: RunProcess;
}

/**
 * The real {@link KiroRun}: shell out to headless kiro read-only
 * (`kiro-cli chat --no-interactive --trust-tools=read,grep <prompt>`, cwd = the source mount;
 * kiro.dev/docs/cli/headless/). kiro writes its `result.json` into the writable specs dir, which
 * the prompt names — the adapter reads it back. The process runner is injected so the mapping is
 * unit-tested without a real kiro binary; a spawn failure (e.g. kiro not installed) surfaces clearly.
 */
export function spawnKiroRunner(opts: SpawnKiroOptions = {}): KiroRun {
  const bin = opts.bin ?? "kiro-cli";
  const run: RunProcess = opts.run ?? (promisify(execFile) as unknown as RunProcess);
  return async ({ prompt, sourceDir, trustTools }: KiroInvocation) => {
    const args = ["chat", "--no-interactive", `--trust-tools=${trustTools.join(",")}`, prompt];
    try {
      await run(bin, args, { cwd: sourceDir });
    } catch (err) {
      throw new Error(`kiro draft run failed (is kiro installed and on PATH?): ${String(err)}`);
    }
  };
}
