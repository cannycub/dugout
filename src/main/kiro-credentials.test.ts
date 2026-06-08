import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroCredentialStore, kiroApiKeyFromEnv } from "./kiro-credentials.js";
import type { SafeStorageLike } from "./jira-credentials.js";

// Reversible "encryption" stand-in for safeStorage (real safeStorage is unavailable in vitest).
const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ""),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dugout-kiro-cred-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("KiroCredentialStore", () => {
  it("round-trips the api key encrypted at rest", async () => {
    const store = new KiroCredentialStore(join(dir, "kiro.cred"), fakeSafe);
    expect(await store.load()).toBeNull();
    await store.save("kiro-key-123");
    expect(await store.load()).toBe("kiro-key-123");
  });

  it("degrades to null (never throws) when the cred file can't be decrypted", async () => {
    const throwingSafe: SafeStorageLike = {
      ...fakeSafe,
      decryptString: () => {
        throw new Error("cannot decrypt: foreign keychain");
      },
    };
    const file = join(dir, "kiro.cred");
    await new KiroCredentialStore(file, fakeSafe).save("kiro-key-123");
    expect(await new KiroCredentialStore(file, throwingSafe).load()).toBeNull();
  });
});

describe("kiroApiKeyFromEnv", () => {
  it("reads KIRO_API_KEY from the environment", () => {
    expect(kiroApiKeyFromEnv({ KIRO_API_KEY: "k-1" })).toBe("k-1");
  });
  it("returns null when unset or empty, so the app degrades rather than building a keyless adapter", () => {
    expect(kiroApiKeyFromEnv({})).toBeNull();
    expect(kiroApiKeyFromEnv({ KIRO_API_KEY: "" })).toBeNull();
  });
});
