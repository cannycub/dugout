import { readFile, writeFile } from "node:fs/promises";

/**
 * Non-secret user settings (#17): a plain `settings.json` in the app's userData dir. Durable,
 * machine-local config — not run-state (no SQLite), not spec content (no git). Secrets never go
 * here (see SecretsStore). See ADR-0017.
 */
export interface DugoutSettings {
  /** Directories scanned (one level deep) for git clones — replaces DUGOUT_WORKSPACE_ROOTS. */
  workspaceRoots: string[];
  /** GitHub org for the live catalog/PR adapter (non-secret) — replaces DUGOUT_GITHUB_ORG. */
  githubOrg: string;
}

const DEFAULTS: DugoutSettings = { workspaceRoots: [], githubOrg: "" };

export class SettingsStore {
  constructor(private readonly file: string) {}

  /** Missing or corrupt file degrades to defaults — settings must never crash startup. */
  async load(): Promise<DugoutSettings> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<DugoutSettings>;
      return {
        workspaceRoots: Array.isArray(raw.workspaceRoots) ? raw.workspaceRoots : [],
        githubOrg: typeof raw.githubOrg === "string" ? raw.githubOrg : "",
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  async save(settings: DugoutSettings): Promise<void> {
    await writeFile(this.file, JSON.stringify(settings, null, 2));
  }
}
