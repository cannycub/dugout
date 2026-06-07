import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroDraftAdapter, type KiroRun, type KiroInvocation } from "./kiro-draft-adapter.js";
import type { DeclaredRepo } from "../repo-scope.js";
import type { Ticket } from "../ports/jira.js";

let workDir: string;
let clonesDir: string;

const TICKET: Ticket = {
  key: "DUG-1",
  title: "Add widget endpoint",
  description: "AC: GET /widgets returns 200 with the list",
};

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "dugout-kiro-work-"));
  clonesDir = await mkdtemp(join(tmpdir(), "dugout-kiro-clones-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(clonesDir, { recursive: true, force: true });
});

/** A declared repo bound to a real on-disk clone holding one source file (to assert non-mutation). */
async function declaredClone(name: string): Promise<DeclaredRepo> {
  const path = join(clonesDir, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "code.ts"), `// ${name} source\n`);
  return {
    identity: { name, remote: `git@github.com:acme/${name}.git` },
    clone: { status: "cloned", path },
  };
}

/** A fake kiro that prints one drafted spec inside the DUGOUT block (markdown verbatim, no escaping). */
const drafts = (repo: string, markdown: string): KiroRun =>
  async () =>
    `===DUGOUT BEGIN===\nRESULT: drafted\n===SPEC ${repo}===\n${markdown}\n===DUGOUT END===`;

/** Captures the invocation, then prints a trivial drafted block so draft() resolves. */
function capturing(captured: { inv?: KiroInvocation }): KiroRun {
  return async (inv: KiroInvocation) => {
    captured.inv = inv;
    return "===DUGOUT BEGIN===\nRESULT: drafted\n===SPEC web===\n# Spec (web)\n===DUGOUT END===";
  };
}

describe("KiroDraftAdapter.draft", () => {
  it("returns a drafted fan-out parsed from the DUGOUT block kiro prints on stdout", async () => {
    const markdown = "# Spec: Add widget endpoint (web)\n\n## AC\n- [ ] returns 200";
    const adapter = new KiroDraftAdapter({ workDir, runKiro: drafts("web", markdown) });

    const outcome = await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });

    expect(outcome).toEqual({ result: "drafted", specs: [{ repo: "web", markdown }] });
  });

  it("splits a multi-repo fan-out on its ===SPEC <repo>=== headers, markdown verbatim", async () => {
    const stdout = [
      "===DUGOUT BEGIN===",
      "RESULT: drafted",
      "===SPEC web===",
      "# Spec (web)",
      "- [ ] returns 200",
      "===SPEC infra===",
      "# Spec (infra)",
      'resource "db" { engine = "pg" }',
      "===DUGOUT END===",
    ].join("\n");
    const adapter = new KiroDraftAdapter({ workDir, runKiro: async () => stdout });

    const outcome = await adapter.draft({
      ticket: TICKET,
      repos: [await declaredClone("web"), await declaredClone("infra")],
    });

    expect(outcome).toEqual({
      result: "drafted",
      specs: [
        { repo: "web", markdown: "# Spec (web)\n- [ ] returns 200" },
        { repo: "infra", markdown: '# Spec (infra)\nresource "db" { engine = "pg" }' },
      ],
    });
  });

  it("ignores kiro's tool-activity narration surrounding the DUGOUT block", async () => {
    // --no-interactive streams the read/grep tool log to stdout; the sentinel block is how we skip it.
    const stdout = [
      "Reading directory: /work/source ✓ Successfully read 3 entries",
      "Reading file: web/code.ts ✓",
      "===DUGOUT BEGIN===",
      "RESULT: drafted",
      "===SPEC web===",
      "# Spec",
      "===DUGOUT END===",
      "Done. (used 1,234 tokens)",
    ].join("\n");
    const adapter = new KiroDraftAdapter({ workDir, runKiro: async () => stdout });

    const outcome = await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });

    expect(outcome).toEqual({ result: "drafted", specs: [{ repo: "web", markdown: "# Spec" }] });
  });

  it("takes the LAST DUGOUT block when kiro emits more than one", async () => {
    const stdout = [
      "===DUGOUT BEGIN===",
      "RESULT: needs-info",
      "first thoughts, superseded",
      "===DUGOUT END===",
      "on reflection...",
      "===DUGOUT BEGIN===",
      "RESULT: drafted",
      "===SPEC web===",
      "# Final spec",
      "===DUGOUT END===",
    ].join("\n");
    const adapter = new KiroDraftAdapter({ workDir, runKiro: async () => stdout });

    const outcome = await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });

    expect(outcome).toEqual({ result: "drafted", specs: [{ repo: "web", markdown: "# Final spec" }] });
  });

  it("runs kiro read-only — trusting fs_read but never a write tool (invariant 2)", async () => {
    const captured: { inv?: KiroInvocation } = {};
    const adapter = new KiroDraftAdapter({ workDir, runKiro: capturing(captured) });

    await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });

    expect(captured.inv!.trustTools).toContain("fs_read");
    expect(captured.inv!.trustTools).not.toContain("fs_write");
  });

  it("lays the declared repos side-by-side under one source mount; the adapter does not mutate the clones", async () => {
    const captured: { inv?: KiroInvocation } = {};
    const adapter = new KiroDraftAdapter({ workDir, runKiro: capturing(captured) });

    await adapter.draft({
      ticket: TICKET,
      repos: [await declaredClone("web"), await declaredClone("infra")],
    });

    // Multi-repo layout: each declared repo sits side-by-side under the one source mount...
    const sourceDir = captured.inv!.sourceDir;
    expect((await readdir(sourceDir)).sort()).toEqual(["infra", "web"]);
    // ...and the mount actually exposes each clone's real source content.
    expect(await readFile(join(sourceDir, "web", "code.ts"), "utf8")).toBe("// web source\n");

    // The adapter does not write to source: the clones are byte-identical and gained no files.
    // (kiro itself has no write trust at all, so it cannot mutate them either.)
    expect(await readdir(join(clonesDir, "web"))).toEqual(["code.ts"]);
    expect(await readFile(join(clonesDir, "web", "code.ts"), "utf8")).toBe("// web source\n");
  });

  it("parses a needs-info kickback (block body is the reason) when the ticket is too thin to spec", async () => {
    const runKiro: KiroRun = async () =>
      "===DUGOUT BEGIN===\nRESULT: needs-info\nNo acceptance criteria to spec against.\n===DUGOUT END===";
    const adapter = new KiroDraftAdapter({ workDir, runKiro });

    const outcome = await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });

    expect(outcome).toEqual({
      result: "needs-info",
      reason: "No acceptance criteria to spec against.",
    });
  });

  it("parses needs-clarification questions, assigning ids by line order (the agent supplies none)", async () => {
    const runKiro: KiroRun = async () =>
      [
        "===DUGOUT BEGIN===",
        "RESULT: needs-clarification",
        "Soft-delete or hard-delete?",
        "Is pagination required?",
        "===DUGOUT END===",
      ].join("\n");
    const adapter = new KiroDraftAdapter({ workDir, runKiro });

    const outcome = await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });

    expect(outcome).toEqual({
      result: "needs-clarification",
      questions: [
        { id: "q1", prompt: "Soft-delete or hard-delete?" },
        { id: "q2", prompt: "Is pagination required?" },
      ],
    });
  });

  it("re-assembles prior clarification Q&A into the prompt so the one-shot re-draft has continuity", async () => {
    const captured: { inv?: KiroInvocation } = {};
    const adapter = new KiroDraftAdapter({ workDir, runKiro: capturing(captured) });

    await adapter.draft({
      ticket: TICKET,
      repos: [await declaredClone("web")],
      clarifications: [
        {
          answers: [
            { questionId: "q1", question: "Soft-delete or hard-delete?", answer: "Soft-delete only" },
          ],
        },
      ],
    });

    expect(captured.inv!.prompt).toContain("Soft-delete or hard-delete?");
    expect(captured.inv!.prompt).toContain("Soft-delete only");
  });

  it("carries the methodology + the delimited DUGOUT output contract kiro must follow", async () => {
    const captured: { inv?: KiroInvocation } = {};
    const adapter = new KiroDraftAdapter({ workDir, runKiro: capturing(captured) });

    await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });
    const prompt = captured.inv!.prompt;

    // The three result kinds kiro may emit, and the sentinel-delimited block it must wrap them in.
    expect(prompt).toContain("drafted");
    expect(prompt).toContain("needs-info");
    expect(prompt).toContain("needs-clarification");
    expect(prompt).toContain("===DUGOUT BEGIN===");
    expect(prompt).toContain("===DUGOUT END===");
  });

  it("rejects stdout with no DUGOUT block, surfacing a snippet for prompt tuning", async () => {
    const runKiro: KiroRun = async () => "I'd be happy to help! Here are some specs...";
    const adapter = new KiroDraftAdapter({ workDir, runKiro });

    await expect(
      adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] }),
    ).rejects.toThrow(/DUGOUT/);
  });

  it("rejects an unknown RESULT rather than silently accepting it (fail-safe: the dev re-runs)", async () => {
    const runKiro: KiroRun = async () =>
      "===DUGOUT BEGIN===\nRESULT: maybe-later\nhmm\n===DUGOUT END===";
    const adapter = new KiroDraftAdapter({ workDir, runKiro });

    await expect(
      adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] }),
    ).rejects.toThrow(/RESULT/i);
  });

  it("rejects a drafted block that emitted no ===SPEC <repo>=== sections", async () => {
    const runKiro: KiroRun = async () =>
      "===DUGOUT BEGIN===\nRESULT: drafted\n(forgot the specs)\n===DUGOUT END===";
    const adapter = new KiroDraftAdapter({ workDir, runKiro });

    await expect(
      adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] }),
    ).rejects.toThrow(/spec/i);
  });
});
