import { describe, it, expect } from "vitest";
import { canonicalRemote } from "./repo-scope.js";

describe("canonicalRemote", () => {
  it("normalizes ssh and https forms of the same repo to one key", () => {
    const ssh = canonicalRemote("git@github.com:acme/Widget-API.git");
    const https = canonicalRemote("https://github.com/acme/widget-api");
    expect(ssh).toBe(https);
    expect(ssh).toBe("github.com/acme/widget-api");
  });

  it("strips trailing slash and .git, lowercases host+path", () => {
    expect(canonicalRemote("https://GitHub.com/Acme/Repo.git/")).toBe("github.com/acme/repo");
  });

  it("strips an explicit port so ssh:// and scp forms of the same repo match", () => {
    const sshUrl = canonicalRemote("ssh://git@github.com:22/acme/widget-api.git");
    const scp = canonicalRemote("git@github.com:acme/widget-api.git");
    expect(sshUrl).toBe(scp);
    expect(sshUrl).toBe("github.com/acme/widget-api");
  });

  it("returns empty string for an undefined/blank remote", () => {
    expect(canonicalRemote(undefined)).toBe("");
    expect(canonicalRemote("")).toBe("");
  });
});
