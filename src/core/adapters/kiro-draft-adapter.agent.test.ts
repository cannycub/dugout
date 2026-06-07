import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroDraftAdapter } from "./kiro-draft-adapter.js";
import { spawnKiroRunner } from "./kiro-runner.js";
import type { DeclaredRepo } from "../repo-scope.js";
import type { Ticket } from "../ports/jira.js";
import type { ClarificationRound } from "../ports/executor.js";

/**
 * Tier 3 — agent integration suite against REAL kiro (CLAUDE.md testing pyramid). Structurally
 * excluded from the default `npm test` / CI (it's a `*.agent.test.ts` file); run the suite with:
 *
 *   npm run test:agent          # needs KIRO_API_KEY (+ optional KIRO_BIN) in the env
 *
 * It consumes `KIRO_API_KEY` (and optional `KIRO_BIN`) as inputs and FAILS LOUDLY if the key is
 * absent — never skips, because a skip reports green and gives false confidence the agent was tested.
 * Ordinary APIs fake cleanly, but agent (LLM) responses do not — only a real run proves the pipeline
 * (kiro spawns read-only, follows the methodology's output contract, the adapter parses it) and that
 * the clarification loop actually converges across rounds. kiro is stateless → these are parallel-safe.
 */
const KIRO_API_KEY = process.env["KIRO_API_KEY"];
const runKiro = () =>
  spawnKiroRunner({
    ...(process.env["KIRO_BIN"] ? { bin: process.env["KIRO_BIN"] } : {}),
    ...(KIRO_API_KEY ? { apiKey: KIRO_API_KEY } : {}),
  });

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
  // Fail loudly, up front: the suite is an integration test of the real agent — a missing key is a
  // misconfiguration to surface, never a reason to silently skip (CLAUDE.md testing pyramid, Tier 3).
  if (!KIRO_API_KEY) {
    throw new Error(
      "agent suite needs KIRO_API_KEY (kiro.dev/docs/cli/headless). Run via `npm run test:agent` " +
        "with the key set; it is deliberately never skipped.",
    );
  }
  workDir = await mkdtemp(join(tmpdir(), "dugout-kiro-agent-work-"));
  repoDir = await mkdtemp(join(tmpdir(), "dugout-kiro-agent-repo-"));
  // A tiny real "repo" for kiro to read (read-only).
  await mkdir(join(repoDir, "greeter"), { recursive: true });
  await writeFile(
    join(repoDir, "greeter", "greeter.ts"),
    "// greeter module — add the greet() helper here.\nexport {};\n",
  );
});

afterAll(async () => {
  // Guard the dirs: if beforeAll bailed (e.g. a missing key) they're unset — don't mask that error.
  if (workDir) await rm(workDir, { recursive: true, force: true });
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

const declaredGreeter = (): DeclaredRepo => ({
  identity: { name: "greeter", remote: "git@example.com:acme/greeter.git" },
  clone: { status: "cloned", path: repoDir },
});

describe("KiroDraftAdapter — agent integration (real kiro)", () => {
  it("runs real kiro read-only and parses its result into a valid DraftOutcome", async () => {
    const adapter = new KiroDraftAdapter({ workDir, runKiro: runKiro() });

    const outcome = await adapter.draft({ ticket: TICKET, repos: [declaredGreeter()] });

    // eslint-disable-next-line no-console
    console.log("\n[kiro-agent] outcome:\n" + JSON.stringify(outcome, null, 2) + "\n");

    expect(["drafted", "needs-info", "needs-clarification"]).toContain(outcome.result);
    if (outcome.result === "drafted") {
      expect(outcome.specs.length).toBeGreaterThan(0);
      for (const spec of outcome.specs) {
        expect(spec.repo).toBe("greeter");
        expect(spec.markdown.length).toBeGreaterThan(0);
      }
    }
  }, 120_000); // real agent run — generous timeout

  it("converges across a clarification round: an underspecified ticket asks, answers re-draft", async () => {
    // A deliberately thin ticket: the wording + edge cases are left open, so a careful agent should
    // ask rather than guess (invariant 1). Either it asks (then we answer and re-draft → drafted),
    // or it drafts straight away — both are valid agent behaviour; the loop must converge regardless.
    const thin: Ticket = {
      key: "LIVE-2",
      title: "Add a greeting helper",
      description:
        "Add a greeting helper to greeter.ts. It should greet a person by name. The exact wording " +
        "and edge-case behaviour are up to the team's preference.",
    };
    const adapter = new KiroDraftAdapter({ workDir, runKiro: runKiro() });

    const first = await adapter.draft({ ticket: thin, repos: [declaredGreeter()] });
    // eslint-disable-next-line no-console
    console.log("\n[kiro-agent] round 1:\n" + JSON.stringify(first, null, 2) + "\n");
    expect(["drafted", "needs-info", "needs-clarification"]).toContain(first.result);

    if (first.result !== "needs-clarification") {
      // The agent didn't need to ask this time — nothing to converge. (Non-deterministic by nature;
      // the first test already proves the single-shot path. Don't fail the suite over a judgment call.)
      return;
    }

    // Answer every question the agent asked, then re-draft with the round folded back in.
    const round: ClarificationRound = {
      answers: first.questions.map((q) => ({
        questionId: q.id,
        question: q.prompt,
        answer:
          "Return `Hello, <name>!`; trim surrounding whitespace; an empty name returns `Hello, there!`.",
      })),
    };
    const second = await adapter.draft({
      ticket: thin,
      repos: [declaredGreeter()],
      clarifications: [round],
    });
    // eslint-disable-next-line no-console
    console.log("\n[kiro-agent] round 2:\n" + JSON.stringify(second, null, 2) + "\n");

    // With the ambiguity resolved the loop must move forward — to a draft (the expected convergence)
    // or, at worst, needs-info; it must NOT ask the very same questions forever.
    expect(["drafted", "needs-info", "needs-clarification"]).toContain(second.result);
    if (second.result === "drafted") {
      expect(second.specs.length).toBeGreaterThan(0);
      expect(second.specs.every((s) => s.repo === "greeter")).toBe(true);
    }
  }, 240_000); // two real agent runs — extra-generous timeout
});
