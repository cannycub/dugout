import { describe, it, expect } from "vitest";
import { commandRunnerAgent } from "./command-runner-agent.js";

describe("commandRunnerAgent", () => {
  it("runs the repo's test command, forced to exit 0 (the suite's non-zero exit must not throw)", () => {
    const agent = commandRunnerAgent("npm test -- --reporter=json");
    const { command } = agent.buildPrintCommand({ prompt: "ignored", dangerouslySkipPermissions: true });
    expect(command).toContain("npm test -- --reporter=json");
    expect(command).toMatch(/exit 0\s*$/);
  });

  it("ignores the prompt — it is a command, not an LLM invocation", () => {
    const agent = commandRunnerAgent("pytest -q");
    const a = agent.buildPrintCommand({ prompt: "foo", dangerouslySkipPermissions: true });
    const b = agent.buildPrintCommand({ prompt: "bar", dangerouslySkipPermissions: true });
    expect(a.command).toBe(b.command);
  });

  it("echoes each stdout line as a text event so RunResult.stdout carries the full report", () => {
    const agent = commandRunnerAgent("x");
    expect(agent.parseStreamLine('{"testResults":[]}')).toEqual([{ type: "text", text: '{"testResults":[]}' }]);
  });

  it("does not capture sessions (it is not an agent with a resumable session)", () => {
    expect(commandRunnerAgent("x").captureSessions).toBe(false);
  });
});
