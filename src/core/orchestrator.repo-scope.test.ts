import { describe, it, expect } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { RepoScope } from "./repo-scope.js";
import { FakeCatalog } from "./fakes/fake-catalog.js";
import { FakeWorkspace } from "./fakes/fake-workspace.js";
import { FakeJira } from "./fakes/fake-jira.js";
import { FakeExecutor } from "./fakes/fake-executor.js";
import { FakeGitHub } from "./fakes/fake-github.js";
import { FakeMetrics } from "./fakes/fake-metrics.js";
import { FakeEnvReplay } from "./fakes/fake-env-replay.js";

function orchestratorWithScope() {
  const repoScope = new RepoScope(
    new FakeCatalog([{ name: "widget-api", remote: "git@github.com:acme/widget-api.git" }]),
    new FakeWorkspace({
      roots: ["/ws"],
      clones: [{ path: "/ws/widget-api", originRemote: "git@github.com:acme/widget-api.git" }],
    }),
  );
  return new Orchestrator({
    jira: new FakeJira({ tickets: [] }),
    executor: new FakeExecutor({ draft: { result: "drafted", specs: [] } }),
    github: new FakeGitHub(),
    metrics: new FakeMetrics(),
    envReplay: new FakeEnvReplay(),
    repoScope,
  });
}

describe("orchestrator repo-scope pass-through", () => {
  it("searches the catalog and binds clones", async () => {
    const matches = await orchestratorWithScope().searchRepos("widget");
    expect(matches[0]!.clone).toEqual({ status: "cloned", path: "/ws/widget-api" });
  });

  it("throws if no repoScope is configured", async () => {
    const o = orchestratorWithScope();
    (o as unknown as { deps: { repoScope?: unknown } }).deps.repoScope = undefined;
    await expect(o.searchRepos("x")).rejects.toThrow(/repo scope/i);
  });
});
