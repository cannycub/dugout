import { useCallback, useEffect, useState } from "react";
import type { Story } from "../../core/domain.js";
import type { Ticket } from "../../core/ports/jira.js";
import type { PullRequest } from "../../core/ports/github.js";
import type { DeclaredRepo } from "../../core/repo-scope.js";
import { useDugout } from "./dugout-context.js";
import { StatusRibbon, StoryPanel, CoachCalls, SpecLineup, PrBanner } from "./components.js";

const STORY_KEY = "DUG-101";
const DECLARED_REPOS = ["widget-api", "pipeline"];
// Temporary until D2's declare-repos UI builds DeclaredRepo[] from searchRepos results.
const asDeclared = (name: string): DeclaredRepo => ({
  identity: { name, remote: "" },
  clone: { status: "not-cloned" },
});

export function App() {
  const dugout = useDugout();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [reviewSel, setReviewSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the seed ticket + any existing run-state. (Telemetry still flows to the metrics port /
  // Datadog in the background; it is intentionally not surfaced in the UI.)
  useEffect(() => {
    void (async () => {
      const tickets = await dugout.listTickets();
      setTicket(tickets.find((t) => t.key === STORY_KEY) ?? tickets[0] ?? null);
      setStory(await dugout.getStory(STORY_KEY));
    })();
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

  const onDraft = () =>
    guard(async () => setStory(await dugout.draft(STORY_KEY, DECLARED_REPOS.map(asDeclared))));
  const onApprove = () =>
    guard(async () =>
      setStory(await dugout.approve(STORY_KEY, { reviewRequired: [...reviewSel] })),
    );
  const onRun = () => guard(async () => setStory(await dugout.run(STORY_KEY)));
  const onResume = () => guard(async () => setStory(await dugout.resume(STORY_KEY)));
  const onRestart = () => guard(async () => setStory(await dugout.restart(STORY_KEY)));
  const onCreatePRs = () =>
    guard(async () => {
      setPrs(await dugout.createPullRequests(STORY_KEY));
      setStory(await dugout.getStory(STORY_KEY));
    });

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

      <main className="stage">
        <div className="col col-left">
          <StoryPanel ticket={ticket} repos={DECLARED_REPOS} />
          <CoachCalls
            story={story}
            busy={busy}
            onDraft={onDraft}
            onApprove={onApprove}
            onRun={onRun}
            onResume={onResume}
            onRestart={onRestart}
            onCreatePRs={onCreatePRs}
          />
        </div>

        <div className="col col-center">
          <SpecLineup story={story} reviewSel={reviewSel} onToggleReview={onToggleReview} />
        </div>
      </main>

      <footer className="footer">
        Assistive, never autonomous · stops at “PR created” · never auto-merges
      </footer>
    </div>
  );
}
