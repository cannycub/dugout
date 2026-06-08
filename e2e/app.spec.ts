import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end smoke: launch the REAL built app and drive the lifecycle through real IPC/preload.
// This is the one thing the jsdom test can't cover — the Electron contextBridge boundary.
//
// The e2e is deterministic against the fakes (testing pyramid), so every launch sets
// `DUGOUT_EXECUTOR=fakes` explicitly — the shipped app now defaults to live (real kiro) drafting
// (ADR-0010), which would fail here without a key. Each launch also gets a FRESH `--user-data-dir`
// so it never inherits persisted run-state.
let app: ElectronApplication;
let win: Page;
const tmpDirs: string[] = [];

async function freshUserDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dugout-e2e-userdata-"));
  tmpDirs.push(dir);
  return dir;
}

test.beforeAll(async () => {
  app = await electron.launch({
    args: [".", `--user-data-dir=${await freshUserDataDir()}`],
    env: { ...process.env, DUGOUT_EXECUTOR: "fakes" },
  });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test("fake ticket flows select → declare → draft → approve → run → review stop → resume → PRs", async () => {
  await expect(win.getByText(/Stream widget events into the replay pipeline/)).toBeVisible();

  // Pick the play off the roster, then declare the repos the seed story spans from the catalog.
  await win.getByRole("button", { name: /Stream widget events into the replay pipeline/ }).click();
  await win.getByRole("button", { name: /widget-api/ }).click();
  await win.getByRole("button", { name: /pipeline/ }).click();
  await win.getByRole("button", { name: /declare 2 & draft/i }).click();

  // The developer marks the second spec review-required at pre-flight (the agent no longer
  // designates replay specs — ADR-0008), so the run stops after the first spec merges.
  await expect(win.getByText("mark review-required").first()).toBeVisible();
  await win.getByRole("checkbox").nth(1).click();

  await win.getByRole("button", { name: /approve spec set/i }).click();
  await win.getByRole("button", { name: /run story/i }).click();

  // Stops at the review-required spec; first spec merged.
  await expect(win.getByRole("button", { name: /resume after review/i })).toBeVisible();
  await expect(win.getByText("Merged").first()).toBeVisible();

  await win.getByRole("button", { name: /resume after review/i }).click();
  await win.getByRole("button", { name: /push & open prs/i }).click();

  await expect(win.getByText(/never auto-merged/i)).toBeVisible();

  await win.screenshot({ path: "test-results/dugout-final.png" });
});

test("clarification loop: needs-clarification → answer → re-draft converges (real IPC, fakes)", async () => {
  // A second app instance seeded (env) with a two-round sequence so the loop is deterministic.
  const clarApp = await electron.launch({
    args: [".", `--user-data-dir=${await freshUserDataDir()}`],
    env: { ...process.env, DUGOUT_EXECUTOR: "fakes", DUGOUT_SEED_CLARIFY: "1" },
  });
  const clar = await clarApp.firstWindow();
  try {
    await clar.getByRole("button", { name: /Stream widget events into the replay pipeline/ }).click();
    // Declare the repos the seed fan-out spans (widget-api + pipeline) so the converged draft is valid.
    await clar.getByRole("button", { name: /widget-api/ }).click();
    await clar.getByRole("button", { name: /pipeline/ }).click();
    await clar.getByRole("button", { name: /declare 2 & draft/i }).click();

    // While the agent drafts (the seed delays it), the on-the-mound waiting view stands in.
    await expect(clar.getByText(/reading the play/i)).toBeVisible();
    await clar.waitForTimeout(450); // let the entrance fade settle for the artifact screenshot
    await clar.screenshot({ path: "test-results/dugout-drafting.png" });

    // The agent's question round-trips through preload/IPC and renders as an answerable field.
    const answer = clar.getByLabel(/Soft-delete or hard-delete\?/i);
    await expect(answer).toBeVisible();
    await answer.fill("Soft-delete only.");
    await clar.screenshot({ path: "test-results/dugout-clarify.png" });

    // Answering hands off to the re-draft waiting view, then converges to the fan-out.
    await clar.getByRole("button", { name: /re-?draft/i }).click();
    await expect(clar.getByText(/reading your signs/i)).toBeVisible();
    await clar.waitForTimeout(450); // let the entrance fade settle for the artifact screenshot
    await clar.screenshot({ path: "test-results/dugout-redrafting.png" });
    await expect(clar.getByText(/emit widget mutation events/i)).toBeVisible();
  } finally {
    await clarApp.close();
  }
});
