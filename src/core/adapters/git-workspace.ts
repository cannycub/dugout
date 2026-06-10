import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspacePort, DiscoveredClone } from "../ports/workspace.js";

const run = promisify(execFile);

export interface GitWorkspaceConfig {
  /**
   * Developer-chosen directories to scan (one level deep) for git clones. A thunk makes the roots
   * LIVE (#17): the settings UI edits them and the next rescan sees the new set, no restart.
   */
  roots: string[] | (() => string[]);
}

/**
 * Real workspace adapter: scans each root's immediate children for git working trees and reads
 * each one's `origin` remote. One level deep keeps the scan cheap; identity comes from the
 * remote, not the path, so no naming/nesting is enforced (CONTEXT.md "Workspace root").
 */
export class GitWorkspace implements WorkspacePort {
  constructor(private readonly config: GitWorkspaceConfig) {}

  async listRoots(): Promise<string[]> {
    return typeof this.config.roots === "function" ? this.config.roots() : this.config.roots;
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

  /**
   * Remove `branch` from the clone if it exists, so an execute-mode run re-forks it clean from the
   * base rather than resuming a failed attempt's commits (invariant 1; ADR-0013). Sand Castle ignores
   * `baseBranch` when the branch already exists, so deleting it first is the only lever.
   *
   * Prunes stale worktree admin entries first (a crashed run can leave one dangling); a *live*
   * worktree still pinned to the branch makes `branch -D` fail, which surfaces as an operational error
   * the developer resolves — acceptable for v1's rare hard-crash case. Deleting an absent branch is a
   * no-op (a fresh first run is not a restart).
   */
  async deleteBranch(path: string, branch: string): Promise<void> {
    await run("git", ["-C", path, "worktree", "prune"]).catch(() => {});
    try {
      await run("git", ["-C", path, "branch", "-D", branch]);
    } catch {
      // Branch absent (the common first-run case) — nothing to clean up.
    }
  }

  /**
   * The branch an execute-mode spec should seed (fork) from: `preferred` if it exists locally, else
   * the repo's {@link defaultBranch}. `preferred` is the per-repo story branch (`story/<key>`); today
   * it never exists, so this always returns the default — identical to single-spec behaviour. Once #8
   * creates and accumulates the story branch, the same call seeds spec N from the accumulated HEAD,
   * with no change to the orchestrator or adapter (ADR-0013).
   */
  async seedBranch(path: string, preferred: string): Promise<string> {
    try {
      await run("git", ["-C", path, "rev-parse", "--verify", "--quiet", `refs/heads/${preferred}`]);
      return preferred; // the ref exists
    } catch {
      return this.defaultBranch(path);
    }
  }

  /**
   * Merge a green spec's branch into the per-repo story branch, locally (CONTEXT.md "Story branch";
   * ADR-0014). Creates `story/<storyKey>` from the repo default the first time (lazily, on the first
   * green merge — a story that fails before any green leaves no empty story branch), then merges
   * `spec/<storyKey>/<specId>` into it with `--no-ff` so each spec lands as one legible merge bubble
   * for the eventual PR reviewer.
   *
   * In serial v1 the spec branch is always a descendant of the current story HEAD (nothing else
   * writes the story branch between a spec's fork and its merge), so the merge always fast-forwards;
   * `--no-ff` forces the merge commit anyway. A conflict is therefore impossible in normal flow — if
   * the merge fails it signals out-of-band manual git, which surfaces as an operational error the
   * orchestrator unwinds to a restartable `failed` state (ADR-0014).
   */
  async mergeIntoStoryBranch(path: string, storyKey: string, specId: string): Promise<void> {
    const story = `story/${storyKey}`;
    const spec = `spec/${storyKey}/${specId}`;
    const exists = await run("git", ["-C", path, "rev-parse", "--verify", "--quiet", `refs/heads/${story}`])
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await run("git", ["-C", path, "branch", story, await this.defaultBranch(path)]);
    }
    await run("git", ["-C", path, "checkout", "-q", story]);
    try {
      await run("git", ["-C", path, "merge", "--no-ff", "--no-edit", "-m", `Merge ${spec}`, spec]);
    } catch (err) {
      // A failed merge (conflict / out-of-band git) must not leave the repo mid-merge: abort so the
      // index and worktree return to the pre-merge story HEAD, keeping the orchestrator's
      // unwind-to-`failed` genuinely restartable (ADR-0014 pt 5). Best-effort — if there is nothing
      // to abort (e.g. the merge never started), swallow that and surface the original error.
      await run("git", ["-C", path, "merge", "--abort"]).catch(() => {});
      throw err;
    }
  }

  /**
   * Push a local branch to `origin` (#10): the single end-of-story push. A git operation on the
   * clone's own remote/credentials — the GitHub REST adapter delegates here because the API cannot
   * push a local branch. Failure surfaces as an operational error (fix auth/remote, retry).
   */
  async pushBranch(path: string, branch: string): Promise<void> {
    await run("git", ["-C", path, "push", "origin", branch]);
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
        // Canonicalise via realpath at the source so every consumer (notably the execute seam, where
        // Sand Castle bind-mounts the worktree) gets a path whose symlinks are resolved — a
        // non-canonical path (macOS /var -> /private/var) leaves the in-container gitdir unmounted.
        const path = await realpath(join(root, entry.name));
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
