import { readFile, writeFile } from "node:fs/promises";

/** The subset of Electron's safeStorage we use (injectable for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  token: string;
}

/**
 * Read Jira credentials from environment variables — a dev/testing stopgap until the settings UI
 * (#17) lands. Mirrors `DUGOUT_WORKSPACE_ROOTS`: env is the only knob until then, because nothing
 * yet calls {@link JiraCredentialStore.save}, so without this the app can never reach live Jira.
 * Returns null unless all three are set, so a partial config degrades to the seed fake rather than
 * building an adapter that would 401 (ADR-0005: Jira auth never blocks startup).
 */
export function jiraCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JiraCredentials | null {
  const baseUrl = env["DUGOUT_JIRA_BASE_URL"];
  const email = env["DUGOUT_JIRA_EMAIL"];
  const token = env["DUGOUT_JIRA_TOKEN"];
  if (!baseUrl || !email || !token) return null;
  return { baseUrl, email, token };
}

/**
 * Stores the developer's Jira API token encrypted at rest via Electron safeStorage (ADR-0005).
 * The token is the developer's own identity; it is never persisted as run-state or in git.
 */
export class JiraCredentialStore {
  constructor(
    private readonly file: string,
    private readonly safe: SafeStorageLike,
  ) {}

  async load(): Promise<JiraCredentials | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.file);
    } catch {
      return null;
    }
    // Decrypt/parse can fail on a corrupt file or one encrypted under a different OS keychain.
    // Jira auth is best-effort and must never block startup (ADR-0005), so degrade to null.
    try {
      return JSON.parse(this.safe.decryptString(encrypted)) as JiraCredentials;
    } catch {
      return null;
    }
  }

  async save(creds: JiraCredentials): Promise<void> {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error("OS encryption unavailable; cannot store Jira token securely");
    }
    const encrypted = this.safe.encryptString(JSON.stringify(creds));
    await writeFile(this.file, encrypted);
  }
}
