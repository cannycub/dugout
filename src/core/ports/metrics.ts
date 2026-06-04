/**
 * Metrics port — emits agent-correction and adoption events to Datadog. Best-effort and
 * non-blocking (CONTEXT.md invariant 7); for improvement only, never per-developer ranking
 * (invariant 9). Emitted from day one (history can't be backfilled).
 */

export interface MetricEvent {
  /** Event name, e.g. "spec.merged", "story.pr_created". */
  name: string;
  /** Aggregation dimensions (spec/stage/repo/ticket-quality) — never a developer identity. */
  tags?: Record<string, string | number>;
}

export interface MetricsPort {
  /** Fire-and-forget; must never throw into the build. */
  emit(event: MetricEvent): void;
}
