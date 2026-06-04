import { motion } from "motion/react";
import type { Story, Spec } from "../../core/domain.js";
import type { Ticket } from "../../core/ports/jira.js";
import type { PullRequest } from "../../core/ports/github.js";
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
