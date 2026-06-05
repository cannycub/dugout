import { useCallback, useEffect, useState } from "react";
import type { Story } from "../../core/domain.js";
import type { Ticket } from "../../core/ports/jira.js";
import type { PullRequest } from "../../core/ports/github.js";
import type { DeclaredRepo } from "../../core/repo-scope.js";
import { useDugout } from "./dugout-context.js";
import {
  StatusRibbon,
  StoryPanel,
  CoachCalls,
  SpecLineup,
  PrBanner,
  TicketRoster,
  DeclareRepos,
} from "./components.js";

export function App() {
  const dugout = useDugout();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [reviewSel, setReviewSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the developer's assigned tickets (their roster). Telemetry still flows to the metrics
  // port / Datadog in the background; it is intentionally not surfaced in the UI.
  useEffect(() => {
    void dugout.listTickets().then(setTickets);
  }, [dugout]);

  // When a ticket is picked, load any existing run-state for it. Guard against an out-of-order
  // resolve when the developer switches tickets quickly, so a stale story can't overwrite the
  // current selection (mirrors the search guard in DeclareRepos).
  useEffect(() => {
    if (!selectedKey) {
      setStory(null);
      return;
    }
    let live = true;
    void dugout.getStory(selectedKey).then((s) => {
      if (live) setStory(s);
    });
    return () => {
      live = false;
    };
  }, [dugout, selectedKey]);

  const selectedTicket = tickets.find((t) => t.key === selectedKey) ?? null;
  // The story's scope is what the developer declared — not re-derived from the specs the fan-out
  // produced (a declared repo may have no spec). declaredRepos is the source of truth.
  const repoNames = story ? story.declaredRepos : [];

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

  const key = selectedKey ?? "";
  const onDeclareAndDraft = (repos: DeclaredRepo[]) =>
    guard(async () => setStory(await dugout.draft(key, repos)));
  const onApprove = () =>
    guard(async () => setStory(await dugout.approve(key, { reviewRequired: [...reviewSel] })));
  const onRun = () => guard(async () => setStory(await dugout.run(key)));
  const onResume = () => guard(async () => setStory(await dugout.resume(key)));
  const onRestart = () => guard(async () => setStory(await dugout.restart(key)));
  const onCreatePRs = () =>
    guard(async () => {
      setPrs(await dugout.createPullRequests(key));
      setStory(await dugout.getStory(key));
    });

  const onBackToRoster = () => {
    setSelectedKey(null);
    setStory(null);
    setPrs([]);
    setReviewSel(new Set());
    setError(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="wordmark">DUGOUT</span>
          <span className="tagline">the head coach's command post</span>
        </div>
        <div className="mode">
          <span className="mode-dot" />
          LOCAL · FAKES
        </div>
      </header>

      <StatusRibbon story={story} />

      {error && <div className="error-bar">⚠ {error}</div>}
      <PrBanner prs={prs} />

      {!selectedKey ? (
        <main className="stage stage-roster">
          <TicketRoster tickets={tickets} onSelect={setSelectedKey} />
        </main>
      ) : (
        <main className="stage">
          <div className="col col-left">
            <StoryPanel ticket={selectedTicket} repos={repoNames} />
            {story ? (
              <CoachCalls
                story={story}
                busy={busy}
                onDraft={() => undefined}
                onApprove={onApprove}
                onRun={onRun}
                onResume={onResume}
                onRestart={onRestart}
                onCreatePRs={onCreatePRs}
              />
            ) : (
              <button type="button" className="back-btn" onClick={onBackToRoster}>
                ◂ Back to the roster
              </button>
            )}
          </div>

          <div className="col col-center">
            {story ? (
              <SpecLineup story={story} reviewSel={reviewSel} onToggleReview={onToggleReview} />
            ) : (
              <DeclareRepos onDeclare={onDeclareAndDraft} busy={busy} />
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
