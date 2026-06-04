import type { MetricEvent, MetricsPort } from "../ports/metrics.js";

/** In-memory metrics sink; captures emitted events without hitting Datadog. */
export class FakeMetrics implements MetricsPort {
  readonly events: MetricEvent[] = [];

  emit(event: MetricEvent): void {
    this.events.push(event);
  }
}
