import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
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
