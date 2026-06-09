/**
 * Real Datadog metrics adapter (#13): POSTs each MetricEvent as a count series to the Datadog v2
 * metrics intake. Direct HTTP — no datadog CLI/agent dependency (the app must work for end users
 * with nothing locally installed).
 *
 * Best-effort and non-blocking by construction (CONTEXT.md invariant 7): `emit` is sync
 * fire-and-forget; the POST happens in the background and any failure degrades to a console
 * warning. Improvement-only (invariant 9): tags carry spec/stage/repo/ticket-quality dimensions
 * passed by the orchestrator — never a developer identity, which this adapter has no access to.
 */

import type { MetricsPort, MetricEvent } from "../ports/metrics.js";

export interface DatadogConfig {
  /** DD API key (from the secrets store / env — wired by the host). */
  apiKey: string;
  /** Datadog site, e.g. "datadoghq.com" (default) or "datadoghq.eu". */
  site?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Epoch-seconds source; injected for tests. */
  now?: () => number;
}

export class DatadogMetrics implements MetricsPort {
  constructor(private readonly config: DatadogConfig) {}

  emit(event: MetricEvent): void {
    const { apiKey, site = "datadoghq.com", fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000) } =
      this.config;
    const body = {
      series: [
        {
          metric: `dugout.${event.name}`,
          type: 1, // count
          points: [{ timestamp: now(), value: 1 }],
          tags: Object.entries(event.tags ?? {}).map(([k, v]) => `${k}:${v}`),
        },
      ],
    };
    // Fire-and-forget: never await, never throw into the build (invariant 7).
    void fetchImpl(`https://api.${site}/api/v2/series`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "DD-API-KEY": apiKey },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (!res.ok) console.warn(`[dugout] Datadog intake rejected ${event.name}: HTTP ${res.status}`);
      })
      .catch((err) => {
        console.warn(`[dugout] Datadog emit failed (non-blocking): ${String(err)}`);
      });
  }
}
