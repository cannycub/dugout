import { describe, it, expect } from "vitest";
import { RepoScope } from "./repo-scope.js";
import { FakeCatalog } from "./fakes/fake-catalog.js";
import { FakeWorkspace } from "./fakes/fake-workspace.js";

const LEDGER = { name: "ledger", remote: "git@github.com:acme/ledger.git" };

const scopeWith = (clones: { path: string; originRemote: string }[]) => {
  const workspace = new FakeWorkspace({ roots: ["/ws"], clones });
  return { workspace, scope: new RepoScope(new FakeCatalog([LEDGER]), workspace) };
};

describe("RepoScope.resolveClonePath (execute-seam clone resolution, ADR-0013)", () => {
  it("returns the clone path when the repo is cloned, without rescanning", async () => {
    const { scope, workspace } = scopeWith([{ path: "/ws/ledger", originRemote: LEDGER.remote }]);
    expect(await scope.resolveClonePath("ledger")).toBe("/ws/ledger");
    expect(workspace.discoverCalls.length).toBe(1); // no rescan needed
  });

  it("rescans once and binds a clone that appeared after the cache was built (stale cache)", async () => {
    const { scope, workspace } = scopeWith([]);
    await scope.declare(["ledger"]); // primes the cache as not-cloned (e.g. at draft time)
    workspace.addClone({ path: "/ws/ledger", originRemote: LEDGER.remote }); // dev clones it
    expect(await scope.resolveClonePath("ledger")).toBe("/ws/ledger");
    expect(workspace.discoverCalls.length).toBe(2); // initial + one rescan
  });

  it("throws an operational error when the clone is still missing after a rescan", async () => {
    const { scope, workspace } = scopeWith([]);
    await expect(scope.resolveClonePath("ledger")).rejects.toThrow(/not cloned/i);
    expect(workspace.discoverCalls.length).toBe(2); // tried a rescan before giving up
  });

  it("throws for an uncatalogued repo", async () => {
    const { scope } = scopeWith([]);
    await expect(scope.resolveClonePath("nope")).rejects.toThrow(/not in the catalog/);
  });

  it("throws (disambiguation needed) when more than one clone matches the remote", async () => {
    const { scope } = scopeWith([
      { path: "/ws/a/ledger", originRemote: LEDGER.remote },
      { path: "/ws/b/ledger", originRemote: LEDGER.remote },
    ]);
    await expect(scope.resolveClonePath("ledger")).rejects.toThrow(/multiple|disambiguate|ambiguous/i);
  });
});
