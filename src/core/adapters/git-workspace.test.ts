import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, symlink, realpath } from "node:fs/promises";
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
