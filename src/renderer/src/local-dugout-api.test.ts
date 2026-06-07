import { describe, it, expect } from "vitest";
import { createLocalDugoutApi } from "./local-dugout-api.js";
import { RepoScope } from "../../core/repo-scope.js";
import { FakeCatalog } from "../../core/fakes/fake-catalog.js";
import { FakeWorkspace } from "../../core/fakes/fake-workspace.js";
import { FakeExecutor } from "../../core/fakes/fake-executor.js";
import type { ClarificationRound } from "../../core/ports/executor.js";

/** A RepoScope whose declared repos resolve to local clones, for draft-loop tests. */
function clonedScope(name: string): RepoScope {
  return new RepoScope(
    new FakeCatalog([{ name, remote: `git@github.com:acme/${name}.git` }]),
    new FakeWorkspace({
      roots: ["/ws"],
      clones: [{ path: `/ws/${name}`, originRemote: `git@github.com:acme/${name}.git` }],
    }),
  );
}

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

describe("local DugoutApi — clarification loop", () => {
  it("threads the developer's answered rounds through draft() to the executor (oldest-first)", async () => {
    const executor = new FakeExecutor({
      draft: [
        { result: "needs-clarification", questions: [{ id: "q1", prompt: "Soft or hard delete?" }] },
        { result: "drafted", specs: [{ repo: "web", markdown: "# Spec (web)" }] },
      ],
    });
    const api = createLocalDugoutApi({
      tickets: [{ key: "DUG-1", title: "Add widget", description: "AC: returns 200" }],
      executor,
      repoScope: clonedScope("web"),
    });

    const repos = await api.declareRepos(["web"]);

    const first = await api.draft("DUG-1", repos);
    expect(first.outcome).toBe("needs-clarification");

    const rounds: ClarificationRound[] = [
      { answers: [{ questionId: "q1", question: "Soft or hard delete?", answer: "Soft." }] },
    ];
    const second = await api.draft("DUG-1", repos, rounds);
    expect(second.outcome).toBe("drafted");

    expect(executor.draftCalls).toHaveLength(2);
    expect(executor.draftCalls[0]!.clarifications).toBeUndefined();
    expect(executor.draftCalls[1]!.clarifications).toEqual(rounds);
  });
});
