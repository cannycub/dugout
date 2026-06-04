import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness, draftAndApprove } from "./test-harness.js";
import { SqliteRunStateStore } from "./store/sqlite-run-state-store.js";

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dugout-"));
  tempDirs.push(dir);
  return join(dir, "run-state.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("orchestrator on SQLite run-state", () => {
  it("drives the full lifecycle and persists run-state recoverable after a restart", async () => {
    const dbPath = tempDbPath();
    const store = new SqliteRunStateStore(dbPath);

    const { orchestrator } = makeHarness({
      draft: [{ repo: "web", markdown: "# Spec A" }],
      store,
    });
    await draftAndApprove(orchestrator, ["web"]);
    await orchestrator.runStory("DUG-1");
    await orchestrator.createPullRequests("DUG-1");

    expect(orchestrator.getStory("DUG-1")?.status).toBe("pr-created");
    store.close();

    // Simulate restarting the app: a fresh store on the same db recovers the run-state.
    // (Spec *content* would be recovered from git; here only run-state is persisted to SQLite.)
    const recovered = new SqliteRunStateStore(dbPath);
    const runState = recovered.get("DUG-1");
    expect(runState?.status).toBe("pr-created");
    expect(runState?.specs[0]?.status).toBe("merged");
    recovered.close();
  });
});
