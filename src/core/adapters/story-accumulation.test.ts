import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitWorkspace } from "./git-workspace.js";

const run = promisify(execFile);

/**
 * AC5 — multi-spec story-branch accumulation, end-to-end on a throwaway temp git repo (issue #8,
 * ADR-0013/0014). Drives the two GitWorkspace seams the orchestration loop uses per spec —
 * `seedBranch` (resolve the fork base) then `mergeIntoStoryBranch` (land the green spec) — across
 * two specs, the way `advanceFrom` does, and proves the property that makes accumulation real:
 * **spec N+1 is seeded from the accumulated story HEAD, so it builds on specs 1..N's work.**
 */
describe("story-branch accumulation (multi-spec, AC5)", () => {
  const branches = async (cwd: string) =>
    (await run("git", ["-C", cwd, "branch", "--format=%(refname:short)"])).stdout
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);

  // Build a green spec branch the way Sand Castle leaves one in the clone: fork `specBranch` from
  // `base`, write+commit a file, and return to a detached state off the branches under test.
  const buildSpec = async (repo: string, specBranch: string, base: string, file: string) => {
    await run("git", ["-C", repo, "checkout", "-q", "-b", specBranch, base]);
    await writeFile(join(repo, file), `${file} contents\n`);
    await run("git", ["-C", repo, "add", "."]);
    await run("git", ["-C", repo, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "-m", file]);
  };

  it("seeds each spec from the accumulated story HEAD and persists both spec + story branches", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dugout-acc-"));
    try {
      const ws = new GitWorkspace({ roots: [] });
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await writeFile(join(repo, "README"), "base\n");
      await run("git", ["-C", repo, "add", "."]);
      await run("git", ["-C", repo, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "-m", "base"]);

      // --- Spec 1: no story branch yet, so it seeds from the repo default ---
      const base1 = await ws.seedBranch(repo, "story/DUG-1");
      expect(base1).toBe("main");
      await buildSpec(repo, "spec/DUG-1/s1", base1, "a.txt");
      await ws.mergeIntoStoryBranch(repo, "DUG-1", "s1");

      // --- Spec 2: the story branch now exists, so it seeds from the ACCUMULATED HEAD ---
      const base2 = await ws.seedBranch(repo, "story/DUG-1");
      expect(base2).toBe("story/DUG-1");
      await buildSpec(repo, "spec/DUG-1/s2", base2, "b.txt");
      // Accumulation: spec 2's sandbox, forked from the story HEAD, already contains spec 1's work.
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("a.txt contents\n");
      await ws.mergeIntoStoryBranch(repo, "DUG-1", "s2");

      // The story branch carries BOTH specs' work...
      await run("git", ["-C", repo, "checkout", "-q", "story/DUG-1"]);
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("a.txt contents\n");
      expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("b.txt contents\n");

      // ...and every branch persists in the clone (no lost work before sandbox disposal — AC4).
      const present = await branches(repo);
      expect(present).toContain("story/DUG-1");
      expect(present).toContain("spec/DUG-1/s1");
      expect(present).toContain("spec/DUG-1/s2");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
