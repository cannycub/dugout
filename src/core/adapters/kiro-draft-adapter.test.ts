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

/** A fake kiro that writes a drafted result (one spec markdown file + manifest) into the specs dir. */
function draftsOneSpec(repo: string, markdown: string): KiroRun {
  return async ({ specsDir }: KiroInvocation) => {
    await writeFile(join(specsDir, `${repo}.spec.md`), markdown);
    await writeFile(
      join(specsDir, "result.json"),
      JSON.stringify({
        result: "drafted",
        specs: [{ repo, markdownFile: `${repo}.spec.md` }],
      }),
    );
  };
}

/** Captures the invocation kiro was run with, then writes a trivial drafted result so draft() resolves. */
function capturing(captured: { inv?: KiroInvocation }): KiroRun {
  return async (inv: KiroInvocation) => {
    captured.inv = inv;
    await writeFile(join(inv.specsDir, "web.spec.md"), "# Spec (web)");
    await writeFile(
      join(inv.specsDir, "result.json"),
      JSON.stringify({ result: "drafted", specs: [{ repo: "web", markdownFile: "web.spec.md" }] }),
    );
  };
}

describe("KiroDraftAdapter.draft", () => {
  it("returns a drafted fan-out parsed from the result kiro wrote into the specs dir", async () => {
    const markdown = "# Spec: Add widget endpoint (web)\n\n## AC\n- [ ] returns 200";
    const adapter = new KiroDraftAdapter({ workDir, runKiro: draftsOneSpec("web", markdown) });

    const outcome = await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });

    expect(outcome).toEqual({
      result: "drafted",
      specs: [{ repo: "web", markdown }],
    });
  });

  it("runs kiro read-only — trusting read/grep tools but never write (invariant 2)", async () => {
    const captured: { inv?: KiroInvocation } = {};
    const adapter = new KiroDraftAdapter({ workDir, runKiro: capturing(captured) });

    await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });

    expect(captured.inv!.trustTools).toContain("read");
    expect(captured.inv!.trustTools).toContain("grep");
    expect(captured.inv!.trustTools).not.toContain("write");
  });

  it("lays the declared repos side-by-side under one source mount and never mutates the clones", async () => {
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

    // Source not mutated: the developer's clones are byte-identical and gained no files.
    expect(await readdir(join(clonesDir, "web"))).toEqual(["code.ts"]);
    expect(await readFile(join(clonesDir, "web", "code.ts"), "utf8")).toBe("// web source\n");
  });

  it("parses a needs-info kickback the agent wrote when the ticket is too thin to spec", async () => {
    const runKiro: KiroRun = async ({ specsDir }) => {
      await writeFile(
        join(specsDir, "result.json"),
        JSON.stringify({ result: "needs-info", reason: "No acceptance criteria to spec against." }),
      );
    };
    const adapter = new KiroDraftAdapter({ workDir, runKiro });

    const outcome = await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });

    expect(outcome).toEqual({
      result: "needs-info",
      reason: "No acceptance criteria to spec against.",
    });
  });

  it("parses needs-clarification questions the agent wrote before it would draft", async () => {
    const runKiro: KiroRun = async ({ specsDir }) => {
      await writeFile(
        join(specsDir, "result.json"),
        JSON.stringify({
          result: "needs-clarification",
          questions: [{ id: "q1", prompt: "Soft-delete or hard-delete?" }],
        }),
      );
    };
    const adapter = new KiroDraftAdapter({ workDir, runKiro });

    const outcome = await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });

    expect(outcome).toEqual({
      result: "needs-clarification",
      questions: [{ id: "q1", prompt: "Soft-delete or hard-delete?" }],
    });
  });

  it("re-assembles prior clarification Q&A into the prompt so the one-shot re-draft has continuity", async () => {
    const captured: { inv?: KiroInvocation } = {};
    const adapter = new KiroDraftAdapter({ workDir, runKiro: capturing(captured) });

    await adapter.draft({
      ticket: TICKET,
      repos: [await declaredClone("web")],
      priorClarifications: [
        {
          answers: [
            { questionId: "q1", question: "Soft-delete or hard-delete?", answer: "Soft-delete only" },
          ],
        },
      ],
    });

    // kiro has no session memory; the answer must be folded back into this call's prompt.
    expect(captured.inv!.prompt).toContain("Soft-delete or hard-delete?");
    expect(captured.inv!.prompt).toContain("Soft-delete only");
  });

  it("carries the methodology + the machine output contract kiro must follow", async () => {
    // The prompt PROSE (how to draft) is iterated in draft-methodology.ts and intentionally not
    // pinned here — only the machine contract kiro must satisfy is asserted, so rewording is free.
    const captured: { inv?: KiroInvocation } = {};
    const adapter = new KiroDraftAdapter({ workDir, runKiro: capturing(captured) });

    await adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] });
    const prompt = captured.inv!.prompt;

    // The three result outcomes kiro may emit, and the file it writes them to...
    expect(prompt).toContain("drafted");
    expect(prompt).toContain("needs-info");
    expect(prompt).toContain("needs-clarification");
    expect(prompt).toContain("result.json");
    // ...into the actual writable specs directory (the one-shot agent is told the real path).
    expect(prompt).toContain(captured.inv!.specsDir);
  });

  // The manifest is written by a one-shot LLM agent — untrusted output. The adapter must fail
  // loudly and clearly rather than leak a raw parse/IO crash or read an out-of-tree file.

  it("rejects a malformed result.json with a clear error", async () => {
    const runKiro: KiroRun = async ({ specsDir }) => {
      await writeFile(join(specsDir, "result.json"), "{ not: valid json");
    };
    const adapter = new KiroDraftAdapter({ workDir, runKiro });

    await expect(
      adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] }),
    ).rejects.toThrow(/kiro/i);
  });

  it("rejects a drafted manifest whose specs are missing or malformed", async () => {
    const runKiro: KiroRun = async ({ specsDir }) => {
      await writeFile(join(specsDir, "result.json"), JSON.stringify({ result: "drafted" }));
    };
    const adapter = new KiroDraftAdapter({ workDir, runKiro });

    await expect(
      adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] }),
    ).rejects.toThrow(/kiro/i);
  });

  it("rejects a spec markdownFile that escapes the specs directory (path traversal)", async () => {
    const runKiro: KiroRun = async ({ specsDir }) => {
      await writeFile(
        join(specsDir, "result.json"),
        JSON.stringify({
          result: "drafted",
          specs: [{ repo: "web", markdownFile: "../../../../etc/hosts" }],
        }),
      );
    };
    const adapter = new KiroDraftAdapter({ workDir, runKiro });

    await expect(
      adapter.draft({ ticket: TICKET, repos: [await declaredClone("web")] }),
    ).rejects.toThrow(/markdownFile/i);
  });
});
