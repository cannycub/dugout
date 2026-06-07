import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // Structurally exclude the agent integration suite (Tier 3) from the default run / CI — it hits
    // the REAL agent (slow, billable, non-deterministic, needs secrets). It is NOT runtime-gated by a
    // flag: a flag silently skips and reports green, which gives false confidence the agent was
    // tested. Run it explicitly via `npm run test:agent`. See CLAUDE.md (testing pyramid).
    exclude: [...configDefaults.exclude, "**/*.agent.test.ts"],
    environment: "node",
    setupFiles: ["src/test-setup.ts"],
  },
});
