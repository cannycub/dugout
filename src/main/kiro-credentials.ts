import { readFile, writeFile } from "node:fs/promises";
import type { SafeStorageLike } from "./jira-credentials.js";

/**
 * Read the kiro API key from the environment — a dev/testing stopgap until onboarding (#18) saves it
 * to secure storage. Mirrors `jiraCredentialsFromEnv`: env is the only knob until then, because
 * nothing yet calls {@link KiroCredentialStore.save}. Returns null when unset/empty so the app
 * degrades rather than building a keyless adapter that would fail at execute time.
 */
export function kiroApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env["KIRO_API_KEY"] || null;
}

/**
 * Stores the developer's kiro API key encrypted at rest via Electron safeStorage, mirroring
 * {@link JiraCredentialStore}. The key is the developer's own identity (from onboarding #18); it is
 * never persisted as run-state or in git. Sourcing it here — rather than reading `process.env` lazily
 * inside the adapters — is what lets a GUI-launched app (which does not inherit a shell's exports)
 * reach kiro for both draft and execute.
 */
export class KiroCredentialStore {
  constructor(
    private readonly file: string,
    private readonly safe: SafeStorageLike,
  ) {}

  async load(): Promise<string | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.file);
    } catch {
      return null;
    }
    // Decrypt can fail on a corrupt file or one encrypted under a different OS keychain; the key is
    // best-effort and must never block startup, so degrade to null (the env stopgap may still apply).
    try {
      return this.safe.decryptString(encrypted);
    } catch {
      return null;
    }
  }

  async save(apiKey: string): Promise<void> {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error("OS encryption unavailable; cannot store the kiro API key securely");
    }
    await writeFile(this.file, this.safe.encryptString(apiKey));
  }
}
