import { describe, it, expect } from "vitest";
import { DatadogMetrics } from "./datadog-metrics.js";

function fakeFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 202 } as Response;
  }) as typeof fetch;
  return { calls, impl };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("DatadogMetrics (real metrics sink, #13)", () => {
  it("POSTs a count series to the Datadog v2 intake with the event name and tags", async () => {
    const { calls, impl } = fakeFetch();
    const sink = new DatadogMetrics({ apiKey: "dd-key", fetchImpl: impl, now: () => 1750000000 });

    sink.emit({ name: "spec.merged", tags: { story: "DUG-1", repo: "web" } });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.datadoghq.com/api/v2/series");
    expect((calls[0]!.init.headers as Record<string, string>)["DD-API-KEY"]).toBe("dd-key");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      series: [
        {
          metric: "dugout.spec.merged",
          type: 1,
          points: [{ timestamp: 1750000000, value: 1 }],
          tags: ["story:DUG-1", "repo:web"],
        },
      ],
    });
  });

  it("honours a non-default site", async () => {
    const { calls, impl } = fakeFetch();
    new DatadogMetrics({ apiKey: "k", site: "datadoghq.eu", fetchImpl: impl }).emit({ name: "x" });
    await flush();
    expect(calls[0]!.url).toBe("https://api.datadoghq.eu/api/v2/series");
  });

  it("is best-effort: a rejecting fetch never throws into the caller (invariant 7)", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const sink = new DatadogMetrics({ apiKey: "k", fetchImpl: impl });

    expect(() => sink.emit({ name: "spec.merged" })).not.toThrow();
    await flush(); // the internal rejection is swallowed (warned), not unhandled
  });
});
