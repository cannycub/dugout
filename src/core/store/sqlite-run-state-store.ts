import Database from "better-sqlite3";
import type { StoryRunState, SpecRunState, SpecStatus, StoryStatus } from "../domain.js";
import type { RunStateStore } from "./run-state-store.js";

interface StoryRow {
  key: string;
  title: string;
  status: string;
}

interface SpecStatusRow {
  spec_id: string;
  story_key: string;
  status: string;
}

/**
 * SQLite-backed ephemeral run-state: just the lifecycle position (story + per-spec status).
 * Spec contract (markdown + plan) lives in the SpecStore (git), so it is deliberately absent here.
 */
export class SqliteRunStateStore implements RunStateStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stories (
        key    TEXT PRIMARY KEY,
        title  TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spec_status (
        spec_id   TEXT PRIMARY KEY,
        story_key TEXT NOT NULL REFERENCES stories(key) ON DELETE CASCADE,
        status    TEXT NOT NULL,
        ord       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spec_status_story_key ON spec_status(story_key);
    `);
  }

  save(state: StoryRunState): void {
    const upsertStory = this.db.prepare(
      `INSERT INTO stories (key, title, status) VALUES (@key, @title, @status)
       ON CONFLICT(key) DO UPDATE SET title = excluded.title, status = excluded.status`,
    );
    const deleteSpecs = this.db.prepare(`DELETE FROM spec_status WHERE story_key = ?`);
    const insertSpec = this.db.prepare(
      `INSERT INTO spec_status (spec_id, story_key, status, ord)
       VALUES (@spec_id, @story_key, @status, @ord)`,
    );

    const tx = this.db.transaction((s: StoryRunState) => {
      upsertStory.run({ key: s.key, title: s.title, status: s.status });
      deleteSpecs.run(s.key);
      s.specs.forEach((spec, ord) => {
        insertSpec.run({ spec_id: spec.specId, story_key: s.key, status: spec.status, ord });
      });
    });
    tx(state);
  }

  get(storyKey: string): StoryRunState | undefined {
    const row = this.db.prepare(`SELECT * FROM stories WHERE key = ?`).get(storyKey) as
      | StoryRow
      | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  all(): StoryRunState[] {
    const rows = this.db.prepare(`SELECT * FROM stories ORDER BY key`).all() as StoryRow[];
    return rows.map((row) => this.hydrate(row));
  }

  close(): void {
    this.db.close();
  }

  private hydrate(row: StoryRow): StoryRunState {
    const specRows = this.db
      .prepare(`SELECT * FROM spec_status WHERE story_key = ? ORDER BY ord`)
      .all(row.key) as SpecStatusRow[];
    const specs: SpecRunState[] = specRows.map((s) => ({
      specId: s.spec_id,
      status: s.status as SpecStatus,
    }));
    return {
      key: row.key,
      title: row.title,
      status: row.status as StoryStatus,
      specs,
    };
  }
}
