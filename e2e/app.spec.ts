import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

// End-to-end smoke: launch the REAL built app and drive the lifecycle through real IPC/preload.
// This is the one thing the jsdom test can't cover — the Electron contextBridge boundary.
let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ["."] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
});

test("fake ticket flows select → declare → draft → approve → run → review stop → resume → PRs", async () => {
  await expect(win.getByText(/Stream widget events into the replay pipeline/)).toBeVisible();

  // Pick the play off the roster, then declare the repos the seed story spans from the catalog.
  await win.getByRole("button", { name: /Stream widget events into the replay pipeline/ }).click();
  await win.getByRole("button", { name: /widget-api/ }).click();
  await win.getByRole("button", { name: /pipeline/ }).click();
  await win.getByRole("button", { name: /declare 2 & draft/i }).click();
  await expect(win.getByText("replay spec", { exact: true })).toBeVisible();

  await win.getByRole("button", { name: /approve spec set/i }).click();
  await win.getByRole("button", { name: /run story/i }).click();

  // Stops at the review-required replay spec; first spec merged.
  await expect(win.getByRole("button", { name: /resume after review/i })).toBeVisible();
  await expect(win.getByText("Merged").first()).toBeVisible();

  await win.getByRole("button", { name: /resume after review/i }).click();
  await win.getByRole("button", { name: /push & open prs/i }).click();

  await expect(win.getByText(/never auto-merged/i)).toBeVisible();

  await win.screenshot({ path: "test-results/dugout-final.png" });
});
