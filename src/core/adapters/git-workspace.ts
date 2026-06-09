import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspacePort, DiscoveredClone } from "../ports/workspace.js";

const run = promisify(execFile);

export interface GitWorkspaceConfig {
  /** Developer-chosen directories to scan (one level deep) for git clones. */
  roots: string[];
}

/**
 * Real workspace adapter: scans each root's immediate children for git working trees and reads
 * each one's `origin` remote. One level deep keeps the scan cheap; identity comes from the
 * remote, not the path, so no naming/nesting is enforced (CONTEXT.md "Workspace root").
 */
export class GitWorkspace implements WorkspacePort {
  constructor(private readonly config: GitWorkspaceConfig) {}

  async listRoots(): Promise<string[]> {
    return this.config.roots;
  }

  /**
   * The branch an execute-mode sandbox should seed from (#7 AC: "seeded from a base branch", not from
   * whatever the clone happens to have checked out — PR review P1). Prefers the remote's default
   * (`origin/HEAD`), which `git clone` sets, so the seed is deterministic regardless of the clone's
   * current branch; falls back to the current branch for a local-only repo with no origin.
   *
   * Note: this is the v1 base. Seeding spec N from the *updated story-branch HEAD* (accumulation) is
   * the #8/#34 follow-up; here every spec seeds from the repo's default branch.
   */
  async defaultBranch(path: string): Promise<string> {
    try {
      const { stdout } = await run("git", [
        "-C",
        path,
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      const ref = stdout.trim();
      if (ref) return ref.replace(/^origin\//, "");
    } catch {
      // No origin/HEAD (local-only repo) — fall through to the current branch.
    }
    const { stdout } = await run("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim();
  }

  async discover(roots: string[]): Promise<DiscoveredClone[]> {
    const clones: DiscoveredClone[] = [];
    for (const root of roots) {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue; // unreadable root degrades to nothing, never throws (invariant 7)
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(root, entry.name);
        const origin = await this.readOrigin(path);
        if (origin === null) continue; // not a git repo
        clones.push(origin ? { path, originRemote: origin } : { path });
      }
    }
    return clones;
  }

  /**
   * Returns the origin URL, "" for a git repo with no origin, or null if `path` is not a git
   * repo ROOT. `git rev-parse` ascends the tree, so a workspace root that lives inside a repo
   * would otherwise bind every plain subdir to the enclosing repo; we require `path` to be the
   * repo's own top-level work tree.
   */
  private async readOrigin(path: string): Promise<string | null> {
    try {
      const { stdout } = await run("git", ["-C", path, "rev-parse", "--show-toplevel"]);
      const [toplevel, here] = await Promise.all([realpath(stdout.trim()), realpath(path)]);
      if (toplevel !== here) return null; // inside a repo, but not this dir's own root
    } catch {
      return null; // not a git work tree
    }
    try {
      const { stdout } = await run("git", ["-C", path, "remote", "get-url", "origin"]);
      return stdout.trim();
    } catch {
      return ""; // git repo, no origin
    }
  }
}
