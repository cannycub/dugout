import { readFile, writeFile } from "node:fs/promises";
import type { SafeStorageLike, JiraCredentialStore } from "./jira-credentials.js";

/**
 * Extensible secrets store (#17): ONE safeStorage-encrypted blob (`secrets.enc`) holding a JSON
 * map keyed by credential name ("jira", "github", …). Adding a credential is a new key, not a new
 * store class. The ciphertext is the file; the encryption key lives in the OS keychain (macOS
 * Keychain / Windows DPAPI / Linux libsecret), tied to the OS user — so a corrupt or
 * foreign-machine blob legitimately fails to decrypt and degrades to "not set" (re-prompt),
 * never a crash. When encryption is unavailable (e.g. headless Linux without a keyring) secrets
 * are NOT persisted in plaintext — set() refuses. See ADR-0017.
 */
export class SecretsStore {
  constructor(
    private readonly file: string,
    private readonly safe: SafeStorageLike,
  ) {}

  async get(name: string): Promise<string | null> {
    const map = await this.read();
    return map[name] ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error("OS encryption unavailable; refusing to store secrets in plaintext");
    }
    const map = await this.read();
    map[name] = value;
    await this.write(map);
  }

  async delete(name: string): Promise<void> {
    const map = await this.read();
    if (!(name in map)) return;
    delete map[name];
    await this.write(map);
  }

  /**
   * One-time fold-in of the legacy single-purpose Jira store: only when the keyed blob has no
   * "jira" entry yet, so a newer value is never clobbered by re-running the migration.
   */
  async migrateLegacyJira(legacy: Pick<JiraCredentialStore, "load">): Promise<void> {
    if ((await this.get("jira")) !== null) return;
    const creds = await legacy.load();
    if (creds) await this.set("jira", JSON.stringify(creds));
  }

  /** Read = decrypt + parse the whole blob; any failure degrades to empty (re-prompt). */
  private async read(): Promise<Record<string, string>> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.file);
    } catch {
      return {};
    }
    try {
      return JSON.parse(this.safe.decryptString(encrypted)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** Write = merge done by the caller; re-encrypt + rewrite the whole blob. */
  private async write(map: Record<string, string>): Promise<void> {
    await writeFile(this.file, this.safe.encryptString(JSON.stringify(map)));
  }
}
