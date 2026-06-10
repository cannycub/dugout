import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSettingsControls, SwappableJira, type SettingsApi } from "./settings-controls.js";
import { SettingsStore } from "./settings-store.js";
import { SecretsStore } from "./secrets-store.js";
import type { SafeStorageLike } from "./jira-credentials.js";
import type { JiraPort, Ticket } from "../core/ports/jira.js";
import { FakeJira } from "../core/fakes/fake-jira.js";

const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ""),
};

const SEED: Ticket = { key: "SEED-1", title: "Seed", description: "" };
const LIVE: Ticket = { key: "LIVE-1", title: "Live", description: "" };

let dir: string;
let controls: SettingsApi;
let jira: SwappableJira;
let appliedRoots: string[][];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dugout-settingsctl-"));
  const fallback = new FakeJira({ tickets: [SEED] });
  jira = new SwappableJira(fallback);
  appliedRoots = [];
  controls = makeSettingsControls({
    settingsStore: new SettingsStore(join(dir, "settings.json")),
    secrets: new SecretsStore(join(dir, "secrets.enc"), fakeSafe),
    jira,
    fallbackJira: fallback,
    makeJiraAdapter: () => new FakeJira({ tickets: [LIVE] }) as JiraPort,
    applyWorkspaceRoots: async (roots) => {
      appliedRoots.push(roots);
    },
    encryptionAvailable: () => true,
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settings controls (#17)", () => {
  it("persists workspace roots and applies them to the live workspace (no restart)", async () => {
    const view = await controls.saveWorkspaceRoots([" /ws/a ", "", "/ws/b"]);

    expect(view.workspaceRoots).toEqual(["/ws/a", "/ws/b"]);
    expect(appliedRoots).toEqual([["/ws/a", "/ws/b"]]); // reached the live thunk + rescan
    // Survives a fresh load (settings.json round-trip).
    expect((await controls.getSettings()).workspaceRoots).toEqual(["/ws/a", "/ws/b"]);
  });

  it("saving Jira credentials swaps the live port to the real adapter; clearing reverts to the fake", async () => {
    expect((await jira.listAssignedTickets())[0]!.key).toBe("SEED-1");

    const view = await controls.saveJiraCredentials({ baseUrl: "https://a", email: "d@a", token: "t" });
    expect(view.jira).toEqual({ baseUrl: "https://a", email: "d@a", configured: true });
    expect((await jira.listAssignedTickets())[0]!.key).toBe("LIVE-1"); // swapped live

    const cleared = await controls.clearJiraCredentials();
    expect(cleared.jira.configured).toBe(false);
    expect((await jira.listAssignedTickets())[0]!.key).toBe("SEED-1"); // reverted
  });

  it("never sends the token back to the renderer — only its presence", async () => {
    await controls.saveJiraCredentials({ baseUrl: "https://a", email: "d@a", token: "SECRET" });
    const view = await controls.getSettings();
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("persists a GitHub token through the keyed store (consumption deferred)", async () => {
    expect((await controls.getSettings()).github.configured).toBe(false);
    expect((await controls.saveGitHubToken("ghp_x")).github.configured).toBe(true);
    expect((await controls.clearGitHubToken()).github.configured).toBe(false);
  });

  it("reports encryption availability for the UI's secure-storage notice", async () => {
    expect((await controls.getSettings()).encryptionAvailable).toBe(true);
  });
});
