import type { Ticket } from "../core/ports/jira.js";
import type { DraftResult } from "../core/ports/executor.js";

/** The single hardcoded ticket the walking skeleton flows end-to-end (#2). */
export const SEED_TICKET: Ticket = {
  key: "DUG-101",
  title: "Stream widget events into the replay pipeline",
  description:
    "AC: widget mutations emit domain events; the pipeline ingests and reprocesses them; a " +
    "query endpoint returns the aggregated widget timeline. Must survive a replay run.",
};

/**
 * Canned fan-out the fake executor returns for the seed ticket: three single-repo specs across
 * two repos, with the pipeline spec flagged as the replay spec (→ default review-required), so
 * the lifecycle demonstrates a review-required stop and two fully-linked PRs.
 */
export const SEED_DRAFT: DraftResult = {
  specs: [
    {
      repo: "widget-api",
      markdown: [
        "# Spec: emit widget mutation events (widget-api)",
        "",
        "## Acceptance criteria",
        "- Every create/update/delete on a widget emits a `WidgetChanged` domain event.",
        "",
        "## Test plan (test-first)",
        "1. RED: asserting a `WidgetChanged` is published on update.",
        "2. GREEN: publish from the command handler.",
      ].join("\n"),
    },
    {
      repo: "pipeline",
      isReplaySpec: true,
      markdown: [
        "# Spec: ingest & reprocess widget events (pipeline) — REPLAY SPEC",
        "",
        "## Acceptance criteria",
        "- The pipeline consumes `WidgetChanged` and materializes the widget timeline.",
        "- Verified by a replay run (human-verified via Athena).",
        "",
        "## Test plan (test-first)",
        "1. RED: timeline projection from a fixture stream.",
        "2. GREEN: implement the projector. Replay verification happens at the review stop.",
      ].join("\n"),
    },
    {
      repo: "widget-api",
      markdown: [
        "# Spec: expose widget timeline query endpoint (widget-api)",
        "",
        "## Acceptance criteria",
        "- `GET /widgets/:id/timeline` returns the aggregated timeline.",
        "",
        "## Test plan (test-first)",
        "1. RED: endpoint returns 200 with the timeline shape.",
        "2. GREEN: wire the read model.",
      ].join("\n"),
    },
  ],
};
