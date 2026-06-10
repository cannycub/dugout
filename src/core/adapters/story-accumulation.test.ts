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
      // mergeIntoStoryBranch creates a real --no-ff merge commit via production code, so the repo
      // needs a persistent committer identity (CI has no global git config). See git-workspace.test.
      await run("git", ["-C", repo, "config", "user.email", "a@b.c"]);
      await run("git", ["-C", repo, "config", "user.name", "a"]);
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

/**
 * #9 — direct edits at a review-required stop. The developer's write surface is the story branch
 * (ADR-0014); their commits during the stop must flow forward into the next spec's seed and
 * survive the next spec's merge untouched (the agent never clobbers human commits).
 */
describe("direct edits during a review stop flow forward and are never clobbered (#9)", () => {
  it("a dev commit on the story branch reaches spec 2's seed and survives spec 2's merge", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dugout-directedit-"));
    try {
      const ws = new GitWorkspace({ roots: [] });
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await run("git", ["-C", repo, "config", "user.email", "a@b.c"]);
      await run("git", ["-C", repo, "config", "user.name", "a"]);
      await writeFile(join(repo, "README"), "base\n");
      await run("git", ["-C", repo, "add", "."]);
      await run("git", ["-C", repo, "commit", "-q", "-m", "base"]);

      // Spec 1 merges green; the run pauses at its review-required stop.
      const base1 = await ws.seedBranch(repo, "story/DUG-1");
      await run("git", ["-C", repo, "checkout", "-q", "-b", "spec/DUG-1/s1", base1]);
      await writeFile(join(repo, "a.txt"), "agent version\n");
      await run("git", ["-C", repo, "add", "."]);
      await run("git", ["-C", repo, "commit", "-q", "-m", "[DUG-1-s1] agent work"]);
      await ws.mergeIntoStoryBranch(repo, "DUG-1", "s1");

      // During the stop the developer touches up the agent's file ON THE STORY BRANCH — the single
      // write surface (ADR-0014 pt 3) — and adds a file of their own.
      await run("git", ["-C", repo, "checkout", "-q", "story/DUG-1"]);
      await writeFile(join(repo, "a.txt"), "dev touch-up\n");
      await writeFile(join(repo, "dev-note.md"), "human-authored\n");
      await run("git", ["-C", repo, "add", "."]);
      await run("git", ["-C", repo, "commit", "-q", "-m", "review touch-up (human)"]);

      // Resume: spec 2 seeds from the story HEAD — the dev's edits are already in its base.
      const base2 = await ws.seedBranch(repo, "story/DUG-1");
      expect(base2).toBe("story/DUG-1");
      await run("git", ["-C", repo, "checkout", "-q", "-b", "spec/DUG-1/s2", base2]);
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("dev touch-up\n");
      expect(await readFile(join(repo, "dev-note.md"), "utf8")).toBe("human-authored\n");
      await writeFile(join(repo, "b.txt"), "spec 2 work\n");
      await run("git", ["-C", repo, "add", "."]);
      await run("git", ["-C", repo, "commit", "-q", "-m", "[DUG-1-s2] agent work"]);
      await ws.mergeIntoStoryBranch(repo, "DUG-1", "s2");

      // After spec 2's merge, the human commits are intact on the story branch — never clobbered.
      await run("git", ["-C", repo, "checkout", "-q", "story/DUG-1"]);
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("dev touch-up\n");
      expect(await readFile(join(repo, "dev-note.md"), "utf8")).toBe("human-authored\n");
      expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("spec 2 work\n");
      const log = (await run("git", ["-C", repo, "log", "--format=%s", "story/DUG-1"])).stdout;
      expect(log).toContain("review touch-up (human)");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
