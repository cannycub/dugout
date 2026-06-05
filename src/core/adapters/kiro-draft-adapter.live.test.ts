import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroDraftAdapter } from "./kiro-draft-adapter.js";
import { spawnKiroRunner } from "./kiro-runner.js";
import type { DeclaredRepo } from "../repo-scope.js";
import type { Ticket } from "../ports/jira.js";

/**
 * REAL kiro smoke test — runs the live path end-to-end against an actual `kiro-cli`. Opt-in only
 * (it spawns a real agent: slow, billable, needs kiro installed + authenticated). Run with:
 *
 *   KIRO_LIVE=1 npx vitest run src/core/adapters/kiro-draft-adapter.live.test.ts
 *
 * Override the binary if it isn't `kiro-cli` on PATH:  KIRO_BIN=/path/to/kiro KIRO_LIVE=1 ...
 *
 * It does NOT grade kiro's output — it proves the pipeline works: kiro spawns read-only, follows
 * the methodology's output contract (prints a sentinel-delimited DUGOUT block on stdout), and the
 * adapter parses it into a valid DraftOutcome. Inspect the logged outcome by eye.
 */
const live = process.env["KIRO_LIVE"] ? describe : describe.skip;

let workDir: string;
let repoDir: string;

const TICKET: Ticket = {
  key: "LIVE-1",
  title: "Add a greeting helper",
  description: [
    "AC: add a `greet(name)` function to greeter.ts that returns `Hello, <name>!`.",
    "AC: it trims surrounding whitespace from name.",
    "AC: an empty name returns `Hello, there!`.",
  ].join("\n"),
};

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "dugout-kiro-live-work-"));
  repoDir = await mkdtemp(join(tmpdir(), "dugout-kiro-live-repo-"));
  // A tiny real "repo" for kiro to read (read-only).
  await mkdir(join(repoDir, "greeter"), { recursive: true });
  await writeFile(
    join(repoDir, "greeter", "greeter.ts"),
    "// greeter module — add the greet() helper here.\nexport {};\n",
  );
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

live("KiroDraftAdapter — LIVE (real kiro)", () => {
  it("runs real kiro read-only and parses its result into a valid DraftOutcome", async () => {
    const declared: DeclaredRepo = {
      identity: { name: "greeter", remote: "git@example.com:acme/greeter.git" },
      clone: { status: "cloned", path: repoDir },
    };
    const adapter = new KiroDraftAdapter({
      workDir,
      runKiro: spawnKiroRunner({ bin: process.env["KIRO_BIN"] ?? "kiro-cli" }),
    });

    const outcome = await adapter.draft({ ticket: TICKET, repos: [declared] });

    // eslint-disable-next-line no-console
    console.log("\n[kiro-live] outcome:\n" + JSON.stringify(outcome, null, 2) + "\n");

    expect(["drafted", "needs-info", "needs-clarification"]).toContain(outcome.result);
    if (outcome.result === "drafted") {
      expect(outcome.specs.length).toBeGreaterThan(0);
      for (const spec of outcome.specs) {
        expect(spec.repo).toBe("greeter");
        expect(spec.markdown.length).toBeGreaterThan(0);
      }
    }
  }, 120_000); // real agent run — generous timeout
});
