import { mkdir, rm, symlink, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { assertNever } from "../exhaustive.js";
import { draftMethodology } from "./draft-methodology.js";
import type {
  DraftInput,
  DraftOutcome,
  DraftedSpec,
  ExecuteInput,
  ExecuteOutcome,
  ExecutorPort,
} from "../ports/executor.js";

/** One headless kiro invocation. The adapter assembles it; the runner shells out to the CLI. */
export interface KiroInvocation {
  /** The fully re-assembled prompt (ticket + repos + methodology + prior clarifications). */
  prompt: string;
  /** Read-only source mount: the declared repos laid out side-by-side. kiro's working dir. */
  sourceDir: string;
  /** Writable dir kiro must write `result.json` (+ referenced spec markdown files) into. */
  specsDir: string;
  /** Tool categories kiro may auto-approve. Draft mode is read-only — never includes `write`. */
  trustTools: readonly string[];
}

/**
 * The injected seam: run headless kiro for one invocation. Tests pass a fake; no real kiro runs in
 * tests. The real binding shells out read-only — roughly:
 *   kiro-cli chat --no-interactive --trust-tools=read,grep <prompt>   (cwd = sourceDir)
 * mapping {@link KiroInvocation.trustTools} to `--trust-tools` and never trusting `write`
 * (kiro.dev/docs/cli/headless/). It is not wired here — left to verify end-to-end against real kiro.
 */
export type KiroRun = (invocation: KiroInvocation) => Promise<void>;

export interface KiroDraftConfig {
  /** Working area under which the adapter lays out a per-ticket read-only source + writable specs. */
  workDir: string;
  /**
   * The kiro runner. Required (not optional with a throwing default) — there is no working default
   * until the real CLI spawn is wired, so omitting it is a compile error rather than a runtime one.
   */
  runKiro: KiroRun;
}

/** Read-only tool trust for draft mode: kiro may read/grep the source, never write it (invariant 2). */
const READ_ONLY_TRUST = ["read", "grep"] as const;

/** The manifest kiro writes to `specsDir/result.json`; spec markdown lives in referenced files. */
type KiroResultFile =
  | { result: "drafted"; specs: Array<{ repo: string; markdownFile: string }> }
  | { result: "needs-info"; reason: string }
  | { result: "needs-clarification"; questions: Array<{ id: string; prompt: string }> };

/**
 * Real draft-mode executor adapter (#4, ADR-0007): headless kiro against read-only checkouts with
 * no sandbox (invariant 2). The adapter lays the declared repos side-by-side under a read-only
 * source mount beside a writable specs dir, re-assembles the prompt each call (kiro is one-shot),
 * runs kiro read-only, and parses the result it wrote into a {@link DraftOutcome}. The kiro
 * invocation is injected so the whole adapter is tested through the port with the CLI faked.
 */
export class KiroDraftAdapter implements ExecutorPort {
  constructor(private readonly config: KiroDraftConfig) {}

  async draft(input: DraftInput): Promise<DraftOutcome> {
    const { sourceDir, specsDir } = await this.layout(input);
    await this.config.runKiro({
      prompt: assemblePrompt(input, specsDir),
      sourceDir,
      specsDir,
      trustTools: READ_ONLY_TRUST,
    });
    return this.parseResult(specsDir);
  }

  async execute(_input: ExecuteInput): Promise<ExecuteOutcome> {
    throw new Error("KiroDraftAdapter does not implement execute mode (a later slice)");
  }

  /**
   * Lay out a fresh per-ticket run dir: a read-only `source/` with each cloned declared repo
   * linked in side-by-side (multi-repo layout), and an empty writable `specs/`. The source is
   * linked, never copied into and never written, so the developer's clones are not mutated.
   */
  private async layout(input: DraftInput): Promise<{ sourceDir: string; specsDir: string }> {
    const runRoot = join(this.config.workDir, input.ticket.key);
    const sourceDir = join(runRoot, "source");
    const specsDir = join(runRoot, "specs");
    await rm(runRoot, { recursive: true, force: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    for (const repo of input.repos) {
      if (repo.clone.status !== "cloned") continue; // not-cloned repos have no local source to read
      // resolve() so a relative clone path isn't mis-interpreted relative to the symlink's own dir.
      await symlink(resolve(repo.clone.path), join(sourceDir, repo.identity.name));
    }
    return { sourceDir, specsDir };
  }

  /**
   * Read + validate the manifest kiro wrote, resolving spec markdown files into a DraftOutcome.
   * The manifest is untrusted one-shot-agent output, so every field is validated and the whole
   * thing fails loudly (never a raw parse/IO crash, never an out-of-tree read) on anything off.
   */
  private async parseResult(specsDir: string): Promise<DraftOutcome> {
    const manifest = parseManifest(await readFile(join(specsDir, "result.json"), "utf8"));
    switch (manifest.result) {
      case "drafted": {
        const specs: DraftedSpec[] = [];
        for (const s of manifest.specs) {
          const markdown = await readFile(specMarkdownPath(specsDir, s.markdownFile), "utf8");
          specs.push({ repo: s.repo, markdown });
        }
        return { result: "drafted", specs };
      }
      case "needs-info":
        return { result: "needs-info", reason: manifest.reason };
      case "needs-clarification":
        return { result: "needs-clarification", questions: manifest.questions };
      default:
        return assertNever(manifest, "parseResult: unsupported kiro result");
    }
  }
}

/** Parse + validate the untrusted manifest into a typed {@link KiroResultFile}, or throw clearly. */
function parseManifest(raw: string): KiroResultFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("kiro wrote an unparseable result.json");
  }
  if (!isRecord(parsed)) throw new Error("kiro result.json is not an object");

  switch (parsed.result) {
    case "drafted": {
      if (!Array.isArray(parsed.specs)) throw new Error("kiro drafted result has no specs array");
      const specs = parsed.specs.map((s) => {
        if (!isRecord(s) || typeof s.repo !== "string" || typeof s.markdownFile !== "string") {
          throw new Error("kiro drafted a spec missing a string repo/markdownFile");
        }
        return { repo: s.repo, markdownFile: s.markdownFile };
      });
      return { result: "drafted", specs };
    }
    case "needs-info":
      if (typeof parsed.reason !== "string") throw new Error("kiro needs-info has no reason");
      return { result: "needs-info", reason: parsed.reason };
    case "needs-clarification": {
      if (!Array.isArray(parsed.questions)) throw new Error("kiro needs-clarification has no questions");
      const questions = parsed.questions.map((q) => {
        if (!isRecord(q) || typeof q.id !== "string" || typeof q.prompt !== "string") {
          throw new Error("kiro asked a question missing a string id/prompt");
        }
        return { id: q.id, prompt: q.prompt };
      });
      return { result: "needs-clarification", questions };
    }
    default:
      throw new Error(`kiro returned an unsupported result: ${JSON.stringify(parsed.result)}`);
  }
}

/**
 * Resolve a spec's markdown file inside the writable specs dir, refusing any `markdownFile` that
 * escapes it (`..`, absolute path) — the manifest is untrusted, so a traversal must not read an
 * arbitrary file into canonical spec content.
 */
function specMarkdownPath(specsDir: string, markdownFile: string): string {
  const base = resolve(specsDir);
  const full = resolve(base, markdownFile);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`kiro spec markdownFile escapes the specs directory: ${markdownFile}`);
  }
  return full;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Re-assemble the one-shot prompt from scratch each call (kiro has no session memory): the
 * methodology, the ticket, the declared repos, and any prior clarification rounds.
 */
function assemblePrompt(input: DraftInput, specsDir: string): string {
  const repos = input.repos.map((r) => r.identity.name).join(", ");
  const lines = [
    draftMethodology(specsDir),
    "",
    `Ticket ${input.ticket.key}: ${input.ticket.title}`,
    "",
    input.ticket.description,
    "",
    `Declared repos in scope: ${repos}`,
  ];
  // kiro is one-shot with no session memory: fold every prior clarification round back in so a
  // re-draft sees the developer's earlier answers (continuity reconstructed by the harness).
  const rounds = input.priorClarifications ?? [];
  if (rounds.length > 0) {
    lines.push("", "Prior clarifications (already answered by the developer):");
    for (const round of rounds) {
      for (const { question, answer } of round.answers) {
        lines.push(`- Q: ${question}`, `  A: ${answer}`);
      }
    }
  }
  return lines.join("\n");
}

