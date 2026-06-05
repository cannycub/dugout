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

  it("returns empty string for an undefined/blank remote", () => {
    expect(canonicalRemote(undefined)).toBe("");
    expect(canonicalRemote("")).toBe("");
  });
});
