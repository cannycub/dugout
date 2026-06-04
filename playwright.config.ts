import { defineConfig } from "@playwright/test";

// E2E launches the real built Electron app (out/). Run via `npm run test:e2e`, which builds first.
// Kept out of the default `npm test` (vitest) because it needs a display and the built artifacts.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: "list",
});
