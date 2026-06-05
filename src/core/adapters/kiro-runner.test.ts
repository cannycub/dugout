import { describe, it, expect, afterEach } from "vitest";
import { spawnKiroRunner } from "./kiro-runner.js";
import type { KiroInvocation } from "./kiro-draft-adapter.js";

const INVOCATION: KiroInvocation = {
  prompt: "PROMPT BODY",
  sourceDir: "/work/T/source",
  trustTools: ["fs_read"],
};

const ok = (stdout: string) => async () => ({ stdout });

const savedKey = process.env["KIRO_API_KEY"];
afterEach(() => {
  if (savedKey === undefined) delete process.env["KIRO_API_KEY"];
  else process.env["KIRO_API_KEY"] = savedKey;
});

type Captured = { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

describe("spawnKiroRunner", () => {
  it("invokes kiro-cli headless read-only (no output-format flag) with the prompt + API key, returning stdout verbatim", async () => {
    const calls: Captured[] = [];
    const runner = spawnKiroRunner({
      apiKey: "sk-test",
      run: async (file, args, opts) => {
        calls.push({ file, args, cwd: opts.cwd, env: opts.env });
        return { stdout: "===DUGOUT BEGIN===\nRESULT: needs-info\nx\n===DUGOUT END===" };
      },
    });

    const stdout = await runner(INVOCATION);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("kiro-cli");
    // No --format/--output-format: that flag is for list commands only; chat prints the model's
    // text response (with tool narration), which the adapter scans for the DUGOUT block. --wrap
    // never keeps long sentinel/markdown lines from being terminal-width-wrapped.
    expect(calls[0]!.args).toEqual([
      "chat",
      "--no-interactive",
      "--wrap",
      "never",
      "--trust-tools=fs_read",
      "PROMPT BODY",
    ]);
    expect(calls[0]!.cwd).toBe("/work/T/source");
    // kiro headless authenticates via KIRO_API_KEY in the environment (kiro.dev/docs/cli/headless).
    expect(calls[0]!.env["KIRO_API_KEY"]).toBe("sk-test");
    // The runner returns kiro's stdout for the adapter to locate + parse the DUGOUT block.
    expect(stdout).toBe("===DUGOUT BEGIN===\nRESULT: needs-info\nx\n===DUGOUT END===");
  });

  it("defaults the API key to process.env.KIRO_API_KEY when not passed explicitly", async () => {
    process.env["KIRO_API_KEY"] = "sk-from-env";
    let captured: NodeJS.ProcessEnv | undefined;
    const runner = spawnKiroRunner({
      run: async (_file, _args, opts) => {
        captured = opts.env;
        return { stdout: "" };
      },
    });

    await runner(INVOCATION);

    expect(captured!["KIRO_API_KEY"]).toBe("sk-from-env");
  });

  it("strips ANSI escape codes kiro emits when piped, leaving the block intact for the adapter", async () => {
    const block = "===DUGOUT BEGIN===\nRESULT: needs-info\nx\n===DUGOUT END===";
    const runner = spawnKiroRunner({
      apiKey: "sk-test",
      // kiro emits colour codes when its stdout is piped (#8352) even with --no-interactive.
      run: async () => ({ stdout: `[32m${block}[0m` }),
    });

    expect(await runner(INVOCATION)).toBe(block);
  });

  it("fails with a clear error (naming KIRO_API_KEY) when no key is available", async () => {
    delete process.env["KIRO_API_KEY"];
    const runner = spawnKiroRunner({ run: ok("") });

    await expect(runner(INVOCATION)).rejects.toThrow(/KIRO_API_KEY/);
  });

  it("honours a custom kiro binary path", async () => {
    const calls: string[] = [];
    const runner = spawnKiroRunner({
      bin: "/opt/kiro/kiro-cli",
      apiKey: "sk-test",
      run: async (file) => {
        calls.push(file);
        return { stdout: "" };
      },
    });

    await runner(INVOCATION);

    expect(calls[0]).toBe("/opt/kiro/kiro-cli");
  });

  it("surfaces a clear error when the kiro process fails (e.g. not installed)", async () => {
    const runner = spawnKiroRunner({
      apiKey: "sk-test",
      run: async () => {
        throw new Error("spawn kiro-cli ENOENT");
      },
    });

    await expect(runner(INVOCATION)).rejects.toThrow(/kiro/i);
  });
});
