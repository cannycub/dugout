import { useMemo, useState } from "react";
import type { Story } from "../../core/domain.js";

/**
 * The review bench (#9): shown while a story is paused at a review-required stop. The developer's
 * feedback paths, in priority order — behavioural feedback as a failing test the agent makes
 * green, quality/structural feedback iterated in place (suite stays green), and the
 * "spec was wrong" escape hatch that amends the contract and re-runs clean (flagging the
 * downstream cascade). Direct edits need no UI: the story branch is theirs to commit to.
 */
export interface ReviewBenchProps {
  story: Story;
  busy: boolean;
  onSubmitFeedback: (kind: "test" | "quality", content: string) => void;
  onAmendSpec: (specId: string, markdown: string) => void;
}

export function ReviewBench({ story, busy, onSubmitFeedback, onAmendSpec }: ReviewBenchProps) {
  const [kind, setKind] = useState<"test" | "quality">("test");
  const [content, setContent] = useState("");
  const [amending, setAmending] = useState<string | null>(null);
  const [amendDraft, setAmendDraft] = useState("");

  // The spec under review: the most recently merged one (the stop's owner).
  const reviewed = useMemo(() => [...story.specs].reverse().find((s) => s.status === "merged"), [story]);
  // Cascade preview for an amend: merged specs downstream of the target re-run.
  const cascadeCount = (specId: string) => {
    const index = story.specs.findIndex((s) => s.id === specId);
    return story.specs.slice(index + 1).filter((s) => s.status === "merged").length;
  };

  const mergedSpecs = story.specs.filter((s) => s.status === "merged");

  return (
    <div className="field review-bench">
      <div className="field-head">
        <span className="panel-eyebrow">Code review</span>
        {reviewed && <span className="spec-id">{reviewed.id}</span>}
      </div>
      <p className="muted small">
        The spec merged green and execution is paused for your review. Give feedback below, commit
        directly to the story branch, or resume when satisfied.
      </p>

      <div className="bench-modes" role="radiogroup" aria-label="Feedback mode">
        <label className={`bench-mode ${kind === "test" ? "active" : ""}`}>
          <input type="radio" name="fb-kind" checked={kind === "test"} onChange={() => setKind("test")} />
          failing test
          <span className="bench-mode-hint">behavioural — durable, regression-proof</span>
        </label>
        <label className={`bench-mode ${kind === "quality" ? "active" : ""}`}>
          <input
            type="radio"
            name="fb-kind"
            checked={kind === "quality"}
            onChange={() => setKind("quality")}
          />
          quality note
          <span className="bench-mode-hint">structural — iterated in place, suite stays green</span>
        </label>
      </div>

      <textarea
        className="bench-input"
        aria-label={kind === "test" ? "Failing test code" : "Quality feedback"}
        placeholder={
          kind === "test"
            ? "Paste the failing test the agent must make green…"
            : "Describe the structural change (behaviour unchanged)…"
        }
        rows={5}
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="settings-row">
        <button
          type="button"
          className="call-btn clay"
          disabled={busy || !content.trim()}
          onClick={() => {
            onSubmitFeedback(kind, content);
            setContent("");
          }}
        >
          {kind === "test" ? "Make this test green" : "Iterate in place"}
        </button>
      </div>

      {mergedSpecs.length > 0 && (
        <div className="bench-amend">
          <span className="panel-eyebrow">Spec was wrong?</span>
          {mergedSpecs.map((spec) =>
            amending === spec.id ? (
              <div key={spec.id} className="bench-amend-editor">
                <textarea
                  className="bench-input"
                  aria-label={`Amend ${spec.id}`}
                  rows={8}
                  value={amendDraft}
                  onChange={(e) => setAmendDraft(e.target.value)}
                />
                {cascadeCount(spec.id) > 0 && (
                  <p className="bench-cascade">
                    ⚠ Cascade: {cascadeCount(spec.id)} downstream merged spec
                    {cascadeCount(spec.id) === 1 ? "" : "s"} will re-run from the corrected branch.
                  </p>
                )}
                <div className="settings-row">
                  <button
                    type="button"
                    className="call-btn clay"
                    disabled={busy || !amendDraft.trim()}
                    onClick={() => {
                      onAmendSpec(spec.id, amendDraft);
                      setAmending(null);
                    }}
                  >
                    Amend & re-run clean
                  </button>
                  <button type="button" className="call-btn" onClick={() => setAmending(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                key={spec.id}
                type="button"
                className="bench-amend-open"
                onClick={() => {
                  setAmending(spec.id);
                  setAmendDraft(spec.markdown);
                }}
              >
                amend <code>{spec.id}</code>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
