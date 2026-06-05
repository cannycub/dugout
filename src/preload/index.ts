import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNELS, type DugoutApi, type DugoutEvent } from "../shared/dugout-api.js";

/**
 * The IPC implementation of {@link DugoutApi}, exposed on `window.dugout`. This is the ONLY place
 * Electron APIs are touched on the renderer side; React components depend on the interface.
 */
const api: DugoutApi = {
  listTickets: () => ipcRenderer.invoke(CHANNELS.listTickets),
  getStory: (key) => ipcRenderer.invoke(CHANNELS.getStory, key),
  draft: (key, repos) => ipcRenderer.invoke(CHANNELS.draft, key, repos),
  searchRepos: (query) => ipcRenderer.invoke(CHANNELS.searchRepos, query),
  rescanRepos: () => ipcRenderer.invoke(CHANNELS.rescanRepos),
  listWorkspaceRoots: () => ipcRenderer.invoke(CHANNELS.listWorkspaceRoots),
  approve: (key, preflight) => ipcRenderer.invoke(CHANNELS.approve, key, preflight),
  run: (key) => ipcRenderer.invoke(CHANNELS.run, key),
  resume: (key) => ipcRenderer.invoke(CHANNELS.resume, key),
  restart: (key) => ipcRenderer.invoke(CHANNELS.restart, key),
  createPullRequests: (key) => ipcRenderer.invoke(CHANNELS.createPullRequests, key),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: DugoutEvent) => listener(payload);
    ipcRenderer.on(CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld("dugout", api);
