import type { Ticket } from "../core/ports/jira.js";
import type { DraftOutcome } from "../core/ports/executor.js";
import type { RepoIdentity } from "../core/ports/catalog.js";

/** The single hardcoded ticket the walking skeleton flows end-to-end (#2). */
export const SEED_TICKET: Ticket = {
  key: "DUG-101",
  title: "Stream widget events into the replay pipeline",
  description:
    "AC: widget mutations emit domain events; the pipeline ingests and reprocesses them; a " +
    "query endpoint returns the aggregated widget timeline. Must survive a replay run.",
};

/** Seed catalog the walking skeleton declares from until the real GitHub-org list lands (#3). */
export const SEED_CATALOG: RepoIdentity[] = [
  { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
  { name: "pipeline", remote: "git@github.com:acme/pipeline.git" },
  { name: "ledger", remote: "git@github.com:acme/ledger.git" },
];

/**
 * Canned fan-out the fake executor returns for the seed ticket: three single-repo specs across
 * two repos. The agent does not flag replay specs (ADR-0008); the walking skeleton demonstrates a
 * review-required stop by the developer marking a spec review-required at pre-flight.
 */
export const SEED_DRAFT: DraftOutcome = {
  result: "drafted",
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
      markdown: [
        "# Spec: ingest & reprocess widget events (pipeline)",
        "",
        "## Acceptance criteria",
        "- The pipeline consumes `WidgetChanged` and materializes the widget timeline.",
        "",
        "## Test plan (test-first)",
        "1. RED: timeline projection from a fixture stream.",
        "2. GREEN: implement the projector.",
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
