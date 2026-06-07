import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { Story, Spec } from "../../core/domain.js";
import type { Ticket } from "../../core/ports/jira.js";
import type { PullRequest } from "../../core/ports/github.js";
import type { ClarifyingQuestion, ClarificationRound } from "../../core/ports/executor.js";
import type { RepoMatch, CloneBinding } from "../../core/repo-scope.js";
import type { ExecutorMode } from "../../shared/dugout-api.js";
import { useDugout } from "./dugout-context.js";
import { SPEC_META, RIBBON_STAGES, stageIndex } from "./lifecycle.js";

/* ── Draft executor selector: fakes ↔ live (real kiro), lives in the topbar ─────────────── */

const MODE_SEGMENTS: Array<{ value: ExecutorMode; label: string; title: string }> = [
  { value: "fakes", label: "FAKES", title: "Drafting uses in-memory fakes — no kiro" },
  { value: "live", label: "LIVE", title: "Drafting runs the real kiro agent, read-only" },
];

/**
 * The topbar's status chip is also the control for which executor backs drafting. The dot is a
 * floodlight that shifts turf-green (fakes, local & safe) → amber (live, the real agent is hot).
 * Reads/writes the mode through the DugoutApi only (never Electron directly — ADR-0001).
 */
export function ExecutorModeSelector() {
  const dugout = useDugout();
  const [mode, setMode] = useState<ExecutorMode | null>(null);

  useEffect(() => {
    let active = true;
    void dugout.getExecutorMode().then((m) => {
      if (active) setMode(m);
    });
    return () => {
      active = false;
    };
  }, [dugout]);

  if (!mode) return null;

  const choose = (next: ExecutorMode) => {
    if (next === mode) return;
    setMode(next); // optimistic; the switch is best-effort and reflected immediately
    void dugout.setExecutorMode(next);
  };

  return (
    <div className="mode-switch" data-mode={mode} role="group" aria-label="Draft executor">
      <span className="mode-dot" aria-hidden="true" />
      <span className="mode-label">DRAFT</span>
      <div className="mode-seg-group">
        {MODE_SEGMENTS.map((seg) => (
          <button
            key={seg.value}
            type="button"
            className={`mode-seg ${mode === seg.value ? "active" : ""}`}
            aria-pressed={mode === seg.value}
            title={seg.title}
            onClick={() => choose(seg.value)}
          >
            {seg.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Status ribbon: the lifecycle base path ─────────────────────────────────────────────── */

export function StatusRibbon({ story }: { story: Story | null }) {
  const current = story ? stageIndex(story.status) : -1;
  const failed = story?.status === "failed";
  return (
    <div className="ribbon" role="list" aria-label="Story lifecycle">
      {RIBBON_STAGES.map((stage, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        const danger = failed && stage.status === "executing";
        return (
          <div className="ribbon-stage" role="listitem" key={stage.status}>
            <span className={`base-dot ${state} ${danger ? "danger" : ""}`}>
              {state === "done" ? "●" : i + 1}
            </span>
            <span className={`base-label ${state}`}>{danger ? "Failed" : stage.label}</span>
            {i < RIBBON_STAGES.length - 1 && (
              <span className={`base-line ${i < current ? "done" : ""}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Story panel ────────────────────────────────────────────────────────────────────────── */

export function StoryPanel({ ticket, repos }: { ticket: Ticket | null; repos: string[] }) {
  if (!ticket) return <div className="panel story-panel muted">No ticket loaded…</div>;
  return (
    <div className="panel story-panel">
      <div className="panel-eyebrow">The play</div>
      <div className="ticket-key">{ticket.key}</div>
      <h2 className="ticket-title">{ticket.title}</h2>
      <p className="ticket-desc">{ticket.description}</p>
      <div className="repos">
        {repos.map((r) => (
          <span className="repo-chip" key={r}>
            {r}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Coach's calls: the available transition ───────────────────────────────────────────── */

interface CoachCallsProps {
  story: Story | null;
  busy: boolean;
  onDraft: () => void;
  onApprove: () => void;
  onRun: () => void;
  onResume: () => void;
  onRestart: () => void;
  onCreatePRs: () => void;
}

export function CoachCalls(props: CoachCallsProps) {
  const { story, busy } = props;
  const status = story?.status;

  const call = (() => {
    if (!story) return { label: "Declare repos & draft", fn: props.onDraft, tone: "clay" };
    switch (status) {
      case "drafted":
        return { label: "Approve spec set as a unit", fn: props.onApprove, tone: "clay" };
      case "approved":
        return { label: "Run story ▸", fn: props.onRun, tone: "amber" };
      case "awaiting-review":
        return { label: "Resume after review ▸", fn: props.onResume, tone: "clay" };
      case "failed":
        return { label: "Restart clean", fn: props.onRestart, tone: "danger" };
      case "dev-complete":
        return { label: "Push & open PRs", fn: props.onCreatePRs, tone: "turf" };
      default:
        return null;
    }
  })();

  return (
    <div className="panel coach-panel">
      <div className="panel-eyebrow">Coach's call</div>
      {status === "executing" && (
        <div className="running-note">
          <span className="pulse-dot" /> Specs are on the field…
        </div>
      )}
      {status === "awaiting-review" && (
        <p className="review-note">
          A <strong>review-required</strong> spec is green. Review the code before the next spec
          stacks on it.
        </p>
      )}
      {status === "pr-created" && (
        <p className="done-note">Story dev-complete — fully-linked PRs opened. The merge is yours.</p>
      )}
      {call && (
        <button className={`call-btn ${call.tone}`} disabled={busy} onClick={call.fn}>
          {busy ? "Working…" : call.label}
        </button>
      )}
      <p className="coach-hint">
        The developer is the head coach. Every gate — approval, review, merge — is your call.
      </p>
    </div>
  );
}

/* ── Fan-out lineup ─────────────────────────────────────────────────────────────────────── */

interface SpecLineupProps {
  story: Story | null;
  reviewSel: Set<string>;
  onToggleReview: (id: string) => void;
}

export function SpecLineup({ story, reviewSel, onToggleReview }: SpecLineupProps) {
  if (!story) {
    return (
      <div className="field empty-field">
        <p className="muted">No fan-out yet. Draft the ticket to decompose it into specs.</p>
      </div>
    );
  }
  const editable = story.status === "drafted";
  return (
    <div className="field">
      <div className="field-head">
        <span className="panel-eyebrow">Fan-out</span>
        <span className="field-count">
          {story.specs.length} {story.specs.length === 1 ? "spec" : "specs"}
        </span>
      </div>
      <div className="lineup">
        {story.specs.map((spec, i) => (
          <SpecCard
            key={spec.id}
            spec={spec}
            index={i}
            editable={editable}
            reviewSelected={spec.isReplaySpec || reviewSel.has(spec.id)}
            replayLocked={spec.isReplaySpec}
            onToggleReview={() => onToggleReview(spec.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface SpecCardProps {
  spec: Spec;
  index: number;
  editable: boolean;
  reviewSelected: boolean;
  replayLocked: boolean;
  onToggleReview: () => void;
}

function SpecCard({ spec, index, editable, reviewSelected, replayLocked, onToggleReview }: SpecCardProps) {
  const meta = SPEC_META[spec.status];
  const title = spec.markdown.split("\n", 1)[0]?.replace(/^#\s*/, "") ?? spec.id;
  const awaiting = spec.status === "green";
  return (
    <motion.div
      className={`spec-card ${spec.status} ${awaiting ? "awaiting" : ""}`}
      layout
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.07, type: "spring", stiffness: 260, damping: 26 }}
    >
      <div className="spec-jersey">{index + 1}</div>
      <div className="spec-body">
        <div className="spec-toprow">
          <span className="spec-repo">{spec.repo}</span>
          <span className="spec-chip" style={{ color: meta.token, borderColor: meta.token }}>
            <span className="chip-dot" style={{ background: meta.token }} />
            {meta.label}
          </span>
        </div>
        <h3 className="spec-title">{title}</h3>
        <div className="spec-badges">
          {spec.isReplaySpec && <span className="badge replay">replay spec</span>}
          {(spec.reviewRequired || (editable && reviewSelected)) && (
            <span className="badge review">review-required</span>
          )}
          <span className="spec-id">{spec.id}</span>
        </div>
        {editable && (
          <label className={`review-toggle ${replayLocked ? "locked" : ""}`}>
            <input
              type="checkbox"
              checked={reviewSelected}
              disabled={replayLocked}
              onChange={onToggleReview}
            />
            {replayLocked ? "review-required (replay default)" : "mark review-required"}
          </label>
        )}
      </div>
    </motion.div>
  );
}

/* ── Ticket roster: pick the play (D1) ──────────────────────────────────────────────────── */

export function TicketRoster({
  tickets,
  onSelect,
}: {
  tickets: Ticket[];
  onSelect: (key: string) => void;
}) {
  return (
    <div className="field roster-field">
      <div className="field-head">
        <span className="panel-eyebrow">Today's roster</span>
        <span className="field-count">
          {tickets.length} {tickets.length === 1 ? "play" : "plays"} assigned
        </span>
      </div>
      {tickets.length === 0 ? (
        <p className="muted">No tickets assigned to you. Nothing to call from the dugout yet.</p>
      ) : (
        <div className="roster">
          {tickets.map((ticket, i) => (
            <motion.button
              type="button"
              className="roster-card"
              key={ticket.key}
              onClick={() => onSelect(ticket.key)}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, type: "spring", stiffness: 260, damping: 26 }}
            >
              <span className="roster-key">{ticket.key}</span>
              <h3 className="roster-title">{ticket.title}</h3>
              <p className="roster-desc">{ticket.description}</p>
              <span className="roster-cta">Take the mound ▸</span>
            </motion.button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Declare repos: field your repos (D2) ───────────────────────────────────────────────── */

const CLONE_META: Record<CloneBinding["status"], { label: string; tone: string }> = {
  cloned: { label: "cloned", tone: "cloned" },
  "not-cloned": { label: "not cloned", tone: "not-cloned" },
  ambiguous: { label: "ambiguous", tone: "ambiguous" },
};

function CloneBadge({ clone }: { clone: CloneBinding }) {
  const meta = CLONE_META[clone.status];
  const detail =
    clone.status === "cloned"
      ? clone.path
      : clone.status === "ambiguous"
        ? `${clone.candidates.length} clones`
        : "selectable";
  return (
    <span className={`clone-badge ${meta.tone}`} title={detail}>
      <span className="clone-dot" />
      {meta.label}
    </span>
  );
}

export function DeclareRepos({
  onDeclare,
  busy,
  initialSelected,
}: {
  onDeclare: (names: string[]) => void;
  busy: boolean;
  /** Repo names to pre-select (e.g. re-entering declare after a needs-info kickback). */
  initialSelected?: string[];
}) {
  const dugout = useDugout();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RepoMatch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected ?? []));
  const [rescanning, setRescanning] = useState(false);

  useEffect(() => {
    let live = true;
    void dugout.searchRepos(query).then((r) => {
      if (live) setResults(r);
    });
    return () => {
      live = false;
    };
  }, [dugout, query]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      await dugout.rescanRepos();
      setResults(await dugout.searchRepos(query));
    } finally {
      setRescanning(false);
    }
  };

  // Hand the chosen names up; binding is re-resolved server-side at declare time.
  const declare = () => onDeclare([...selected]);

  return (
    <div className="field declare-field">
      <div className="field-head">
        <span className="panel-eyebrow">Field your repos</span>
        <button type="button" className="rescan-btn" onClick={rescan} disabled={rescanning}>
          {rescanning ? "rescanning…" : "↻ rescan"}
        </button>
      </div>

      <input
        className="declare-search"
        type="text"
        placeholder="Search the catalog…"
        aria-label="Search the catalog"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="repo-results">
        {results.length === 0 ? (
          <p className="muted small">No repos match “{query}”.</p>
        ) : (
          results.map((match) => {
            const isSel = selected.has(match.identity.name);
            return (
              <button
                type="button"
                className={`repo-result ${isSel ? "selected" : ""}`}
                key={match.identity.name}
                aria-pressed={isSel}
                onClick={() => toggle(match.identity.name)}
              >
                <span className="repo-check" aria-hidden>
                  {isSel ? "✓" : ""}
                </span>
                <span className="repo-meta">
                  <span className="result-name">{match.identity.name}</span>
                  <span className="result-remote">{match.identity.remote}</span>
                </span>
                <CloneBadge clone={match.clone} />
              </button>
            );
          })
        )}
      </div>

      <div className="declare-actions">
        <span className="declare-count">
          {selected.size} {selected.size === 1 ? "repo" : "repos"} declared
        </span>
        <button
          type="button"
          className="call-btn clay declare-btn"
          disabled={busy || selected.size === 0}
          onClick={declare}
        >
          {busy ? "Working…" : `Declare ${selected.size || ""} & draft ▸`}
        </button>
      </div>
    </div>
  );
}

/* ── Mound visit: the clarification answer form (#21) ───────────────────────────────────── */

interface AnswerFormProps {
  /** The questions the agent is currently blocked on. */
  questions: ClarifyingQuestion[];
  /** Earlier answered rounds this loop, oldest-first (shown collapsed, read-only on round 2+). */
  rounds: ClarificationRound[];
  busy: boolean;
  /** Hand the freshly-answered round up so the harness re-drafts with the full continuity. */
  onSubmit: (answers: ClarificationRound["answers"]) => void;
  /** Drop the in-memory rounds and walk off — the only exit besides convergence. */
  onAbandon: () => void;
  /** Pre-fill answers (by question id) — used to repopulate the form after a failed re-draft. */
  initialAnswers?: Record<string, string>;
}

/**
 * A mound visit: the agent can spec the play but won't guess (invariant 1), so it stops to ask the
 * head coach. Every question must be answered before the re-draft is allowed; on round 2+ the
 * earlier calls are kept collapsed and read-only above the new questions, and Abandon walks the
 * loop off the field. Stateless — the growing rounds live in the App's view-state.
 */
export function AnswerForm({
  questions,
  rounds,
  busy,
  onSubmit,
  onAbandon,
  initialAnswers,
}: AnswerFormProps) {
  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswers ?? {});
  const allAnswered = questions.every((q) => (answers[q.id] ?? "").trim().length > 0);

  const submit = () => {
    if (!allAnswered) return;
    onSubmit(
      questions.map((q) => ({
        questionId: q.id,
        question: q.prompt,
        answer: (answers[q.id] ?? "").trim(),
      })),
    );
    // No need to clear: submitting hands off to the waiting view, unmounting this form; if the
    // re-draft asks again it remounts fresh, and a failed draft restores the form fresh too.
  };

  return (
    <div className="field clarify-field">
      <div className="field-head">
        <span className="panel-eyebrow">Mound visit</span>
        <span className="field-count">round {rounds.length + 1}</span>
      </div>

      <p className="clarify-note">
        The agent can spec this play — but it won't guess. Answer{" "}
        <strong>
          {questions.length} {questions.length === 1 ? "question" : "questions"}
        </strong>{" "}
        and it re-drafts.
      </p>

      {rounds.length > 0 && (
        <details className="clarify-prior">
          <summary>
            Earlier calls · {rounds.length} {rounds.length === 1 ? "round" : "rounds"}
          </summary>
          {rounds.map((round, ri) => (
            <div className="prior-round" key={ri}>
              <span className="prior-round-tag">round {ri + 1}</span>
              {round.answers.map((a, ai) => (
                <div className="prior-qa" key={ai}>
                  <p className="prior-q">{a.question}</p>
                  <p className="prior-a">{a.answer}</p>
                </div>
              ))}
            </div>
          ))}
        </details>
      )}

      <div className="clarify-questions">
        {questions.map((q, i) => (
          <div className="clarify-q" key={q.id}>
            <div className="clarify-q-head">
              <span className="clarify-q-num">{i + 1}</span>
              <span className="clarify-q-text">{q.prompt}</span>
            </div>
            <textarea
              className="clarify-answer"
              aria-label={q.prompt}
              rows={2}
              placeholder="Your call…"
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <div className="declare-actions">
        <button type="button" className="back-btn" onClick={onAbandon}>
          ◂ Abandon
        </button>
        <button
          type="button"
          className="call-btn clay declare-btn"
          disabled={busy || !allAnswered}
          onClick={submit}
        >
          {busy ? "Working…" : "Re-draft ▸"}
        </button>
      </div>
    </div>
  );
}

/* ── On the mound: the agent-is-drafting waiting view (#21) ──────────────────────────────── */

interface DraftingViewProps {
  /** The declared repos the agent is scouting (for context while it works). */
  repos: string[];
  /** A cold first draft vs. a re-draft folding in the dev's answers — shapes the copy. */
  kind: "draft" | "redraft";
  /** On a re-draft, which round is being drafted (1-based). */
  round?: number;
}

/**
 * Drafting is a real read-only agent run — slow on the live path. Rather than freeze the prior form
 * (and, on a re-draft, blank out the just-typed answers), the loop hands off to this dedicated
 * waiting view: floodlight rings pulse off the mound while the agent reads the play. Purely
 * presentational; the App owns the in-flight `drafting` view-state and swaps it for the result.
 */
export function DraftingView({ repos, kind, round }: DraftingViewProps) {
  const headline = kind === "redraft" ? "Reading your signs" : "Reading the play";
  const sub =
    kind === "redraft"
      ? "Folding your answers back in and re-drafting the fan-out…"
      : "Scouting the declared repos and drafting the fan-out…";
  const eyebrow = kind === "redraft" ? `Re-draft · round ${round ?? 1}` : "On the mound";

  return (
    <div className="field drafting-field" role="status" aria-live="polite">
      <div className="mound" aria-hidden="true">
        <span className="mound-ring r1" />
        <span className="mound-ring r2" />
        <span className="mound-ring r3" />
        <span className="mound-core" />
      </div>
      <motion.div
        className="drafting-copy"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 240, damping: 26 }}
      >
        <span className="panel-eyebrow">{eyebrow}</span>
        <h3 className="drafting-headline">{headline}</h3>
        <p className="drafting-sub">{sub}</p>
        {repos.length > 0 && (
          <div className="drafting-repos">
            {repos.map((r) => (
              <span className="repo-chip" key={r}>
                {r}
              </span>
            ))}
          </div>
        )}
        <p className="drafting-hint">Read-only — the agent never touches your clones. A live run can take a moment.</p>
      </motion.div>
    </div>
  );
}

/* ── PR banner ──────────────────────────────────────────────────────────────────────────── */

export function PrBanner({ prs }: { prs: PullRequest[] }) {
  if (prs.length === 0) return null;
  return (
    <motion.div
      className="pr-banner"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <span className="pr-flag">PRs opened · never auto-merged</span>
      {prs.map((pr) => (
        <span className="pr-link" key={pr.repo}>
          <strong>{pr.repo}</strong> <span className="pr-url">{pr.url}</span>
        </span>
      ))}
    </motion.div>
  );
}
