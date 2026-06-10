import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, symlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitWorkspace } from "./git-workspace.js";

const run = promisify(execFile);
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dugout-ws-"));
  // A clone WITH an origin:
  const a = join(root, "widget-api");
  await mkdir(a);
  await run("git", ["init", "-q"], { cwd: a });
  await run("git", ["remote", "add", "origin", "git@github.com:acme/widget-api.git"], { cwd: a });
  // A plain dir that is NOT a git repo (must be skipped):
  await mkdir(join(root, "not-a-repo"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("GitWorkspace.discover", () => {
  it("finds git clones under a root and reads their origin remote", async () => {
    const ws = new GitWorkspace({ roots: [root] });
    const clones = await ws.discover([root]);
    const widget = clones.find((c) => c.path.endsWith("widget-api"));
    expect(widget?.originRemote).toBe("git@github.com:acme/widget-api.git");
    expect(clones.some((c) => c.path.endsWith("not-a-repo"))).toBe(false);
  });

  it("returns the configured roots", async () => {
    expect(await new GitWorkspace({ roots: [root] }).listRoots()).toEqual([root]);
  });

  it("returns canonical (realpath) clone paths, not paths reached through a symlinked root", async () => {
    // Sand Castle bind-mounts the worktree at the path we hand it; a non-canonical path (e.g. macOS
    // /var -> /private/var, or any symlinked workspace root) leaves the in-container gitdir unmounted.
    // The discovered path must be canonical so the product seam matches what the agent test does by hand.
    const real = await mkdtemp(join(tmpdir(), "dugout-real-"));
    const linkParent = await mkdtemp(join(tmpdir(), "dugout-link-"));
    const link = join(linkParent, "via-symlink");
    try {
      const clone = join(real, "widget-api");
      await mkdir(clone);
      await run("git", ["init", "-q"], { cwd: clone });
      await symlink(real, link); // link -> real
      const clones = await new GitWorkspace({ roots: [link] }).discover([link]);
      const widget = clones.find((c) => c.path.endsWith("widget-api"));
      expect(widget?.path).toBe(await realpath(clone));
    } finally {
      await rm(real, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  });

  it("does not mis-detect plain subdirs as clones when the root is itself inside a git repo", async () => {
    // If the workspace root lives inside a repo (e.g. ~/work under a dotfiles repo), git ascends
    // the tree, so a naive is-inside-work-tree check would bind every plain subdir to the
    // enclosing repo's origin. Only a directory that is its OWN repo root is a clone.
    const parent = await mkdtemp(join(tmpdir(), "dugout-parent-"));
    await run("git", ["init", "-q"], { cwd: parent });
    await run("git", ["remote", "add", "origin", "git@github.com:acme/parent.git"], { cwd: parent });
    await mkdir(join(parent, "plain-child")); // a plain dir, not its own repo
    try {
      const clones = await new GitWorkspace({ roots: [parent] }).discover([parent]);
      expect(clones.some((c) => c.path.endsWith("plain-child"))).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

const commit = (cwd: string) =>
  run("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"], { cwd });

describe("GitWorkspace.deleteBranch", () => {
  const branches = async (cwd: string) =>
    (await run("git", ["-C", cwd, "branch", "--format=%(refname:short)"])).stdout.split("\n").map((b) => b.trim()).filter(Boolean);

  it("deletes the spec branch so the next run re-forks it clean (clean restart, invariant 1)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dugout-del-"));
    try {
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await commit(repo);
      await run("git", ["-C", repo, "branch", "spec/DUG-1/s1"]);
      expect(await branches(repo)).toContain("spec/DUG-1/s1");
      await new GitWorkspace({ roots: [] }).deleteBranch(repo, "spec/DUG-1/s1");
      expect(await branches(repo)).not.toContain("spec/DUG-1/s1");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("is a no-op when the branch does not exist (a fresh first run, never a restart)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dugout-del-noop-"));
    try {
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await commit(repo);
      await expect(
        new GitWorkspace({ roots: [] }).deleteBranch(repo, "spec/DUG-1/never"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("GitWorkspace.seedBranch", () => {
  it("returns the preferred branch when it exists (the accumulated story branch — #8)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dugout-seed-"));
    try {
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await commit(repo);
      await run("git", ["-C", repo, "branch", "story/DUG-1"]);
      expect(await new GitWorkspace({ roots: [] }).seedBranch(repo, "story/DUG-1")).toBe("story/DUG-1");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("falls back to the default branch when the preferred branch does not exist (first spec)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dugout-seed-fallback-"));
    try {
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await commit(repo);
      // No story branch yet — seed from the repo default, exactly today's single-spec behaviour.
      expect(await new GitWorkspace({ roots: [] }).seedBranch(repo, "story/DUG-1")).toBe("main");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("GitWorkspace.mergeIntoStoryBranch", () => {
  const branches = async (cwd: string) =>
    (await run("git", ["-C", cwd, "branch", "--format=%(refname:short)"])).stdout
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);

  // Build a clone whose default branch `main` has one commit, then fork a spec branch off it with
  // its own file commit — the shape Sand Castle leaves behind after a green run (the spec branch
  // lives in the clone, ADR-0013).
  const seedSpecBranch = async (repo: string, specBranch: string, file: string) => {
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    // mergeIntoStoryBranch creates a real --no-ff merge commit via production code we can't pass `-c`
    // to, so the repo needs a persistent committer identity (CI has no global git config; a dev's
    // real clone does — relying on the ambient identity is correct for production, ADR-0014).
    await run("git", ["-C", repo, "config", "user.email", "a@b.c"]);
    await run("git", ["-C", repo, "config", "user.name", "a"]);
    await commit(repo);
    await run("git", ["-C", repo, "checkout", "-q", "-b", specBranch]);
    await run("git", ["-C", repo, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", file]);
    await run("git", ["-C", repo, "checkout", "-q", "main"]);
  };

  it("creates the story branch from the repo default and merges the first spec --no-ff", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dugout-merge-"));
    try {
      await seedSpecBranch(repo, "spec/DUG-1/s1", "spec-1 work");
      await new GitWorkspace({ roots: [] }).mergeIntoStoryBranch(repo, "DUG-1", "s1");

      // The story branch now exists and carries the spec's commit.
      expect(await branches(repo)).toContain("story/DUG-1");
      const storyLog = (await run("git", ["-C", repo, "log", "--format=%s", "story/DUG-1"])).stdout;
      expect(storyLog).toContain("spec-1 work");
      // --no-ff: an explicit merge commit (two parents) tops the story branch (ADR-0014).
      const head = await run("git", ["-C", repo, "rev-list", "--merges", "-1", "story/DUG-1"]);
      expect(head.stdout.trim()).not.toBe("");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("does NOT merge onto the wrong branch when the story checkout fails (a dirty tree throws first)", async () => {
    // Refutes the review claim that a blocked checkout lets the merge run on the wrong branch: the
    // awaited `git checkout` rejects on non-zero exit, so mergeIntoStoryBranch throws before the
    // merge line is ever reached. The merge never lands on the currently-checked-out branch — the
    // throw surfaces as an operational error the orchestrator unwinds to `failed` (ADR-0014 pt 5).
    const repo = await mkdtemp(join(tmpdir(), "dugout-merge-dirty-"));
    try {
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await run("git", ["-C", repo, "config", "user.email", "a@b.c"]);
      await run("git", ["-C", repo, "config", "user.name", "a"]);
      await writeFile(join(repo, "x"), "base\n");
      await run("git", ["-C", repo, "add", "."]);
      await run("git", ["-C", repo, "commit", "-q", "-m", "base"]);
      // A pre-existing story branch whose `x` diverges from main, plus a spec branch to merge.
      await run("git", ["-C", repo, "checkout", "-q", "-b", "story/DUG-1"]);
      await writeFile(join(repo, "x"), "story-version\n");
      await run("git", ["-C", repo, "commit", "-aqm", "story x"]);
      await run("git", ["-C", repo, "checkout", "-q", "-b", "spec/DUG-1/s1", "main"]);
      await run("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "spec work"]);
      // Land on main with an UNCOMMITTED change to `x` — checking out story/DUG-1 (where `x` differs)
      // would clobber it, so `git checkout` refuses with a non-zero exit.
      await run("git", ["-C", repo, "checkout", "-q", "main"]);
      const mainHeadBefore = (await run("git", ["-C", repo, "rev-parse", "main"])).stdout.trim();
      await writeFile(join(repo, "x"), "dirty-uncommitted\n");

      await expect(new GitWorkspace({ roots: [] }).mergeIntoStoryBranch(repo, "DUG-1", "s1")).rejects.toThrow();

      // The merge did NOT execute on the wrong branch: we're still on main and main is unchanged.
      expect((await run("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("main");
      expect((await run("git", ["-C", repo, "rev-parse", "main"])).stdout.trim()).toBe(mainHeadBefore);
      expect((await run("git", ["-C", repo, "log", "--format=%s", "main"])).stdout).not.toContain("spec work");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("aborts a conflicting merge so the repo is not left mid-merge (restartable; ADR-0014)", async () => {
    // Conflicts can't arise in serial v1, but ADR-0014 pt 5 requires that if a merge DOES fail
    // (out-of-band git), we `git merge --abort` before propagating — otherwise MERGE_HEAD + a
    // conflicted index linger and the orchestrator's "restartable failed" state is a lie.
    const repo = await mkdtemp(join(tmpdir(), "dugout-merge-conflict-"));
    try {
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await run("git", ["-C", repo, "config", "user.email", "a@b.c"]);
      await run("git", ["-C", repo, "config", "user.name", "a"]);
      await writeFile(join(repo, "x"), "base\n");
      await run("git", ["-C", repo, "add", "."]);
      await run("git", ["-C", repo, "commit", "-q", "-m", "base"]);
      // story and spec each change `x` divergently from base → a 3-way merge conflict.
      await run("git", ["-C", repo, "checkout", "-q", "-b", "story/DUG-1"]);
      await writeFile(join(repo, "x"), "story-change\n");
      await run("git", ["-C", repo, "commit", "-aqm", "story x"]);
      await run("git", ["-C", repo, "checkout", "-q", "-b", "spec/DUG-1/s1", "main"]);
      await writeFile(join(repo, "x"), "spec-change\n");
      await run("git", ["-C", repo, "commit", "-aqm", "spec x"]);
      await run("git", ["-C", repo, "checkout", "-q", "main"]);

      await expect(new GitWorkspace({ roots: [] }).mergeIntoStoryBranch(repo, "DUG-1", "s1")).rejects.toThrow();

      // The merge was aborted: no MERGE_HEAD lingering, and the story branch keeps its pre-merge HEAD.
      await expect(run("git", ["-C", repo, "rev-parse", "-q", "--verify", "MERGE_HEAD"])).rejects.toThrow();
      const storyLog = (await run("git", ["-C", repo, "log", "--format=%s", "story/DUG-1"])).stdout;
      expect(storyLog).not.toContain("Merge");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("accumulates a second spec onto the existing story branch (specs 1..N stack)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dugout-merge-acc-"));
    try {
      const ws = new GitWorkspace({ roots: [] });
      await seedSpecBranch(repo, "spec/DUG-1/s1", "spec-1 work");
      await ws.mergeIntoStoryBranch(repo, "DUG-1", "s1");

      // Spec 2 forks from the accumulated story HEAD (what resolveBaseBranch yields once #8 lands),
      // adds its own commit, and merges back — the second spec stacks on the first.
      await run("git", ["-C", repo, "checkout", "-q", "-b", "spec/DUG-1/s2", "story/DUG-1"]);
      await run("git", ["-C", repo, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "spec-2 work"]);
      await run("git", ["-C", repo, "checkout", "-q", "main"]);
      await ws.mergeIntoStoryBranch(repo, "DUG-1", "s2");

      const storyLog = (await run("git", ["-C", repo, "log", "--format=%s", "story/DUG-1"])).stdout;
      expect(storyLog).toContain("spec-1 work");
      expect(storyLog).toContain("spec-2 work");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("GitWorkspace.defaultBranch", () => {
  it("returns the current branch for a local-only repo with no origin", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dugout-db-local-"));
    try {
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await commit(repo);
      expect(await new GitWorkspace({ roots: [] }).defaultBranch(repo)).toBe("main");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns the remote's default branch (origin/HEAD), NOT whatever is checked out", async () => {
    const base = await mkdtemp(join(tmpdir(), "dugout-db-"));
    const source = join(base, "source");
    const clone = join(base, "clone");
    try {
      await mkdir(source);
      await run("git", ["init", "-q", "-b", "main"], { cwd: source });
      await commit(source);
      await run("git", ["clone", "-q", source, clone]);
      // The developer left the clone on a feature branch — the seed base must still be the remote
      // default, not the accidentally-checked-out branch (#7 AC; PR review P1).
      await run("git", ["-C", clone, "checkout", "-q", "-b", "feature/x"]);
      expect(await new GitWorkspace({ roots: [] }).defaultBranch(clone)).toBe("main");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("GitWorkspace.pushBranch (#10)", () => {
  it("pushes the local story branch to origin (the single end-of-story push)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dugout-push-"));
    try {
      // A bare "remote" + a clone with one commit on a story branch.
      const bare = join(dir, "remote.git");
      await run("git", ["init", "-q", "--bare", "-b", "main", bare]);
      const repo = join(dir, "clone");
      await mkdir(repo);
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await run("git", ["-C", repo, "config", "user.email", "a@b.c"], {});
      await run("git", ["-C", repo, "config", "user.name", "a"], {});
      await run("git", ["-C", repo, "remote", "add", "origin", bare], {});
      await writeFile(join(repo, "f.txt"), "x");
      await run("git", ["-C", repo, "add", "-A"], {});
      await run("git", ["-C", repo, "commit", "-qm", "init"], {});
      await run("git", ["-C", repo, "branch", "story/DUG-1"], {});

      await new GitWorkspace({ roots: [] }).pushBranch(repo, "story/DUG-1");

      const remoteBranches = (await run("git", ["-C", bare, "branch", "--format=%(refname:short)"])).stdout;
      expect(remoteBranches).toContain("story/DUG-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
