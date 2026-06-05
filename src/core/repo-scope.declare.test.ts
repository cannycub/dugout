import { describe, it, expect } from "vitest";
import { RepoScope } from "./repo-scope.js";
import { FakeCatalog } from "./fakes/fake-catalog.js";
import { FakeWorkspace } from "./fakes/fake-workspace.js";

describe("RepoScope.declare / rescan", () => {
  it("declares a not-cloned repo (selectable, no path) and a cloned one", async () => {
    const scope = new RepoScope(
      new FakeCatalog([
        { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
        { name: "ledger", remote: "git@github.com:acme/ledger.git" },
      ]),
      new FakeWorkspace({
        roots: ["/ws"],
        clones: [{ path: "/ws/widget-api", originRemote: "git@github.com:acme/widget-api.git" }],
      }),
    );
    const declared = await scope.declare(["widget-api", "ledger"]);
    expect(declared.find((d) => d.identity.name === "widget-api")!.clone).toEqual({
      status: "cloned",
      path: "/ws/widget-api",
    });
    expect(declared.find((d) => d.identity.name === "ledger")!.clone).toEqual({
      status: "not-cloned",
    });
  });

  it("throws when declaring a name not in the catalog", async () => {
    const scope = new RepoScope(new FakeCatalog([]), new FakeWorkspace({ roots: [], clones: [] }));
    await expect(scope.declare(["nope"])).rejects.toThrow(/not in the catalog/);
  });

  it("rescan re-reads the workspace so newly-cloned repos bind", async () => {
    const workspace = new FakeWorkspace({ roots: ["/ws"], clones: [] });
    const scope = new RepoScope(
      new FakeCatalog([{ name: "ledger", remote: "git@github.com:acme/ledger.git" }]),
      workspace,
    );
    expect((await scope.declare(["ledger"]))[0]!.clone.status).toBe("not-cloned");
    // Developer clones it mid-flight:
    workspace.addClone({ path: "/ws/ledger", originRemote: "git@github.com:acme/ledger.git" });
    await scope.rescan();
    expect((await scope.declare(["ledger"]))[0]!.clone).toEqual({
      status: "cloned",
      path: "/ws/ledger",
    });
  });
});
