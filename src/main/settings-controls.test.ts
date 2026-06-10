import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSettingsControls, SwappableJira, SwappableGitHub, type SettingsApi } from "./settings-controls.js";
import { SettingsStore } from "./settings-store.js";
import { SecretsStore } from "./secrets-store.js";
import type { SafeStorageLike } from "./jira-credentials.js";
import type { JiraPort, Ticket } from "../core/ports/jira.js";
import { FakeJira } from "../core/fakes/fake-jira.js";
import type { GitHubPort, OrgRepo } from "../core/ports/github.js";
import { FakeGitHub } from "../core/fakes/fake-github.js";

const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ""),
};

const SEED: Ticket = { key: "SEED-1", title: "Seed", description: "" };
const LIVE: Ticket = { key: "LIVE-1", title: "Live", description: "" };
const SEED_REPO: OrgRepo = { name: "seed-repo", remote: "git@github.com:seed/seed-repo.git" };
const LIVE_REPO: OrgRepo = { name: "live-repo", remote: "git@github.com:acme/live-repo.git" };

let dir: string;
let controls: SettingsApi;
let jira: SwappableJira;
let github: SwappableGitHub;
let appliedRoots: string[][];
let appliedKiro: (string | null)[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dugout-settingsctl-"));
  const fallback = new FakeJira({ tickets: [SEED] });
  jira = new SwappableJira(fallback);
  const fallbackGitHub = new FakeGitHub([SEED_REPO]);
  github = new SwappableGitHub(fallbackGitHub);
  appliedRoots = [];
  appliedKiro = [];
  controls = makeSettingsControls({
    settingsStore: new SettingsStore(join(dir, "settings.json")),
    secrets: new SecretsStore(join(dir, "secrets.enc"), fakeSafe),
    jira,
    fallbackJira: fallback,
    makeJiraAdapter: () => new FakeJira({ tickets: [LIVE] }) as JiraPort,
    github,
    fallbackGitHub,
    makeGitHubAdapter: () => new FakeGitHub([LIVE_REPO]) as GitHubPort,
    applyWorkspaceRoots: async (roots) => {
      appliedRoots.push(roots);
    },
    applyKiroApiKey: (key) => {
      appliedKiro.push(key);
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

  it("saving GitHub config swaps the live catalog port to the real adapter; clearing reverts to the fake", async () => {
    expect((await github.listOrgRepos())[0]!.name).toBe("seed-repo");

    const view = await controls.saveGitHubConfig({ org: "acme", token: "ghp_x" });
    expect(view.github).toEqual({ org: "acme", configured: true });
    expect((await github.listOrgRepos())[0]!.name).toBe("live-repo"); // swapped live

    const cleared = await controls.clearGitHubConfig();
    expect(cleared.github.configured).toBe(false);
    expect(cleared.github.org).toBe("acme"); // org retained — re-entering the token reconnects
    expect((await github.listOrgRepos())[0]!.name).toBe("seed-repo"); // reverted
  });

  it("never sends the GitHub token back to the renderer — only org + presence", async () => {
    await controls.saveGitHubConfig({ org: "acme", token: "ghp_SECRET" });
    expect(JSON.stringify(await controls.getSettings())).not.toContain("ghp_SECRET");
  });

  it("saving the kiro API key applies it to the live executor; clearing reverts to the startup fallback", async () => {
    expect((await controls.getSettings()).kiro.configured).toBe(false);

    expect((await controls.saveKiroApiKey("kiro_x")).kiro.configured).toBe(true);
    expect(appliedKiro).toEqual(["kiro_x"]); // reached the live executor, no restart

    expect((await controls.clearKiroApiKey()).kiro.configured).toBe(false);
    expect(appliedKiro).toEqual(["kiro_x", null]); // reverted live
  });

  it("reports encryption availability for the UI's secure-storage notice", async () => {
    expect((await controls.getSettings()).encryptionAvailable).toBe(true);
  });
});
