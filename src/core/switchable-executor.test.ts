import { describe, it, expect } from "vitest";
import { SwitchableExecutor } from "./switchable-executor.js";
import { FakeExecutor } from "./fakes/fake-executor.js";
import type { ExecutorPort, ExecuteInput } from "./ports/executor.js";

const fake = () =>
  new FakeExecutor({ draft: { result: "drafted", specs: [{ repo: "web", markdown: "# fake" }] } });

/** A stand-in for the live (kiro) executor: a distinct draft, and an execute that must never run. */
const live = (): ExecutorPort => ({
  draft: async () => ({ result: "drafted", specs: [{ repo: "web", markdown: "# live" }] }),
  execute: async () => {
    throw new Error("live execute should never be called");
  },
});

const input: ExecuteInput = { specId: "s1", repo: "web", markdown: "#", storyBranch: "b" };

describe("SwitchableExecutor", () => {
  it("routes draft to the live executor in live mode and to the fake in fakes mode", async () => {
    const live_ = new SwitchableExecutor({ fake: fake(), live: live(), mode: "live" });
    expect(await live_.draft({ ticket: { key: "T", title: "", description: "" }, repos: [] })).toEqual({
      result: "drafted",
      specs: [{ repo: "web", markdown: "# live" }],
    });

    const fakes = new SwitchableExecutor({ fake: fake(), live: live(), mode: "fakes" });
    expect(await fakes.draft({ ticket: { key: "T", title: "", description: "" }, repos: [] })).toEqual({
      result: "drafted",
      specs: [{ repo: "web", markdown: "# fake" }],
    });
  });

  it("always routes execute to the fake executor, even in live mode (no real execute adapter yet)", async () => {
    const exec = new SwitchableExecutor({ fake: fake(), live: live(), mode: "live" });
    // The live stub's execute throws; reaching the fake's green outcome proves execute is never live.
    expect(await exec.execute(input)).toEqual({ result: "green", branch: "s1-branch" });
  });

  it("switches mode at runtime via setMode, with getMode reflecting it", async () => {
    const exec = new SwitchableExecutor({ fake: fake(), live: live(), mode: "fakes" });
    expect(exec.getMode()).toBe("fakes");

    exec.setMode("live");
    expect(exec.getMode()).toBe("live");
    expect((await exec.draft({ ticket: { key: "T", title: "", description: "" }, repos: [] })).result).toBe(
      "drafted",
    );
    expect(await exec.draft({ ticket: { key: "T", title: "", description: "" }, repos: [] })).toEqual({
      result: "drafted",
      specs: [{ repo: "web", markdown: "# live" }],
    });
  });
});
