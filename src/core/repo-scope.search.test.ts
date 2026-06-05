import { describe, it, expect } from "vitest";
import { RepoScope } from "./repo-scope.js";
import { FakeCatalog } from "./fakes/fake-catalog.js";
import { FakeWorkspace } from "./fakes/fake-workspace.js";

function scope() {
  const catalog = new FakeCatalog([
    { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
    { name: "pipeline", remote: "git@github.com:acme/pipeline.git" },
    { name: "ledger", remote: "git@github.com:acme/ledger.git" },
  ]);
  const workspace = new FakeWorkspace({
    roots: ["/ws"],
    clones: [
      // ssh↔https still matches widget-api:
      { path: "/ws/widget-api", originRemote: "https://github.com/acme/widget-api.git" },
      // two clones of pipeline ⇒ ambiguous:
      { path: "/ws/pipeline", originRemote: "git@github.com:acme/pipeline.git" },
      { path: "/ws/pipeline-copy", originRemote: "git@github.com:acme/pipeline.git" },
    ],
  });
  return new RepoScope(catalog, workspace);
}

describe("RepoScope.search", () => {
  it("binds cloned, not-cloned, and ambiguous repos", async () => {
    const all = await scope().search("");
    const byName = Object.fromEntries(all.map((m) => [m.identity.name, m.clone]));
    expect(byName["widget-api"]).toEqual({ status: "cloned", path: "/ws/widget-api" });
    expect(byName["ledger"]).toEqual({ status: "not-cloned" });
    expect(byName["pipeline"]).toEqual({
      status: "ambiguous",
      candidates: ["/ws/pipeline", "/ws/pipeline-copy"],
    });
  });

  it("filters by case-insensitive substring of the name", async () => {
    const hits = await scope().search("WIDGET");
    expect(hits.map((m) => m.identity.name)).toEqual(["widget-api"]);
  });
});
