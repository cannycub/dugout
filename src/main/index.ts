import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Orchestrator } from "../core/orchestrator.js";
import type { Preflight } from "../core/domain.js";
import { CHANNELS } from "../shared/dugout-api.js";
import type { DeclaredRepo } from "../core/repo-scope.js";
import { createOrchestrator, broadcast } from "./orchestrator-host.js";

const here = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#0d1513",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(here, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload (electron-vite, type:module) requires the sandbox off; the renderer still
      // has no Node access and reaches the core only through the contextBridge'd DugoutApi.
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(here, "../renderer/index.html"));
  }
}

/** Register the IPC handlers that back the DugoutApi, broadcasting lifecycle transitions. */
function registerIpc(orchestrator: Orchestrator): void {
  const afterTransition = (storyKey: string, status: string) =>
    broadcast({ kind: "lifecycle", name: `story.${status}`, storyKey, status, at: Date.now() });

  ipcMain.handle(CHANNELS.listTickets, () => orchestrator.listAssignedTickets());

  ipcMain.handle(CHANNELS.getStory, (_e, key: string) => orchestrator.getStory(key) ?? null);

  ipcMain.handle(CHANNELS.draft, async (_e, key: string, repos: DeclaredRepo[]) => {
    const story = await orchestrator.draftStory(key, { repos });
    afterTransition(key, story.status);
    return story;
  });

  ipcMain.handle(CHANNELS.searchRepos, (_e, query: string) => orchestrator.searchRepos(query));
  ipcMain.handle(CHANNELS.declareRepos, (_e, names: string[]) => orchestrator.declareRepos(names));
  ipcMain.handle(CHANNELS.rescanRepos, () => orchestrator.rescanRepos());
  ipcMain.handle(CHANNELS.listWorkspaceRoots, () => orchestrator.listWorkspaceRoots());

  ipcMain.handle(CHANNELS.approve, async (_e, key: string, preflight: Preflight) => {
    const story = await orchestrator.approveStory(key, preflight);
    afterTransition(key, story.status);
    return story;
  });

  ipcMain.handle(CHANNELS.run, async (_e, key: string) => {
    const story = await orchestrator.runStory(key);
    afterTransition(key, story.status);
    return story;
  });

  ipcMain.handle(CHANNELS.resume, async (_e, key: string) => {
    const story = await orchestrator.resumeAfterReview(key);
    afterTransition(key, story.status);
    return story;
  });

  ipcMain.handle(CHANNELS.restart, async (_e, key: string) => {
    const story = await orchestrator.restartStory(key);
    afterTransition(key, story.status);
    return story;
  });

  ipcMain.handle(CHANNELS.createPullRequests, async (_e, key: string) => {
    const prs = await orchestrator.createPullRequests(key);
    afterTransition(key, "pr-created");
    return prs;
  });
}

app.whenReady().then(async () => {
  const orchestrator = await createOrchestrator(app.getPath("userData"));
  registerIpc(orchestrator);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => {
  // Startup wiring must not fail silently into a windowless app — surface and exit.
  console.error("[dugout] failed to start:", err);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
