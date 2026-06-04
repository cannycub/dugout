import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Main and preload externalize node/native deps (electron, better-sqlite3) instead of bundling.
// The renderer is a standard React (Vite) build rooted at src/renderer.
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] },
});
