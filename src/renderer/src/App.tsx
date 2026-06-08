import { useCallback, useEffect, useRef, useState } from "react";
import type { Story } from "../../core/domain.js";
import type { Ticket } from "../../core/ports/jira.js";
import type { PullRequest } from "../../core/ports/github.js";
import type { ClarifyingQuestion, ClarificationRound } from "../../core/ports/executor.js";
import type { DeclaredRepo } from "../../core/repo-scope.js";
import type { DraftStoryResult } from "../../core/orchestrator.js";
import { useDugout } from "./dugout-context.js";
import {
  StatusRibbon,
  StoryPanel,
  CoachCalls,
  SpecLineup,
  AnswerForm,
  DraftingView,
  PrBanner,
  TicketRoster,
  DeclareRepos,
} from "./components.js";

/**
 * The explicit phase of the command board (replacing the old implicit `story === null`). The
 * discriminant is `type`; each arm co-locates exactly the payload its phase owns — notably the
 * `clarifying` arm carries the in-flight clarification loop (declared repos + growing rounds), which
 * is held only here in memory (stateless — the dev's answers are user input, not rebuildable
 * run-state). See the #21 design.
 */
type View =
  | { type: "roster" }
  // `repos` carries any already-declared repos back into the declare step (e.g. after a needs-info
  // kickback) so the developer doesn't re-pick them; absent on the first visit.
  | { type: "declaring"; ticket: Ticket; repos?: DeclaredRepo[] }
  | {
      type: "clarifying";
      ticket: Ticket;
      repos: DeclaredRepo[];
      questions: ClarifyingQuestion[];
      rounds: ClarificationRound[];
      // The just-typed answers, repopulated when a re-draft fails so they aren't lost; absent on a
      // fresh round.
      draftAnswers?: Record<string, string>;
    }
  // The agent is drafting (a slow read-only run) — a dedicated waiting phase so the prior form
  // isn't frozen and a re-draft doesn't strand the just-typed answers. `kind` shapes the copy;
  // `round` is the round being drafted (re-draft only).
  | {
      type: "drafting";
      ticket: Ticket;
      repos: DeclaredRepo[];
      rounds: ClarificationRound[];
      kind: "draft" | "redraft";
    }
  | { type: "story"; story: Story };

export function App() {
  const dugout = useDugout();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [view, setView] = useState<View>({ type: "roster" });
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [reviewSel, setReviewSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the developer's assigned tickets (their roster). Telemetry still flows to the metrics
  // port / Datadog in the background; it is intentionally not surfaced in the UI.
  useEffect(() => {
    void dugout.listTickets().then(setTickets);
  }, [dugout]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const onToggleReview = useCallback((id: string) => {
    setReviewSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const backToRoster = () => {
    setView({ type: "roster" });
    setPrs([]);
    setReviewSel(new Set());
    setError(null);
  };

  // The most recently selected ticket; an in-flight getStory only applies its result if its key is
  // still the latest selection, so a slow resolve can't clobber a newer pick (out-of-order guard).
  const selectionRef = useRef<string | null>(null);

  // Selecting a play loads any existing run-state for it (a parked story re-opens); otherwise the
  // developer starts at declaring repos.
  const onSelect = (key: string) => {
    const ticket = tickets.find((t) => t.key === key);
    if (!ticket) return;
    selectionRef.current = key;
    void guard(async () => {
      const existing = await dugout.getStory(key);
      if (selectionRef.current !== key) return; // a newer selection superseded this one
      setView(existing ? { type: "story", story: existing } : { type: "declaring", ticket });
    });
  };

  /**
   * Route a draft outcome to the next view. `drafted` converges to the story; `needs-clarification`
   * (re-)enters the loop with the accumulated rounds rendered read-only; `needs-info` is terminal to
   * Jira (ADR-0007) — drop the rounds, fall back to declaring, and surface the kickback banner.
   */
  const applyDraftResult = (
    result: DraftStoryResult,
    ticket: Ticket,
    repos: DeclaredRepo[],
    rounds: ClarificationRound[],
  ) => {
    if (result.outcome === "drafted") {
      setView({ type: "story", story: result.story });
    } else if (result.outcome === "needs-info") {
      // Terminal to Jira: drop the rounds but keep the declared repos so a retry (after editing the
      // ticket) doesn't force re-declaring them.
      setView({ type: "declaring", ticket, ...(repos.length ? { repos } : {}) });
      setError(`Ticket needs more info: ${result.reason}`);
    } else {
      setView({ type: "clarifying", ticket, repos, questions: result.questions, rounds });
    }
  };

  const onDeclareAndDraft = (names: string[]) =>
    guard(async () => {
      if (view.type !== "declaring") return;
      const { ticket } = view;
      // Bind the chosen names server-side (authoritative, fresh), then draft the fan-out.
      const repos = await dugout.declareRepos(names);
      // Hand off to the waiting view while the agent works (a slow read-only run).
      setView({ type: "drafting", ticket, repos, rounds: [], kind: "draft" });
      try {
        const result = await dugout.draft(ticket.key, repos);
        applyDraftResult(result, ticket, repos, []);
      } catch (err) {
        // Restore declaring with the repos still selected so the error banner has context and the
        // dev needn't re-pick them.
        setView({ type: "declaring", ticket, ...(repos.length ? { repos } : {}) });
        throw err;
      }
    });

  // Re-draft with the developer's answers folded into the growing rounds (oldest-first).
  const onAnswer = (answers: ClarificationRound["answers"]) =>
    guard(async () => {
      if (view.type !== "clarifying") return;
      const { ticket, repos, questions, rounds: prior } = view;
      const rounds = [...prior, { answers }];
      // Leave the answered form for the waiting view — no blank limbo while the agent re-drafts.
      setView({ type: "drafting", ticket, repos, rounds, kind: "redraft" });
      try {
        const result = await dugout.draft(ticket.key, repos, rounds);
        applyDraftResult(result, ticket, repos, rounds);
      } catch (err) {
        // Restore the clarifying view with the original questions AND the just-typed answers so a
        // transient draft failure doesn't make the dev retype them.
        const draftAnswers = Object.fromEntries(answers.map((a) => [a.questionId, a.answer]));
        setView({ type: "clarifying", ticket, repos, questions, rounds: prior, draftAnswers });
        throw err;
      }
    });

  const storyKey = view.type === "story" ? view.story.key : "";
  const onApprove = () =>
    guard(async () =>
      setView({ type: "story", story: await dugout.approve(storyKey, { reviewRequired: [...reviewSel] }) }),
    );
  const onRun = () => guard(async () => setView({ type: "story", story: await dugout.run(storyKey) }));
  const onResume = () =>
    guard(async () => setView({ type: "story", story: await dugout.resume(storyKey) }));
  const onRestart = () =>
    guard(async () => setView({ type: "story", story: await dugout.restart(storyKey) }));
  const onCreatePRs = () =>
    guard(async () => {
      setPrs(await dugout.createPullRequests(storyKey));
      const refreshed = await dugout.getStory(storyKey);
      if (refreshed) setView({ type: "story", story: refreshed });
    });

  // The story's scope is what the developer declared — not re-derived from the fan-out's specs.
  const panelTicket =
    view.type === "story"
      ? tickets.find((t) => t.key === view.story.key) ?? null
      : view.type === "roster"
        ? null
        : view.ticket;
  const panelRepos =
    view.type === "story"
      ? view.story.declaredRepos
      : view.type === "clarifying" || view.type === "drafting"
        ? view.repos.map((r) => r.identity.name)
        : view.type === "declaring"
          ? (view.repos ?? []).map((r) => r.identity.name)
          : [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="wordmark">DUGOUT</span>
          <span className="tagline">the head coach's command post</span>
        </div>
      </header>

      <StatusRibbon story={view.type === "story" ? view.story : null} />

      {error && <div className="error-bar">⚠ {error}</div>}
      <PrBanner prs={prs} />

      {view.type === "roster" ? (
        <main className="stage stage-roster">
          <TicketRoster tickets={tickets} onSelect={onSelect} />
        </main>
      ) : (
        <main className="stage">
          <div className="col col-left">
            <StoryPanel ticket={panelTicket} repos={panelRepos} />
            {view.type === "story" ? (
              <CoachCalls
                story={view.story}
                busy={busy}
                onDraft={() => undefined}
                onApprove={onApprove}
                onRun={onRun}
                onResume={onResume}
                onRestart={onRestart}
                onCreatePRs={onCreatePRs}
              />
            ) : view.type === "declaring" ? (
              <button type="button" className="back-btn" onClick={backToRoster}>
                ◂ Back to the roster
              </button>
            ) : null}
          </div>

          <div className="col col-center">
            {view.type === "story" ? (
              <SpecLineup story={view.story} reviewSel={reviewSel} onToggleReview={onToggleReview} />
            ) : view.type === "clarifying" ? (
              <AnswerForm
                questions={view.questions}
                rounds={view.rounds}
                busy={busy}
                onSubmit={onAnswer}
                onAbandon={backToRoster}
                {...(view.draftAnswers ? { initialAnswers: view.draftAnswers } : {})}
              />
            ) : view.type === "drafting" ? (
              <DraftingView
                repos={panelRepos}
                kind={view.kind}
                {...(view.kind === "redraft" ? { round: view.rounds.length } : {})}
              />
            ) : (
              <DeclareRepos
                onDeclare={onDeclareAndDraft}
                busy={busy}
                {...(view.repos ? { initialSelected: view.repos.map((r) => r.identity.name) } : {})}
              />
            )}
          </div>
        </main>
      )}

      <footer className="footer">
        Assistive, never autonomous · stops at “PR created” · never auto-merges
      </footer>
    </div>
  );
}
