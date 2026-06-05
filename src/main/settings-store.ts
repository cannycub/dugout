import { readFileSync, writeFileSync } from "node:fs";
import type { ExecutorMode } from "../core/switchable-executor.js";

/** Non-secret, developer-chosen app settings. Persisted as JSON in userData. */
export interface DugoutSettings {
  /** Whether drafting uses the in-memory fakes or the real (kiro) live path. */
  executorMode: ExecutorMode;
}

const DEFAULTS: DugoutSettings = { executorMode: "fakes" };

/**
 * A tiny JSON-file settings store (non-secret config; secrets stay in safeStorage — ADR-0005,
 * issue #17). Reads degrade to defaults on a missing/corrupt file so startup never wedges
 * (invariant 7). Sync I/O: the file is tiny and touched only at startup / on a mode change.
 */
export class SettingsStore {
  constructor(private readonly path: string) {}

  load(): DugoutSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<DugoutSettings>;
      return { executorMode: parsed.executorMode === "live" ? "live" : "fakes" };
    } catch {
      return { ...DEFAULTS };
    }
  }

  save(settings: DugoutSettings): void {
    writeFileSync(this.path, JSON.stringify(settings, null, 2));
  }
}
