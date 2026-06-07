import { defineConfig } from "vitest/config";

/**
 * Tier 3 — agent integration suite (CLAUDE.md testing pyramid). Runs the `*.agent.test.ts` files
 * against the REAL agent (e.g. real kiro), because ordinary APIs fake cleanly but agent (LLM)
 * responses do not — only a real run proves the agent behaves correctly. Deliberately separate from
 * the default config so these are NEVER part of `npm test` / CI: they are slow, billable,
 * non-deterministic, and need secrets (`KIRO_API_KEY`, optional `KIRO_BIN`). The agent is stateless,
 * so the cases are parallel-safe. Run with: `npm run test:agent`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.agent.test.ts"],
    environment: "node",
    setupFiles: ["src/test-setup.ts"],
    // A real agent run is slow; give the whole suite a generous ceiling on top of per-test timeouts.
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
