import { describe, it, expect } from "vitest";
import { createLocalDugoutApi } from "./local-dugout-api.js";
import { RepoScope } from "../../core/repo-scope.js";
import { FakeCatalog } from "../../core/fakes/fake-catalog.js";
import { FakeWorkspace } from "../../core/fakes/fake-workspace.js";

describe("local DugoutApi — declareRepos", () => {
  it("binds declared names against the current index, reflecting a mid-flight clone after rescan", async () => {
    const workspace = new FakeWorkspace({ roots: ["/ws"], clones: [] });
    const api = createLocalDugoutApi({
      tickets: [],
      draft: { result: "drafted", specs: [] },
      repoScope: new RepoScope(
        new FakeCatalog([{ name: "widget-api", remote: "git@github.com:acme/widget-api.git" }]),
        workspace,
      ),
    });

    // Declared before the clone exists → not-cloned (resolved server-side, not from a UI snapshot).
    expect((await api.declareRepos(["widget-api"]))[0]!.clone).toEqual({ status: "not-cloned" });

    // The developer clones it mid-flight and rescans; declaring now re-resolves to the local clone.
    workspace.addClone({ path: "/ws/widget-api", originRemote: "git@github.com:acme/widget-api.git" });
    await api.rescanRepos();

    expect((await api.declareRepos(["widget-api"]))[0]!.clone).toEqual({
      status: "cloned",
      path: "/ws/widget-api",
    });
  });
});
