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
    const json = this.safe.decryptString(encrypted);
    return JSON.parse(json) as JiraCredentials;
  }

  async save(creds: JiraCredentials): Promise<void> {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error("OS encryption unavailable; cannot store Jira token securely");
    }
    const encrypted = this.safe.encryptString(JSON.stringify(creds));
    await writeFile(this.file, encrypted);
  }
}
