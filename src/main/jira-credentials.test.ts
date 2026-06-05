import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraCredentialStore, type SafeStorageLike } from "./jira-credentials.js";

// Reversible "encryption" stand-in for safeStorage (real safeStorage is unavailable in vitest).
const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ""),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dugout-cred-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JiraCredentialStore", () => {
  it("round-trips credentials encrypted at rest", async () => {
    const store = new JiraCredentialStore(join(dir, "jira.cred"), fakeSafe);
    expect(await store.load()).toBeNull();
    await store.save({ baseUrl: "https://acme.atlassian.net", email: "d@a.com", token: "tok" });
    expect(await store.load()).toEqual({
      baseUrl: "https://acme.atlassian.net",
      email: "d@a.com",
      token: "tok",
    });
  });
});
