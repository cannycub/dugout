import { describe, it, expect } from "vitest";
import { GitHubCatalog } from "./github-catalog.js";
import { FakeGitHub } from "../fakes/fake-github.js";

describe("GitHubCatalog", () => {
  it("projects org repos into catalog identities", async () => {
    const gh = new FakeGitHub([
      { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
      { name: "pipeline", remote: "git@github.com:acme/pipeline.git" },
    ]);
    const catalog = new GitHubCatalog(gh);
    expect(await catalog.listRepos()).toEqual([
      { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
      { name: "pipeline", remote: "git@github.com:acme/pipeline.git" },
    ]);
  });
});
