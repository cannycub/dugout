import { parse as parseYaml } from "yaml";
import type { ReportFormat } from "./report-parser.js";

/** The kiro+toolchain sandbox image Dugout runs the build/suite in (distinct from the Sand Castle
 *  backend provider). Selected by Repo config; maps to a `build:sandbox` image target. */
export type Toolchain = "node" | "dotnet";

/**
 * A repo's committed `.dugout/config.yaml` (CONTEXT.md **Repo config**), parsed and validated. Lets
 * the harness run and grade the suite language-agnostically (ADR-0015 clause 4).
 */
export interface RepoConfig {
  /** Shell snippet that runs the full suite and prints a machine report to stdout. */
  testCommand: string;
  /** Discriminant selecting the host-side `ReportParser`. */
  reportFormat: ReportFormat;
  /** Selects the Dugout-owned kiro+toolchain sandbox image. */
  toolchain: Toolchain;
}

export const REPO_CONFIG_PATH = ".dugout/config.yaml";

/**
 * Parse and validate a `.dugout/config.yaml` body. Throws an **operational** error with a fix-it
 * message on any problem (ADR-0015 clause 4): a misconfigured repo must fail loudly, never grade
 * `red`. Pure — file I/O lives in {@link readRepoConfig}.
 */
export function parseRepoConfig(text: string): RepoConfig {
  const doc = parseYaml(text) as unknown;
  if (!doc || typeof doc !== "object") {
    throw new Error(`${REPO_CONFIG_PATH} is empty or not a YAML mapping; expected testCommand, reportFormat, toolchain.`);
  }
  const cfg = doc as Record<string, unknown>;
  const testCommand = cfg["testCommand"];
  if (typeof testCommand !== "string" || testCommand.trim() === "") {
    throw new Error(`${REPO_CONFIG_PATH}: \`testCommand\` is required (a shell snippet that runs the suite and prints a report to stdout).`);
  }
  const reportFormat = oneOf(cfg["reportFormat"], REPORT_FORMATS, "reportFormat");
  const toolchain = oneOf(cfg["toolchain"], TOOLCHAINS, "toolchain");
  return { testCommand, reportFormat, toolchain };
}

const REPORT_FORMATS = ["vitest-json", "trx"] as const;
const TOOLCHAINS = ["node", "dotnet"] as const;

/** Narrow `value` to one of `allowed`, or throw a fix-it naming the field and the valid set. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(
    `${REPO_CONFIG_PATH}: \`${field}\` must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)}).`,
  );
}

/** Host file reader; the adapter injects `fs.readFile` (utf-8). */
export interface RepoConfigFs {
  readFile(path: string): Promise<string>;
}

/**
 * Read and parse `<cwd>/.dugout/config.yaml` from the host clone. An absent file is an
 * **operational** error with a fix-it message — the developer must commit one; Dugout never
 * auto-generates it (ADR-0015 clause 4; CONTEXT.md Repo config).
 */
export async function readRepoConfig(cwd: string, fs: RepoConfigFs): Promise<RepoConfig> {
  const path = `${cwd}/${REPO_CONFIG_PATH}`;
  let text: string;
  try {
    text = await fs.readFile(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new Error(
        `${REPO_CONFIG_PATH} not found in this repo (looked at ${path}). Commit one declaring testCommand, reportFormat, and toolchain so Dugout can run and grade the suite.`,
      );
    }
    throw err;
  }
  return parseRepoConfig(text);
}
