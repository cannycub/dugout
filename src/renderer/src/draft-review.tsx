import { useState } from "react";
import type { Story, ReviewThreadEntry } from "../../core/domain.js";
import { lineDiff } from "./line-diff.js";

/**
 * The spec review loop panel (#5): PR-review-style iteration on a drafted set. Agent = author,
 * developer = reviewer. Conversational feedback first (fan-out → spec → section granularity),
 * direct markdown edit as the escape hatch (applied verbatim, never overridden), revisions shown
 * as diffs, the persisted thread underneath.
 */
const SECTIONS = ["acceptance criteria", "test plan", "approach", "expected change"] as const;

export interface DraftReviewProps {
  story: Story;
  /** Each spec's markdown as of the PREVIOUS revision, by spec id — drives the diff view. */
  previous: Map<string, string>;
  busy: boolean;
  onRevise: (scope: ReviewThreadEntry["scope"], content: string) => void;
  onDirectEdit: (specId: string, markdown: string) => void;
}

export function DraftReview({ story, previous, busy, onRevise, onDirectEdit }: DraftReviewProps) {
  const [scopeKind, setScopeKind] = useState<"set" | "spec" | "section">("set");
  const [specId, setSpecId] = useState(story.specs[0]?.id ?? "");
  const [section, setSection] = useState<string>(SECTIONS[0]);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [diffing, setDiffing] = useState<string | null>(null);

  const scope = (): ReviewThreadEntry["scope"] =>
    scopeKind === "set"
      ? { kind: "set" }
      : scopeKind === "spec"
        ? { kind: "spec", specId }
        : { kind: "section", specId, section };

  const thread = story.reviewThread ?? [];

  return (
    <div className="field draft-review">
      <div className="field-head">
        <span className="panel-eyebrow">Spec review</span>
        <span className="field-count">round {thread.length + 1}</span>
      </div>
      <p className="muted small">
        Review the fan-out first — split, merge, reorder — then individual specs and sections.
        Conversational feedback re-drafts consistently; direct edits are yours and never overridden.
      </p>

      <div className="bench-modes" role="radiogroup" aria-label="Feedback granularity">
        {(
          [
            ["set", "fan-out / set", "split · merge · reorder · repo boundaries"],
            ["spec", "one spec", "scope, framing, the whole document"],
            ["section", "one section", "AC · test plan · approach · expected change"],
          ] as const
        ).map(([kind, label, hint]) => (
          <label key={kind} className={`bench-mode ${scopeKind === kind ? "active" : ""}`}>
            <input type="radio" name="granularity" checked={scopeKind === kind} onChange={() => setScopeKind(kind)} />
            {label}
            <span className="bench-mode-hint">{hint}</span>
          </label>
        ))}
      </div>

      {scopeKind !== "set" && (
        <div className="settings-row">
          <select
            className="declare-search"
            aria-label="Target spec"
            value={specId}
            onChange={(e) => setSpecId(e.target.value)}
          >
            {story.specs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} — {s.repo}
              </option>
            ))}
          </select>
          {scopeKind === "section" && (
            <select
              className="declare-search"
              aria-label="Target section"
              value={section}
              onChange={(e) => setSection(e.target.value)}
            >
              {SECTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <textarea
        className="bench-input"
        aria-label="Spec feedback"
        rows={4}
        placeholder="What should change? The agent revises all affected parts to stay consistent…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="settings-row">
        <button
          type="button"
          className="call-btn clay"
          disabled={busy || !content.trim()}
          onClick={() => {
            onRevise(scope(), content);
            setContent("");
          }}
        >
          Request revision
        </button>
      </div>

      <div className="bench-amend">
        <span className="panel-eyebrow">Per spec</span>
        {story.specs.map((spec) => {
          const prev = previous.get(spec.id);
          const hasDiff = prev !== undefined && prev !== spec.markdown;
          if (editing === spec.id) {
            return (
              <div key={spec.id} className="bench-amend-editor">
                <textarea
                  className="bench-input"
                  aria-label={`Edit ${spec.id}`}
                  rows={10}
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                />
                <div className="settings-row">
                  <button
                    type="button"
                    className="call-btn turf"
                    disabled={busy || !editDraft.trim()}
                    onClick={() => {
                      onDirectEdit(spec.id, editDraft);
                      setEditing(null);
                    }}
                  >
                    Save edit (verbatim)
                  </button>
                  <button type="button" className="call-btn" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div key={spec.id} className="draft-review-spec">
              <code className="spec-id">{spec.id}</code>
              <button
                type="button"
                className="bench-amend-open"
                onClick={() => {
                  setEditing(spec.id);
                  setEditDraft(spec.markdown);
                }}
              >
                edit directly
              </button>
              {hasDiff && (
                <button
                  type="button"
                  className="bench-amend-open"
                  onClick={() => setDiffing(diffing === spec.id ? null : spec.id)}
                >
                  {diffing === spec.id ? "hide diff" : "show diff"}
                </button>
              )}
              {diffing === spec.id && hasDiff && (
                <pre className="spec-diff" aria-label={`Diff for ${spec.id}`}>
                  {lineDiff(prev, spec.markdown).map((line, i) => (
                    <div key={i} className={`diff-line ${line.kind}`}>
                      <span className="diff-gutter">
                        {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                      </span>
                      {line.text}
                    </div>
                  ))}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {thread.length > 0 && (
        <div className="review-thread">
          <span className="panel-eyebrow">Thread</span>
          <ol className="thread-list">
            {thread.map((entry) => (
              <li key={entry.round} className="thread-entry">
                <span className="thread-scope">
                  {entry.kind === "direct-edit" ? "✎ " : ""}
                  {entry.scope.kind === "set"
                    ? "fan-out"
                    : entry.scope.kind === "spec"
                      ? entry.scope.specId
                      : `${entry.scope.specId} · ${entry.scope.section}`}
                </span>
                {entry.content}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
