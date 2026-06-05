import { DatabaseSync } from "node:sqlite";
import type { StoryRunState, SpecRunState, SpecStatus, StoryStatus } from "../domain.js";
import type { RunStateStore } from "./run-state-store.js";

/** A raw row from node:sqlite: column name → value (the untyped DB boundary). */
type Row = Record<string, unknown>;

/** Read a TEXT column as a string at the DB boundary. */
function text(row: Row, column: string): string {
  return String(row[column]);
}

/**
 * SQLite-backed ephemeral run-state: just the lifecycle position (story + per-spec status).
 * Spec contract (markdown + plan) lives in the SpecStore (git), so it is deliberately absent here.
 *
 * Uses Node's built-in `node:sqlite` (no native module), so the identical code runs under both
 * the Node test runner and Electron — no ABI rebuild. It sits behind {@link RunStateStore}, so
 * swapping the engine never touches orchestration.
 */
export class SqliteRunStateStore implements RunStateStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stories (
        key            TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        status         TEXT NOT NULL,
        declared_repos TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS spec_status (
        spec_id   TEXT PRIMARY KEY,
        story_key TEXT NOT NULL REFERENCES stories(key) ON DELETE CASCADE,
        status    TEXT NOT NULL,
        ord       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spec_status_story_key ON spec_status(story_key);
    `);
    // Migrate a pre-existing DB that lacks the declared_repos column (run-state is rebuildable,
    // so an empty default is safe).
    const columns = this.db.prepare(`PRAGMA table_info(stories)`).all();
    if (!columns.some((c) => String((c as Row)["name"]) === "declared_repos")) {
      this.db.exec(`ALTER TABLE stories ADD COLUMN declared_repos TEXT NOT NULL DEFAULT '[]'`);
    }
  }

  save(state: StoryRunState): void {
    const upsertStory = this.db.prepare(
      `INSERT INTO stories (key, title, status, declared_repos)
       VALUES (@key, @title, @status, @declared_repos)
       ON CONFLICT(key) DO UPDATE SET
         title = excluded.title, status = excluded.status, declared_repos = excluded.declared_repos`,
    );
    const deleteSpecs = this.db.prepare(`DELETE FROM spec_status WHERE story_key = @key`);
    const insertSpec = this.db.prepare(
      `INSERT INTO spec_status (spec_id, story_key, status, ord)
       VALUES (@spec_id, @story_key, @status, @ord)`,
    );

    this.transaction(() => {
      upsertStory.run({
        key: state.key,
        title: state.title,
        status: state.status,
        declared_repos: JSON.stringify(state.declaredRepos),
      });
      deleteSpecs.run({ key: state.key });
      state.specs.forEach((spec, ord) => {
        insertSpec.run({
          spec_id: spec.specId,
          story_key: state.key,
          status: spec.status,
          ord,
        });
      });
    });
  }

  get(storyKey: string): StoryRunState | undefined {
    const row = this.db.prepare(`SELECT * FROM stories WHERE key = @key`).get({ key: storyKey });
    return row ? this.hydrate(row) : undefined;
  }

  all(): StoryRunState[] {
    const rows = this.db.prepare(`SELECT * FROM stories ORDER BY key`).all();
    return rows.map((row) => this.hydrate(row));
  }

  close(): void {
    this.db.close();
  }

  /** node:sqlite has no transaction() helper, so wrap BEGIN/COMMIT with rollback on throw. */
  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private hydrate(row: Row): StoryRunState {
    const key = text(row, "key");
    const specRows = this.db
      .prepare(`SELECT * FROM spec_status WHERE story_key = @key ORDER BY ord`)
      .all({ key });
    const specs: SpecRunState[] = specRows.map((s) => ({
      specId: text(s, "spec_id"),
      status: text(s, "status") as SpecStatus,
    }));
    return {
      key,
      title: text(row, "title"),
      status: text(row, "status") as StoryStatus,
      specs,
      declaredRepos: JSON.parse(text(row, "declared_repos")) as string[],
    };
  }
}
