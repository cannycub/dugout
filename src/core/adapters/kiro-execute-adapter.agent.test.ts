import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as sandcastleRun } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { KiroExecuteAdapter } from "./kiro-execute-adapter.js";
import { kiroExecuteAgent } from "./kiro-agent-provider.js";

const sh = promisify(execFile);

/**
 * Tier 3 — execute-mode agent integration against REAL kiro in a REAL Sand Castle (Docker) sandbox
 * (CLAUDE.md testing pyramid; #7). Structurally excluded from `npm test` / CI (it's a
 * `*.agent.test.ts` file). Run with:
 *
 *   npm run test:agent          # needs KIRO_API_KEY, a reachable Docker daemon, and the image
 *
 * Prerequisites FAIL LOUDLY, never skip — a skip reports green and gives false confidence the agent
 * was tested. This is the only tier that proves the real pipeline end to end: kiro builds the spec
 * red→green inside the box, runs the suite twice, emits the folded <dugout-test-report>, and the
 * adapter parses stdout + grades it green (the baseline mechanism the Task 0 spike locked in — see
 * docs/superpowers/notes/2026-06-08-sandcastle-spike.md). Build the sandbox image first:
 *
 *   docker build -t dugout-sandbox:local sandbox/
 */
const KIRO_API_KEY = process.env["KIRO_API_KEY"];

describe("KiroExecuteAdapter (real kiro in a real Sand Castle sandbox)", () => {
  let clone: string;

  beforeAll(async () => {
    if (!KIRO_API_KEY) {
      throw new Error(
        "execute agent suite needs KIRO_API_KEY (kiro.dev/docs/cli/headless). Run via " +
          "`npm run test:agent` with the key, a running Docker daemon, and the dugout-sandbox image.",
      );
    }
    await sh("docker", ["info"]).catch(() => {
      throw new Error(
        "execute agent suite needs a reachable Docker daemon (real sandcastle.run()). Start Docker " +
          "and build the image: `docker build -t dugout-sandbox:local sandbox/`.",
      );
    });
    // A throwaway repo with one trivially-specifiable feature and an existing node:test runner.
    // realpath() is essential on macOS: tmpdir() is under /var (a symlink to /private/var), but git
    // records the worktree's gitdir as the canonical /private/var path. Sand Castle bind-mounts the
    // git dir at the path we hand it, so a non-canonical path leaves the in-container gitdir
    // reference unmounted ("not a git repository"). Pass the resolved path so the mounts line up.
    clone = await realpath(await mkdtemp(join(tmpdir(), "dugout-exec-")));
    await sh("git", ["init", "-q", "-b", "main"], { cwd: clone });
    await writeFile(
      join(clone, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "node --test" } }),
    );
    await sh("git", ["add", "-A"], { cwd: clone });
    await sh(
      "git",
      ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init"],
      { cwd: clone },
    );
  }, 120_000);

  it("builds a spec red→green and grades it green, producing a branch", async () => {
    const adapter = new KiroExecuteAdapter({
      run: sandcastleRun,
      // containerUid/Gid pinned to the image's baked `agent` uid (sandbox/Dockerfile), matching the
      // live wiring — Sand Castle's UID preflight otherwise expects the host uid and rejects.
      sandbox: docker({ imageName: "dugout-sandbox:local", containerUid: 1000, containerGid: 1000 }),
      makeAgent: (apiKey) => kiroExecuteAgent({ apiKey }),
      resolveClonePath: async () => clone,
      resolveBaseBranch: async () => "main",
    });
    const out = await adapter.execute({
      specId: "s1",
      repo: "x",
      markdown: "# Add sum(a,b)\nExport `sum` from index.js returning a+b. Add a passing node:test.",
      storyBranch: "dugout/T-1/x",
    });
    expect(out.result).toBe("green");
    expect(out.result === "green" && out.branch).toContain("s1");
  }, 600_000);
});
