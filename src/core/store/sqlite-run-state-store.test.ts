import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunStateStore } from "./sqlite-run-state-store.js";
import type { StoryRunState } from "../domain.js";

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

function sampleRunState(): StoryRunState {
  return {
    key: "DUG-1",
    title: "Add widget",
    status: "executing",
    specs: [
      { specId: "DUG-1-spec-1", status: "merged" },
      { specId: "DUG-1-spec-2", status: "running" },
    ],
  };
}

describe("SqliteRunStateStore", () => {
  it("round-trips a story's run-state with per-spec status in order", () => {
    const store = new SqliteRunStateStore(tempDbPath());
    const state = sampleRunState();

    store.save(state);

    expect(store.get("DUG-1")).toEqual(state);
    store.close();
  });

  it("persists run-state across store instances on the same db file", () => {
    const path = tempDbPath();
    const first = new SqliteRunStateStore(path);
    first.save(sampleRunState());
    first.close();

    const second = new SqliteRunStateStore(path);
    expect(second.get("DUG-1")?.status).toBe("executing");
    expect(second.get("DUG-1")?.specs.map((s) => s.status)).toEqual(["merged", "running"]);
    second.close();
  });

  it("upserts on save, keeping a single story per key with updated statuses", () => {
    const store = new SqliteRunStateStore(tempDbPath());
    const state = sampleRunState();
    store.save(state);

    state.status = "dev-complete";
    state.specs[1]!.status = "merged";
    store.save(state);

    expect(store.all()).toHaveLength(1);
    expect(store.get("DUG-1")?.status).toBe("dev-complete");
    expect(store.get("DUG-1")?.specs.map((s) => s.status)).toEqual(["merged", "merged"]);
    store.close();
  });
});
