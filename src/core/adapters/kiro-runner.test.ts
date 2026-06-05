import { describe, it, expect } from "vitest";
import { spawnKiroRunner } from "./kiro-runner.js";
import type { KiroInvocation } from "./kiro-draft-adapter.js";

const INVOCATION: KiroInvocation = {
  prompt: "PROMPT BODY",
  sourceDir: "/work/T/source",
  specsDir: "/work/T/specs",
  trustTools: ["read", "grep"],
};

describe("spawnKiroRunner", () => {
  it("invokes kiro-cli headless with read-only tool trust, the prompt, and cwd at the source mount", async () => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const runner = spawnKiroRunner({
      run: async (file, args, opts) => {
        calls.push({ file, args, cwd: opts.cwd });
      },
    });

    await runner(INVOCATION);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("kiro-cli");
    expect(calls[0]!.args).toEqual([
      "chat",
      "--no-interactive",
      "--trust-tools=read,grep",
      "PROMPT BODY",
    ]);
    expect(calls[0]!.cwd).toBe("/work/T/source");
  });

  it("honours a custom kiro binary path", async () => {
    const calls: string[] = [];
    const runner = spawnKiroRunner({
      bin: "/opt/kiro/kiro-cli",
      run: async (file) => {
        calls.push(file);
      },
    });

    await runner(INVOCATION);

    expect(calls[0]).toBe("/opt/kiro/kiro-cli");
  });

  it("surfaces a clear error when the kiro process fails (e.g. not installed)", async () => {
    const runner = spawnKiroRunner({
      run: async () => {
        throw new Error("spawn kiro-cli ENOENT");
      },
    });

    await expect(runner(INVOCATION)).rejects.toThrow(/kiro/i);
  });
});
