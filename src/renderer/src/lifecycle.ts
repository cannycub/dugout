import type { SpecStatus, StoryStatus } from "../../core/domain.js";

/** Per-spec status → label + the CSS color token used for its chip. */
export const SPEC_META: Record<SpecStatus, { label: string; token: string }> = {
  drafted: { label: "Drafted", token: "var(--chalk-dim)" },
  approved: { label: "Approved", token: "var(--amber)" },
  running: { label: "On the field", token: "var(--amber)" },
  green: { label: "Green · held for review", token: "var(--clay)" },
  merged: { label: "Merged", token: "var(--turf)" },
  failed: { label: "Failed", token: "var(--danger)" },
};

/** The lifecycle "base path" shown in the ribbon, in order. */
export const RIBBON_STAGES: { status: StoryStatus; label: string }[] = [
  { status: "drafted", label: "Drafted" },
  { status: "approved", label: "Approved" },
  { status: "executing", label: "Executing" },
  { status: "awaiting-review", label: "Review" },
  { status: "dev-complete", label: "Dev-complete" },
  { status: "pr-created", label: "PR'd" },
];

const ORDER: StoryStatus[] = [
  "drafted",
  "approved",
  "executing",
  "awaiting-review",
  "dev-complete",
  "pr-created",
];

/** How far along the base path a status sits (failed maps to the executing leg). */
export function stageIndex(status: StoryStatus): number {
  if (status === "failed") return ORDER.indexOf("executing");
  return ORDER.indexOf(status);
}
