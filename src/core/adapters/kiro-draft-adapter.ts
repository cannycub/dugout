import { mkdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { draftMethodology } from "./draft-methodology.js";
import type {
  DraftedSpec,
  DraftInput,
  DraftOutcome,
  ExecuteInput,
  ExecuteOutcome,
  ExecutorPort,
} from "../ports/executor.js";

/** One headless kiro invocation. The adapter assembles it; the runner shells out to the CLI. */
export interface KiroInvocation {
  /** The fully re-assembled prompt (ticket + repos + methodology + prior clarifications). */
  prompt: string;
  /**
   * Source mount: the declared repos symlinked side-by-side; kiro's working dir. kiro is granted
   * only read/grep tool trust ({@link trustTools}), never `write`, so it cannot write anywhere —
   * not the source, not anything. That total absence of write capability is what keeps the
   * developer's clones unmutated; the result comes back on stdout, never via a written file.
   */
  sourceDir: string;
  /** Tool categories kiro may auto-approve. Draft mode is read-only — never includes `write`. */
  trustTools: readonly string[];
}

/**
 * The injected seam: run headless kiro for one invocation and return its (ANSI-stripped) stdout.
 * Tests pass a fake; no real kiro runs in tests. The real binding shells out read-only —
 *   kiro-cli chat --no-interactive --wrap never --trust-tools=fs_read <prompt>   (cwd = sourceDir)
 * mapping {@link KiroInvocation.trustTools} to `--trust-tools` and never trusting a write tool. kiro
 * has no write capability, so it cannot hand its result back via a file — it prints it to stdout,
 * wrapped in the sentinel-delimited DUGOUT block the adapter locates and parses (the surrounding
 * tool-activity narration `--no-interactive` streams is ignored).
 */
export type KiroRun = (invocation: KiroInvocation) => Promise<string>;

export interface KiroDraftConfig {
  /** Working area under which the adapter lays out a per-ticket read-only source mount. */
  workDir: string;
  /**
   * The kiro runner. Required (not optional with a throwing default) — there is no working default
   * until the real CLI spawn is wired, so omitting it is a compile error rather than a runtime one.
   */
  runKiro: KiroRun;
}

/**
 * Read-only tool trust for draft mode: kiro may read the source (`fs_read` — its search mode also
 * covers grep), never write (invariant 2). These are the installed CLI's real tool identifiers
 * (`kiro-cli chat --help` lists `fs_read`/`fs_write`); an unknown name would be silently untrusted,
 * which under `--no-interactive` leaves kiro unable to read at all.
 */
const READ_ONLY_TRUST = ["fs_read"] as const;

/** Sentinel that brackets kiro's result block on stdout, fencing it off from the tool-activity
 * narration `--no-interactive` streams. Distinctive enough that spec markdown is very unlikely to
 * contain it verbatim (the small residual risk: a spec that literally quotes these lines). */
const BLOCK_BEGIN = "===DUGOUT BEGIN===";
const BLOCK_END = "===DUGOUT END===";

/**
 * Real draft-mode executor adapter (#4, ADR-0007): headless kiro, no sandbox (invariant 2). The
 * adapter symlinks the declared repos side-by-side under a read-only source mount, re-assembles the
 * prompt each call (kiro is one-shot), runs kiro with read-only tool trust (fs_read, never a write
 * tool — so it has no write capability at all and the clones can't be mutated), and parses the
 * sentinel-delimited DUGOUT block kiro prints on stdout into a {@link DraftOutcome}. The kiro
 * invocation is injected so the whole adapter is tested through the port with the CLI faked.
 */
export class KiroDraftAdapter implements ExecutorPort {
  constructor(private readonly config: KiroDraftConfig) {}

  async draft(input: DraftInput): Promise<DraftOutcome> {
    const sourceDir = await this.layout(input);
    const stdout = await this.config.runKiro({
      prompt: assemblePrompt(input),
      sourceDir,
      trustTools: READ_ONLY_TRUST,
    });
    return parseOutcome(stdout);
  }

  async execute(_input: ExecuteInput): Promise<ExecuteOutcome> {
    throw new Error("KiroDraftAdapter does not implement execute mode (a later slice)");
  }

  /**
   * Lay out a fresh per-ticket `source/` with each cloned declared repo symlinked in side-by-side
   * (multi-repo layout). The adapter never writes to it, and kiro has no write trust, so the
   * developer's clones are not mutated.
   */
  private async layout(input: DraftInput): Promise<string> {
    const sourceDir = join(this.config.workDir, input.ticket.key, "source");
    await rm(join(this.config.workDir, input.ticket.key), { recursive: true, force: true });
    await mkdir(sourceDir, { recursive: true });
    for (const repo of input.repos) {
      if (repo.clone.status !== "cloned") continue; // not-cloned repos have no local source to read
      // resolve() so a relative clone path isn't mis-interpreted relative to the symlink's own dir.
      await symlink(resolve(repo.clone.path), join(sourceDir, repo.identity.name));
    }
    return sourceDir;
  }
}

/**
 * Parse kiro's stdout into a {@link DraftOutcome}, or throw clearly. The output is untrusted
 * one-shot-agent text interleaved with tool-activity narration, so we first locate the
 * sentinel-delimited DUGOUT block (last one wins, so a superseded earlier block is ignored), then
 * read its `RESULT:` discriminant. A missing block or unknown result throws with a snippet of the
 * raw output — fail-safe by design (never silently accept; the developer re-runs) and so the
 * methodology prompt can be tuned.
 */
function parseOutcome(stdout: string): DraftOutcome {
  const block = lastBlock(stdout);
  if (block === null) {
    throw new Error(
      `kiro output had no ${BLOCK_BEGIN} … ${BLOCK_END} block. First 500 chars of stdout:\n${stdout.slice(0, 500)}`,
    );
  }

  const newline = block.indexOf("\n");
  const firstLine = (newline === -1 ? block : block.slice(0, newline)).trim();
  const body = newline === -1 ? "" : block.slice(newline + 1);

  const result = firstLine.match(/^RESULT:\s*(.+)$/)?.[1]?.trim();
  switch (result) {
    case "drafted":
      return { result: "drafted", specs: parseSpecs(body) };
    case "needs-info": {
      const reason = body.trim();
      if (!reason) throw new Error("kiro returned needs-info with no reason");
      return { result: "needs-info", reason };
    }
    case "needs-clarification": {
      const questions = body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        // The harness assigns ids by order — the agent supplies none (one less thing to get right);
        // ids only thread answers back via clarifications.
        .map((prompt, i) => ({ id: `q${i + 1}`, prompt }));
      if (questions.length === 0) throw new Error("kiro returned needs-clarification with no questions");
      return { result: "needs-clarification", questions };
    }
    default:
      throw new Error(
        `kiro block's first line was not a known "RESULT: drafted|needs-info|needs-clarification": ${JSON.stringify(firstLine)}`,
      );
  }
}

/** The content between the last {@link BLOCK_BEGIN}…{@link BLOCK_END} pair, or null if none. */
function lastBlock(stdout: string): string | null {
  // Tolerate trailing whitespace after a sentinel line — LLM output is rarely byte-exact.
  const re = new RegExp(`${BLOCK_BEGIN}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?[ \\t]*${BLOCK_END}`, "g");
  const blocks = [...stdout.matchAll(re)];
  return blocks.length === 0 ? null : blocks[blocks.length - 1]![1]!;
}

/**
 * Split a drafted block's body on its `===SPEC <repo>===` headers: each header's label is the repo,
 * the text until the next header (or the block's end) is that spec's markdown, verbatim and trimmed.
 * An optional `[review-recommended]` suffix on the header is the agent's perf/concurrency
 * call-out (#6) — a pre-flight default the developer confirms, never a decision.
 */
function parseSpecs(body: string): DraftedSpec[] {
  const headerRe = /^===SPEC[ \t]+(.+?)[ \t]*===[ \t]*$/gm;
  const headers = [...body.matchAll(headerRe)];
  if (headers.length === 0) {
    throw new Error("kiro returned a drafted result with no ===SPEC <repo>=== sections");
  }
  return headers.map((header, i) => {
    let label = header[1]!.trim();
    const reviewRecommended = /\[review-recommended\]$/i.test(label);
    if (reviewRecommended) label = label.replace(/\s*\[review-recommended\]$/i, "").trim();
    const start = header.index + header[0].length;
    const end = i + 1 < headers.length ? headers[i + 1]!.index : body.length;
    const markdown = body.slice(start, end).trim();
    if (!markdown) throw new Error(`kiro drafted a spec for "${label}" with empty markdown`);
    return { repo: label, markdown, ...(reviewRecommended ? { reviewRecommended: true } : {}) };
  });
}

/**
 * Re-assemble the one-shot prompt from scratch each call (kiro has no session memory): the
 * methodology, the ticket, the declared repos, and any prior clarification rounds.
 */
function assemblePrompt(input: DraftInput): string {
  const repos = input.repos.map((r) => r.identity.name).join(", ");
  const lines = [
    draftMethodology(),
    "",
    `Ticket ${input.ticket.key}: ${input.ticket.title}`,
    "",
    input.ticket.description,
    "",
    `Declared repos in scope: ${repos}`,
  ];
  // kiro is one-shot with no session memory: fold every prior clarification round back in so a
  // re-draft sees the developer's earlier answers (continuity reconstructed by the harness).
  const rounds = input.clarifications ?? [];
  if (rounds.length > 0) {
    lines.push("", "Prior clarifications (already answered by the developer):");
    for (const round of rounds) {
      for (const { question, answer } of round.answers) {
        lines.push(`- Q: ${question}`, `  A: ${answer}`);
      }
    }
  }
  // Revision mode (#5): the PR-review-style loop. kiro is one-shot, so the harness hands it the
  // CURRENT canonical set plus this round's feedback and the revision rules.
  if (input.revision) {
    lines.push(
      "",
      "REVISION MODE — you already drafted this set; the developer is reviewing it like a pull",
      "request and has feedback. Revise the set and emit the COMPLETE revised set in the usual",
      "output contract. Rules:",
      "- Revise ALL parts affected by the feedback so the set stays internally consistent (an AC",
      "  change updates the test plan and the fan-out).",
      "- Preserve unaffected text verbatim — do not rewrite for style.",
      "- The developer's own edits are authoritative: never override them; if one introduced an",
      "  inconsistency, FLAG it in the affected spec under a 'Consistency flags' note instead.",
      "",
      "THE DEVELOPER'S FEEDBACK:",
      input.revision.feedback,
      "",
      "CURRENT SPEC SET (the draft under review):",
    );
    for (const spec of input.revision.specs) {
      lines.push(`--- spec for repo ${spec.repo} ---`, spec.markdown);
    }
  }
  return lines.join("\n");
}
