// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import { DugoutProvider } from "./dugout-context.js";
import { createLocalDugoutApi, type LocalSeed } from "./local-dugout-api.js";
import { SEED_TICKET, SEED_DRAFT, SEED_CATALOG } from "../../main/seed.js";
import type { Ticket } from "../../core/ports/jira.js";
import { RepoScope } from "../../core/repo-scope.js";
import { FakeCatalog } from "../../core/fakes/fake-catalog.js";
import { FakeWorkspace } from "../../core/fakes/fake-workspace.js";

afterEach(cleanup);

function seedRepoScope() {
  return new RepoScope(
    new FakeCatalog(SEED_CATALOG),
    new FakeWorkspace({
      // Only widget-api is cloned locally; pipeline/ledger resolve as "not cloned".
      roots: ["/ws"],
      clones: [{ path: "/ws/widget-api", originRemote: "git@github.com:acme/widget-api.git" }],
    }),
  );
}

function renderApp(overrides: Partial<LocalSeed> = {}) {
  const api = createLocalDugoutApi({
    tickets: [SEED_TICKET],
    draft: SEED_DRAFT,
    repoScope: seedRepoScope(),
    ...overrides,
  });
  render(
    <DugoutProvider api={api}>
      <App />
    </DugoutProvider>,
  );
}

const button = (name: RegExp) => screen.findByRole("button", { name });

describe("App — ticket selection (D1)", () => {
  it("shows the assigned roster and selecting a ticket opens the declare-repos step", async () => {
    const second: Ticket = { key: "DUG-9", title: "Backfill ledger totals", description: "AC: sums" };
    renderApp({ tickets: [SEED_TICKET, second] });

    // Both assigned tickets appear on the roster.
    expect(await screen.findByText(/Stream widget events/)).toBeTruthy();
    expect(await screen.findByText("Backfill ledger totals")).toBeTruthy();

    // Picking one advances to declaring repos (the catalog search box appears).
    fireEvent.click(await button(/Backfill ledger totals/));
    expect(await screen.findByLabelText(/search the catalog/i)).toBeTruthy();
  });
});

describe("App — declare repos (D2)", () => {
  it("filters the catalog, surfaces clone status, and a not-cloned repo is still selectable", async () => {
    // A fan-out that targets the not-cloned repo we declare (ledger), so draft stays valid.
    renderApp({
      draft: { result: "drafted", specs: [{ repo: "ledger", markdown: "# Backfill ledger totals (ledger)" }] },
    });
    fireEvent.click(await button(/Stream widget events/));

    // The catalog lists every repo with its clone-status badge.
    expect(await screen.findByText("widget-api")).toBeTruthy();
    expect(await screen.findByText("cloned")).toBeTruthy();
    expect(await screen.findAllByText("not cloned")).toBeTruthy();

    // Filter-as-you-type narrows the list to the match.
    fireEvent.change(await screen.findByLabelText(/search the catalog/i), {
      target: { value: "ledger" },
    });
    expect(await screen.findByText("ledger")).toBeTruthy();
    expect(screen.queryByText("widget-api")).toBeNull();

    // A not-cloned repo is selectable and declaring it drafts the story.
    fireEvent.click(await button(/ledger/));
    fireEvent.click(await button(/declare 1 & draft/i));
    expect(await screen.findByText("Backfill ledger totals (ledger)")).toBeTruthy();
  });
});

describe("App — fake ticket through the full lifecycle, observable in the UI", () => {
  it("drives select → declare → draft → approve → run → review stop → resume → PRs", async () => {
    renderApp();

    // Pick the seed play off the roster.
    fireEvent.click(await button(/Stream widget events/));

    // Declare the repos the seed story spans → the fan-out appears.
    fireEvent.click(await button(/widget-api/));
    fireEvent.click(await button(/pipeline/));
    fireEvent.click(await button(/declare 2 & draft/i));

    // The developer marks the second spec review-required at pre-flight (the agent no longer
    // designates replay specs — ADR-0008), so the run will stop after the first spec merges.
    const reviewToggles = await screen.findAllByText("mark review-required");
    fireEvent.click(reviewToggles[1]!);

    // Approve as a unit → the run call becomes available.
    fireEvent.click(await button(/approve spec set/i));
    const runBtn = await button(/run story/i);

    // Run → stops at the review-required spec; the first spec is merged, the run paused.
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

describe("App — draft executor selector", () => {
  it("reflects the current executor mode and switches it on click", async () => {
    renderApp();

    const fakes = await screen.findByRole("button", { name: "FAKES" });
    const live = screen.getByRole("button", { name: "LIVE" });

    // Starts in fakes (the safe default).
    expect(fakes.getAttribute("aria-pressed")).toBe("true");
    expect(live.getAttribute("aria-pressed")).toBe("false");

    // Switching to live flips the active segment (persisted through the DugoutApi).
    fireEvent.click(live);
    await waitFor(() => expect(live.getAttribute("aria-pressed")).toBe("true"));
    expect(fakes.getAttribute("aria-pressed")).toBe("false");
  });
});
