import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Orchestrator, type ReviewFeedback, type DraftFeedback } from "../core/orchestrator.js";
import type { Preflight } from "../core/domain.js";
import { CHANNELS } from "../shared/dugout-api.js";
import type { DeclaredRepo } from "../core/repo-scope.js";
import type { ClarificationRound } from "../core/ports/executor.js";
import { createOrchestrator } from "./orchestrator-host.js";
import type { SettingsApi } from "./settings-controls.js";
import type { JiraCredentialsInput } from "../shared/dugout-api.js";

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

/** Register the IPC handlers that back the DugoutApi. Lifecycle transitions stream from the
 * core's LifecyclePort (wired in orchestrator-host, #27) — no per-handler re-derivation here. */
function registerIpc(orchestrator: Orchestrator): void {
  ipcMain.handle(CHANNELS.listTickets, () => orchestrator.listAssignedTickets());

  ipcMain.handle(CHANNELS.getStory, (_e, key: string) => orchestrator.getStory(key) ?? null);

  ipcMain.handle(
    CHANNELS.draft,
    async (_e, key: string, repos: DeclaredRepo[], clarifications?: ClarificationRound[]) => {
      return orchestrator.draftStory(key, {
        repos,
        ...(clarifications ? { clarifications } : {}),
      });
    },
  );

  ipcMain.handle(CHANNELS.searchRepos, (_e, query: string) => orchestrator.searchRepos(query));
  ipcMain.handle(CHANNELS.declareRepos, (_e, names: string[]) => orchestrator.declareRepos(names));
  ipcMain.handle(CHANNELS.rescanRepos, () => orchestrator.rescanRepos());
  ipcMain.handle(CHANNELS.listWorkspaceRoots, () => orchestrator.listWorkspaceRoots());

  ipcMain.handle(CHANNELS.approve, (_e, key: string, preflight: Preflight) =>
    orchestrator.approveStory(key, preflight),
  );

  ipcMain.handle(CHANNELS.run, (_e, key: string) => orchestrator.runStory(key));

  ipcMain.handle(CHANNELS.resume, (_e, key: string) => orchestrator.resumeAfterReview(key));

  ipcMain.handle(CHANNELS.restart, (_e, key: string) => orchestrator.restartStory(key));

  ipcMain.handle(CHANNELS.createPullRequests, (_e, key: string) =>
    orchestrator.createPullRequests(key),
  );

  ipcMain.handle(CHANNELS.submitReviewFeedback, (_e, key: string, feedback: ReviewFeedback) =>
    orchestrator.submitReviewFeedback(key, feedback),
  );

  ipcMain.handle(CHANNELS.amendSpec, (_e, key: string, specId: string, markdown: string) =>
    orchestrator.amendSpec(key, specId, markdown),
  );

  ipcMain.handle(CHANNELS.reviseDraft, (_e, key: string, feedback: DraftFeedback) =>
    orchestrator.reviseDraft(key, feedback),
  );

  ipcMain.handle(CHANNELS.editSpecDraft, (_e, key: string, specId: string, markdown: string) =>
    orchestrator.editSpecDraft(key, specId, markdown),
  );
}

/** Settings IPC (#17): thin pass-throughs to the host-side settings controls. */
function registerSettingsIpc(settings: SettingsApi): void {
  ipcMain.handle(CHANNELS.getSettings, () => settings.getSettings());
  ipcMain.handle(CHANNELS.saveWorkspaceRoots, (_e, roots: string[]) => settings.saveWorkspaceRoots(roots));
  ipcMain.handle(CHANNELS.saveJiraCredentials, (_e, creds: JiraCredentialsInput) =>
    settings.saveJiraCredentials(creds),
  );
  ipcMain.handle(CHANNELS.clearJiraCredentials, () => settings.clearJiraCredentials());
  ipcMain.handle(CHANNELS.saveGitHubToken, (_e, token: string) => settings.saveGitHubToken(token));
  ipcMain.handle(CHANNELS.clearGitHubToken, () => settings.clearGitHubToken());
}

app.whenReady().then(async () => {
  const { orchestrator, settings } = await createOrchestrator(app.getPath("userData"));
  registerIpc(orchestrator);
  registerSettingsIpc(settings);
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
