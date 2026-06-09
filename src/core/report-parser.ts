/**
 * Host-side reporter parsers (ADR-0015 clause 5). The command-runner agent runs the repo's suite
 * in the sandbox and prints a machine report to stdout; a `ReportParser` (selected per the Repo
 * config's `reportFormat`) turns that stdout into the failing-id list `gradeExecute` diffs.
 *
 * `failingIds` is pure and total over a *valid* report: it returns every failing test's stable id
 * (`[]` when the suite is all-green). Stdout with **no parseable report** is an operational error
 * (bad command, missing toolchain) and **throws** — never an empty list, which the harness would
 * misgrade as green (ADR-0015 clause 6).
 */
export type ReportFormat = "vitest-json" | "trx";

export interface ReportParser {
  /** Stable ids of every failing test in `stdout`. Throws if no parseable report is present. */
  failingIds(stdout: string): string[];
}

/**
 * Extract the report-shaped JSON object embedded in `stdout`. The command-runner prints the report
 * to stdout, but the wrapper's command echo and an `exit 0` line can bracket it — so we scan for the
 * first top-level `{…}` that parses *and* carries a `testResults` array, rather than assuming stdout
 * is pure JSON. Throws when none is found (operational — the suite did not report).
 */
function extractVitestDoc(stdout: string): { testResults: VitestFile[]; success: boolean | undefined } {
  for (let i = stdout.indexOf("{"); i !== -1; i = stdout.indexOf("{", i + 1)) {
    const candidate = sliceBalancedObject(stdout, i);
    if (!candidate) continue;
    try {
      const doc = JSON.parse(candidate) as { testResults?: VitestFile[]; success?: boolean };
      if (Array.isArray(doc.testResults)) return { testResults: doc.testResults, success: doc.success };
    } catch {
      // Not the report object — keep scanning later `{`s.
    }
  }
  throw new Error("no parseable vitest-json report found in the command-runner's stdout");
}

/** The substring from `start` to its matching `}`, brace-counting through strings/escapes. */
function sliceBalancedObject(s: string, start: number): string | undefined {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return undefined;
}

interface VitestFile {
  name: string;
  assertionResults?: Array<{ fullName: string; status: string }>;
}

/** vitest `--reporter=json`: stable id = `file + full test name` (both durable across runs). */
const vitestJsonParser: ReportParser = {
  failingIds(stdout) {
    const doc = extractVitestDoc(stdout);
    const ids = doc.testResults.flatMap((file) =>
      (file.assertionResults ?? [])
        .filter((a) => a.status === "failed")
        .map((a) => `${file.name} > ${a.fullName}`),
    );
    // A parseable report can still represent a run that never validly completed: vitest sets
    // `success: false` on a compile/collection/setup error and emits an EMPTY failing set (no test
    // ran). Returning [] there would grade green though the suite never executed — the exact
    // false-green invariant 8 forbids. Treat it as operational (ADR-0015 clause 6): the harness could
    // not observe a clean run. A `success: false` WITH named failures is a normal red and passes through.
    if (ids.length === 0 && doc.success === false) {
      throw new Error(
        "vitest reported success=false but named no failing test — the suite did not validly complete " +
          "(likely a compile/collection error). This is an operational failure, not a green grade.",
      );
    }
    return ids;
  },
};

/**
 * vstest `UnitTestResult` outcomes that mean the test did not pass: an assertion failure (`Failed`),
 * an unhandled exception (`Error`), a hang (`Timeout`), or a cancelled run (`Aborted`). `Passed`,
 * `NotExecuted` (skipped), and `Inconclusive` are NOT counted — only `NotExecuted` would ever appear
 * for a green-able run, and a skipped test is not a failure.
 */
const FAILING_OUTCOMES = new Set(["Failed", "Error", "Timeout", "Aborted"]);

/** A `name="value"` (or single-quoted) attribute read off an element's opening tag. */
function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}=("([^"]*)"|'([^']*)')`))?.slice(2).find((v) => v !== undefined);
}

/**
 * dotnet/vstest TRX. Stable id = the **fully-qualified test method name** (`TestMethod.className`
 * stripped of its assembly suffix, joined to `TestMethod.name`) — NOT the per-run `UnitTestResult`
 * `testId` GUID, which is freshly minted each run and would make the baseline⊆after diff meaningless
 * (ADR-0015 clause 5). `UnitTestResult` carries the outcome keyed by `testId`; `TestDefinitions`
 * maps that `testId` to its `TestMethod`, so we join the two.
 */
const trxParser: ReportParser = {
  failingIds(stdout) {
    if (!/<TestRun[\s>]/.test(stdout)) {
      throw new Error("no parseable trx report found in the command-runner's stdout");
    }
    // testId -> fully-qualified method name, from <UnitTest id="…"><TestMethod className name/></…>.
    const fqnById = new Map<string, string>();
    for (const ut of stdout.matchAll(/<UnitTest\b[^>]*>([\s\S]*?)<\/UnitTest>/g)) {
      const id = attr(ut[0]!, "id");
      const method = ut[1]!.match(/<TestMethod\b[^>]*>|<TestMethod\b[^/]*\/>/)?.[0];
      if (!id || !method) continue;
      const className = attr(method, "className")?.split(",")[0]!.trim();
      const name = attr(method, "name");
      if (className && name) fqnById.set(id, `${className}.${name}`);
    }
    const failing: string[] = [];
    for (const r of stdout.matchAll(/<UnitTestResult\b[^>]*\/?>/g)) {
      if (!FAILING_OUTCOMES.has(attr(r[0]!, "outcome") ?? "")) continue;
      const fqn = fqnById.get(attr(r[0]!, "testId") ?? "");
      if (fqn) failing.push(fqn);
    }
    return failing;
  },
};

const PARSERS: Record<ReportFormat, ReportParser> = {
  "vitest-json": vitestJsonParser,
  trx: trxParser,
};

export function reportParserFor(format: ReportFormat): ReportParser {
  const parser = PARSERS[format];
  if (!parser) throw new Error(`unknown report format "${format}" (expected one of: ${Object.keys(PARSERS).join(", ")})`);
  return parser;
}
