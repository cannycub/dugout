// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import { DugoutProvider } from "./dugout-context.js";
import { createLocalDugoutApi, type LocalSeed } from "./local-dugout-api.js";
import { SEED_TICKET, SEED_DRAFT, SEED_CATALOG } from "../../main/seed.js";
import type { Ticket } from "../../core/ports/jira.js";
import type { DraftOutcome, ExecutorPort } from "../../core/ports/executor.js";
import type { DugoutApi } from "../../shared/dugout-api.js";
import type { Story } from "../../core/domain.js";
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

describe("App — clarification loop (#21)", () => {
  const ASK = (prompt: string, id = "q1"): DraftOutcome => ({
    result: "needs-clarification",
    questions: [{ id, prompt }],
  });

  it("opens the answer form with the agent's questions instead of dead-ending in the banner", async () => {
    renderApp({ draft: ASK("Soft-delete or hard-delete?") });

    fireEvent.click(await button(/Stream widget events/));
    fireEvent.click(await button(/widget-api/));
    fireEvent.click(await button(/declare 1 & draft/i));

    // The question is surfaced as an answerable field, not flattened into the error banner.
    expect(await screen.findByLabelText(/Soft-delete or hard-delete\?/i)).toBeTruthy();
    // Re-draft is gated until the question is answered (the agent needs every answer — invariant 1).
    const redraft = await button(/re-?draft/i);
    expect((redraft as HTMLButtonElement).disabled).toBe(true);
  });

  it("answers the question and re-drafts, converging to the drafted story", async () => {
    renderApp({
      draft: [
        ASK("Soft-delete or hard-delete?"),
        { result: "drafted", specs: [{ repo: "widget-api", markdown: "# Spec: emit events (widget-api)" }] },
      ],
    });

    fireEvent.click(await button(/Stream widget events/));
    fireEvent.click(await button(/widget-api/));
    fireEvent.click(await button(/declare 1 & draft/i));

    // Answer → the re-draft unlocks → it converges to the fan-out.
    fireEvent.change(await screen.findByLabelText(/Soft-delete or hard-delete\?/i), {
      target: { value: "Soft-delete only." },
    });
    fireEvent.click(await button(/re-?draft/i));
    expect(await screen.findByText(/emit events \(widget-api\)/)).toBeTruthy();
  });

  it("on a second clarification round keeps the earlier answers read-only above the new question", async () => {
    renderApp({
      draft: [
        ASK("Soft-delete or hard-delete?", "q1"),
        ASK("Paginate the list?", "q2"),
        { result: "drafted", specs: [{ repo: "widget-api", markdown: "# Spec (widget-api)" }] },
      ],
    });

    fireEvent.click(await button(/Stream widget events/));
    fireEvent.click(await button(/widget-api/));
    fireEvent.click(await button(/declare 1 & draft/i));

    // Round 1: answer the first question and re-draft.
    fireEvent.change(await screen.findByLabelText(/Soft-delete or hard-delete\?/i), {
      target: { value: "Soft-delete only." },
    });
    fireEvent.click(await button(/re-?draft/i));

    // Round 2: the new question shows, and the prior round's Q&A is preserved (collapsed) read-only.
    expect(await screen.findByLabelText(/Paginate the list\?/i)).toBeTruthy();
    expect(await screen.findByText(/Soft-delete only\./)).toBeTruthy();
    expect(await screen.findByText(/Earlier calls/i)).toBeTruthy();
  });

  it("abandons the loop and returns to the roster", async () => {
    renderApp({ draft: ASK("Soft-delete or hard-delete?") });

    fireEvent.click(await button(/Stream widget events/));
    fireEvent.click(await button(/widget-api/));
    fireEvent.click(await button(/declare 1 & draft/i));

    await screen.findByLabelText(/Soft-delete or hard-delete\?/i);
    fireEvent.click(await button(/abandon/i));

    // Back on the roster (the play is pickable again); the clarification form is gone.
    expect(await button(/Stream widget events/)).toBeTruthy();
    expect(screen.queryByLabelText(/Soft-delete or hard-delete\?/i)).toBeNull();
  });

  it("kicks back to needs-info mid-loop, dropping the rounds and surfacing the banner", async () => {
    renderApp({
      draft: [
        ASK("Soft-delete or hard-delete?"),
        { result: "needs-info", reason: "Even with answers, no acceptance criteria." },
      ],
    });

    fireEvent.click(await button(/Stream widget events/));
    fireEvent.click(await button(/widget-api/));
    fireEvent.click(await button(/declare 1 & draft/i));

    fireEvent.change(await screen.findByLabelText(/Soft-delete or hard-delete\?/i), {
      target: { value: "Soft-delete only." },
    });
    fireEvent.click(await button(/re-?draft/i));

    // The kickback banner shows and the clarifying view is gone (path forward is the Jira ticket).
    expect(await screen.findByText(/no acceptance criteria/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Soft-delete or hard-delete\?/i)).toBeNull();
  });
});

describe("App — waiting for the agent (#21)", () => {
  /** An executor whose draft() stays pending until the test releases it, so the in-flight
   *  waiting view can be observed before the result lands. */
  function deferredExecutor() {
    let release!: (outcome: DraftOutcome) => void;
    const pending = new Promise<DraftOutcome>((resolve) => {
      release = resolve;
    });
    const executor: ExecutorPort = {
      draft: () => pending,
      execute: async () => ({ result: "green", branch: "b" }),
    };
    return { executor, release: (o: DraftOutcome) => release(o) };
  }

  it("shows an on-the-mound waiting view while the first draft is in flight, then converges", async () => {
    const { executor, release } = deferredExecutor();
    renderApp({ executor });

    fireEvent.click(await button(/Stream widget events/));
    fireEvent.click(await button(/widget-api/));
    fireEvent.click(await button(/declare 1 & draft/i));

    // While the agent works, a dedicated waiting view stands in — not a frozen declare form.
    expect(await screen.findByText(/reading the play/i)).toBeTruthy();
    expect(screen.queryByLabelText(/search the catalog/i)).toBeNull();

    // When the draft lands, the waiting view gives way to the fan-out.
    release({ result: "drafted", specs: [{ repo: "widget-api", markdown: "# Spec (widget-api)" }] });
    expect(await screen.findByText(/Spec \(widget-api\)/)).toBeTruthy();
  });

  it("shows the waiting view while re-drafting, replacing the answered form (no blank limbo)", async () => {
    // Round 1 asks; the re-draft is held pending so we can observe the wait.
    let calls = 0;
    let release!: (outcome: DraftOutcome) => void;
    const second = new Promise<DraftOutcome>((resolve) => {
      release = resolve;
    });
    const executor: ExecutorPort = {
      draft: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve<DraftOutcome>({
              result: "needs-clarification",
              questions: [{ id: "q1", prompt: "Soft-delete or hard-delete?" }],
            })
          : second;
      },
      execute: async () => ({ result: "green", branch: "b" }),
    };
    renderApp({ executor });

    fireEvent.click(await button(/Stream widget events/));
    fireEvent.click(await button(/widget-api/));
    fireEvent.click(await button(/declare 1 & draft/i));

    fireEvent.change(await screen.findByLabelText(/Soft-delete or hard-delete\?/i), {
      target: { value: "Soft-delete only." },
    });
    fireEvent.click(await button(/re-?draft/i));

    // The answer form is replaced by the waiting view (not left blank with the answers cleared).
    expect(await screen.findByText(/reading your signs/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Soft-delete or hard-delete\?/i)).toBeNull();

    release({ result: "drafted", specs: [{ repo: "widget-api", markdown: "# Spec (widget-api)" }] });
    expect(await screen.findByText(/Spec \(widget-api\)/)).toBeTruthy();
  });
});

describe("App — clarification loop robustness (review fixes #1–#3)", () => {
  const ASK = (prompt: string, id = "q1"): DraftOutcome => ({
    result: "needs-clarification",
    questions: [{ id, prompt }],
  });

  // #1 — out-of-order resolve guard on ticket selection.
  it("ignores a stale getStory resolve after a newer ticket was selected", async () => {
    const A = SEED_TICKET; // "Stream widget events…"
    const B: Ticket = { key: "DUG-9", title: "Backfill ledger totals", description: "AC: sums" };
    const gate: Record<string, () => void> = {};
    const base = createLocalDugoutApi({
      tickets: [A, B],
      draft: SEED_DRAFT,
      repoScope: seedRepoScope(),
    });
    const api: DugoutApi = {
      ...base,
      getStory: (key: string) =>
        new Promise<Story | null>((resolve) => {
          gate[key] = () => resolve(null);
        }),
    };
    render(
      <DugoutProvider api={api}>
        <App />
      </DugoutProvider>,
    );

    // Select A, then B — B is the newer (intended) selection. Both getStory calls are pending.
    fireEvent.click(await button(/Stream widget events/));
    fireEvent.click(await button(/Backfill ledger totals/));

    // Resolve out of order: the newer B first, then the stale A.
    gate["DUG-9"]!();
    await waitFor(() => expect(screen.getByText("Backfill ledger totals")).toBeTruthy());
    gate["DUG-101"]!();

    // The stale A resolve must NOT clobber the view: we stay on B (A's title isn't shown).
    await waitFor(() => expect(screen.queryByText(/Stream widget events/)).toBeNull());
    expect(screen.getByText("Backfill ledger totals")).toBeTruthy();
  });

  // #2 — needs-info mid-loop keeps the already-declared repos.
  it("keeps the declared repos after a needs-info kickback so they needn't be re-picked", async () => {
    renderApp({
      draft: [ASK("Soft-delete or hard-delete?"), { result: "needs-info", reason: "Too thin to spec." }],
    });

    fireEvent.click(await button(/Stream widget events/));
    fireEvent.click(await button(/widget-api/));
    fireEvent.click(await button(/pipeline/));
    fireEvent.click(await button(/declare 2 & draft/i));

    fireEvent.change(await screen.findByLabelText(/Soft-delete or hard-delete\?/i), {
      target: { value: "Soft-delete only." },
    });
    fireEvent.click(await button(/re-?draft/i));

    // Kickback banner shows; we're back at declaring, but the two repos are still selected.
    expect(await screen.findByText(/too thin to spec/i)).toBeTruthy();
    expect(await button(/declare 2 & draft/i)).toBeTruthy();
  });

  // #3 — a failed re-draft preserves the typed answers.
  it("preserves typed answers when the re-draft throws", async () => {
    let calls = 0;
    const executor: ExecutorPort = {
      draft: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve<DraftOutcome>(ASK("Soft-delete or hard-delete?"))
          : Promise.reject(new Error("kiro unreachable"));
      },
      execute: async () => ({ result: "green", branch: "b" }),
    };
    renderApp({ executor });

    fireEvent.click(await button(/Stream widget events/));
    fireEvent.click(await button(/widget-api/));
    fireEvent.click(await button(/declare 1 & draft/i));

    fireEvent.change(await screen.findByLabelText(/Soft-delete or hard-delete\?/i), {
      target: { value: "Soft-delete only." },
    });
    fireEvent.click(await button(/re-?draft/i));

    // Error surfaces and the form returns with the answer intact (no retype).
    expect(await screen.findByText(/kiro unreachable/i)).toBeTruthy();
    const field = (await screen.findByLabelText(/Soft-delete or hard-delete\?/i)) as HTMLTextAreaElement;
    expect(field.value).toBe("Soft-delete only.");
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
