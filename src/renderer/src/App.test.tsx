// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { App } from "./App.js";
import { DugoutProvider } from "./dugout-context.js";
import { createLocalDugoutApi } from "./local-dugout-api.js";
import { SEED_TICKET, SEED_DRAFT } from "../../main/seed.js";

afterEach(cleanup);

function renderApp() {
  const api = createLocalDugoutApi({ ticket: SEED_TICKET, draft: SEED_DRAFT });
  render(
    <DugoutProvider api={api}>
      <App />
    </DugoutProvider>,
  );
}

const button = (name: RegExp) => screen.findByRole("button", { name });

describe("App — fake ticket through the full lifecycle, observable in the UI", () => {
  it("drives draft → approve → run → review stop → resume → PRs", async () => {
    renderApp();

    // The seed ticket loads.
    expect(await screen.findByText(/Stream widget events into the replay pipeline/)).toBeTruthy();

    // Draft → the fan-out appears, including the replay spec.
    fireEvent.click(await button(/declare repos & draft/i));
    expect(await screen.findByText("replay spec")).toBeTruthy();

    // Approve as a unit → the run call becomes available.
    fireEvent.click(await button(/approve spec set/i));
    const runBtn = await button(/run story/i);

    // Run → stops at the review-required replay spec; the first spec is merged, the run paused.
    fireEvent.click(runBtn);
    const resumeBtn = await button(/resume after review/i);
    expect(await screen.findByText("Merged")).toBeTruthy();

    // Resume after review → remaining specs run; the story becomes dev-complete.
    fireEvent.click(resumeBtn);
    const prBtn = await button(/push & open prs/i);

    // Open PRs → the never-auto-merged banner appears.
    fireEvent.click(prBtn);
    expect(await screen.findByText(/never auto-merged/i)).toBeTruthy();
  });
});
