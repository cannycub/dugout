import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "./settings-store.js";
import { SecretsStore } from "./secrets-store.js";
import { JiraCredentialStore, type SafeStorageLike } from "./jira-credentials.js";

const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ""),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dugout-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SettingsStore (non-secret config → settings.json, #17)", () => {
  it("round-trips workspace roots and persists them on disk as plain JSON", async () => {
    const store = new SettingsStore(join(dir, "settings.json"));
    expect((await store.load()).workspaceRoots).toEqual([]);

    await store.save({ workspaceRoots: ["/ws/a", "/ws/b"] });

    expect((await store.load()).workspaceRoots).toEqual(["/ws/a", "/ws/b"]);
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))).toEqual({
      workspaceRoots: ["/ws/a", "/ws/b"],
    });
  });

  it("degrades a corrupt file to defaults (never crashes startup)", async () => {
    await writeFile(join(dir, "settings.json"), "{not json");
    const store = new SettingsStore(join(dir, "settings.json"));
    expect((await store.load()).workspaceRoots).toEqual([]);
  });
});

describe("SecretsStore (name-keyed safeStorage blob → secrets.enc, #17)", () => {
  it("round-trips named secrets through one encrypted blob; adding a key is not a new store", async () => {
    const store = new SecretsStore(join(dir, "secrets.enc"), fakeSafe);
    expect(await store.get("jira")).toBeNull();

    await store.set("jira", JSON.stringify({ baseUrl: "https://a", email: "d@a", token: "t" }));
    await store.set("github", "ghp_xyz");

    expect(JSON.parse((await store.get("jira"))!)).toMatchObject({ token: "t" });
    expect(await store.get("github")).toBe("ghp_xyz");
    // The blob on disk went through safeStorage (our fake prefixes ciphertext with "enc:").
    expect((await readFile(join(dir, "secrets.enc"))).toString().startsWith("enc:")).toBe(true);
  });

  it("deletes a key, leaving the others intact", async () => {
    const store = new SecretsStore(join(dir, "secrets.enc"), fakeSafe);
    await store.set("jira", "j");
    await store.set("github", "g");
    await store.delete("jira");
    expect(await store.get("jira")).toBeNull();
    expect(await store.get("github")).toBe("g");
  });

  it("degrades a corrupt/foreign-machine blob to empty (re-prompt), never crashes", async () => {
    await writeFile(join(dir, "secrets.enc"), Buffer.from("garbage-not-decryptable"));
    // Decryption fails on the foreign garbage but works for blobs this store writes afterwards.
    const undecryptable: SafeStorageLike = {
      ...fakeSafe,
      decryptString: (b) => {
        const s = b.toString();
        if (!s.startsWith("enc:")) throw new Error("foreign keychain");
        return s.replace(/^enc:/, "");
      },
    };
    const store = new SecretsStore(join(dir, "secrets.enc"), undecryptable);
    expect(await store.get("jira")).toBeNull();
    // And a fresh set() starts a new blob rather than crashing on the old one.
    await store.set("jira", "fresh");
    expect(await store.get("jira")).toBe("fresh");
  });

  it("refuses to persist secrets when OS encryption is unavailable (no plaintext fallback)", async () => {
    const noEnc: SafeStorageLike = { ...fakeSafe, isEncryptionAvailable: () => false };
    const store = new SecretsStore(join(dir, "secrets.enc"), noEnc);
    await expect(store.set("github", "tok")).rejects.toThrow(/encryption unavailable/i);
  });

  it("migrates the legacy single-purpose Jira store into the keyed blob, once", async () => {
    const legacy = new JiraCredentialStore(join(dir, "jira.cred"), fakeSafe);
    await legacy.save({ baseUrl: "https://acme.atlassian.net", email: "d@a.com", token: "tok" });

    const store = new SecretsStore(join(dir, "secrets.enc"), fakeSafe);
    await store.migrateLegacyJira(legacy);

    expect(JSON.parse((await store.get("jira"))!)).toEqual({
      baseUrl: "https://acme.atlassian.net",
      email: "d@a.com",
      token: "tok",
    });

    // A second migration never clobbers a newer value.
    await store.set("jira", JSON.stringify({ baseUrl: "https://new", email: "n@a.com", token: "t2" }));
    await store.migrateLegacyJira(legacy);
    expect(JSON.parse((await store.get("jira"))!).baseUrl).toBe("https://new");
  });
});
