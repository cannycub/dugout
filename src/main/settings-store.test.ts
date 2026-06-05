import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "./settings-store.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dugout-settings-"));
  path = join(dir, "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("defaults the executor mode to fakes when no settings file exists", () => {
    expect(new SettingsStore(path).load()).toEqual({ executorMode: "fakes" });
  });

  it("round-trips a saved executor mode", () => {
    const store = new SettingsStore(path);
    store.save({ executorMode: "live" });
    expect(new SettingsStore(path).load()).toEqual({ executorMode: "live" });
  });

  it("degrades to the default on a corrupt settings file (never throws at startup)", async () => {
    await writeFile(path, "{ not json");
    expect(new SettingsStore(path).load()).toEqual({ executorMode: "fakes" });
  });

  it("ignores an unknown mode value, falling back to fakes", async () => {
    await writeFile(path, JSON.stringify({ executorMode: "wat" }));
    expect(new SettingsStore(path).load()).toEqual({ executorMode: "fakes" });
  });
});
