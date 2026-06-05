import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { Story, Spec } from "../../core/domain.js";
import type { Ticket } from "../../core/ports/jira.js";
import type { PullRequest } from "../../core/ports/github.js";
import type { RepoMatch, CloneBinding } from "../../core/repo-scope.js";
import { useDugout } from "./dugout-context.js";
import { SPEC_META, RIBBON_STAGES, stageIndex } from "./lifecycle.js";

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
}: {
  onDeclare: (names: string[]) => void;
  busy: boolean;
}) {
  const dugout = useDugout();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RepoMatch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
