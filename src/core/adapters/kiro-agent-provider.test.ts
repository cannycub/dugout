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
