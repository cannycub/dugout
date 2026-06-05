# The kiro draft result crosses stdout as a sentinel-delimited text block, not JSON

The draft adapter (#4, ADR-0007) runs headless kiro read-only and must get a `DraftOutcome` back
across a process boundary. kiro has **no write trust at all** (so it cannot hand a result back via a
written file — see ADR-0007/0008), which leaves exactly one channel: **stdout**. This ADR settles
the *wire format* on that channel. The first build used a JSON object; a live run proved that wrong.

**Decision: kiro emits its result as a sentinel-delimited plain-text block on stdout, not JSON.**

```
===DUGOUT BEGIN===
RESULT: drafted
===SPEC web===
# Spec: ...            (the full spec markdown, VERBATIM — no escaping)
===SPEC infra===
# Spec: ...
===DUGOUT END===
```

```
===DUGOUT BEGIN===
RESULT: needs-info
<free-text reason>
===DUGOUT END===
```

```
===DUGOUT BEGIN===
RESULT: needs-clarification
<one question per line>
===DUGOUT END===
```

Parsing rules (in the adapter, not kiro):
- Locate the `===DUGOUT BEGIN===` … `===DUGOUT END===` block; if several appear, **take the last**.
  This both skips the tool-activity narration `--no-interactive` streams *and* lets a re-think
  supersede an earlier block.
- The first line inside is `RESULT: drafted|needs-info|needs-clarification`. Anything else (unknown
  result, or no block at all) **throws loudly** — never silently accepted, so a malformed run is the
  developer's to re-run, not a guess fed downstream (invariant 1).
- `drafted`: split the body on `===SPEC <repo>===` header lines; each header's label is the repo,
  the text until the next header (or block end) is that spec's markdown, **verbatim**.
- `needs-info`: the body is the reason.
- `needs-clarification`: each non-empty line is one question. **The harness assigns ids
  (`q1, q2, …`) by order — the agent supplies none** (one less thing to get wrong; ids only thread
  answers back via `priorClarifications`).

### Why not JSON

The payload is a big pile of markdown (the specs) plus a sliver of routing metadata (the result
kind). JSON handles the metadata fine but forces every spec's markdown into a **JSON-escaped string**
— escaping newlines and quotes across a multi-k(sometimes multi-page) document. That escaping was
the single fragile point: a one-shot agent reliably gets the routing right but routinely emits a
spec string that breaks `JSON.parse` (an unescaped quote, a stray newline), failing the *whole*
outcome over a formatting slip in prose we were going to render as markdown anyway. The delimited
format inverts the trade: the structural part (which repo, which result) lives in dead-simple
sentinel lines the agent gets right, and the bulky markdown rides **verbatim** with no escaping to
get wrong. Robustness should sit where the data is hard, and the data is hard in the markdown.

Two facts about the installed CLI made JSON even less attractive:
- **There is no reliable structured-output flag.** `--output-format json` is rejected outright;
  `--format` exists but is for list commands only (`kiro-cli chat --help`). So we could not get a
  clean machine envelope around the response — we would be extracting a JSON object out of free text
  *and* depending on the agent to escape it. Plain-text extraction of a fenced block is the honest
  shape of the problem.
- `--no-interactive` **interleaves tool-activity narration with the response on stdout**, so *some*
  fence is required regardless of format. A sentinel block is that fence; with JSON we'd need the
  fence *and* the escaping.

## Considered Options

- **A single JSON object on stdout** (the prior design) — rejected: requires JSON-escaping large
  markdown strings, which the agent gets wrong often enough to fail otherwise-good drafts; and the
  narration interleaving means we'd be locating *and* parsing it anyway.
- **JSON behind a structured-output flag** (a clean `{ response, … }` envelope) — rejected: the
  installed CLI has no such flag for chat (above). Building on a flag that doesn't exist is how the
  first two attempts failed; we now treat chat output as free text by design.
- **kiro writes `result.json` to a writable specs dir** — already rejected (ADR-0007 history):
  read-only tool trust is categorical, not path-scoped, so granting write for the manifest would
  also permit writing through the source symlinks. No write trust → no file channel.
- **A fenced markdown code block (` ```json `)** — rejected: code fences are themselves unreliably
  emitted by LLMs and solve neither the escaping (if JSON inside) nor add anything a distinctive
  sentinel doesn't.

## Consequences

- `draft-methodology.ts` describes the block as the output contract (verbatim markdown, no ids).
  `kiro-draft-adapter.ts` parses it (`parseOutcome` → last block → `RESULT:` → spec/reason/question
  split); the `KiroResult` JSON type and JSON extraction are gone. `kiro-runner.ts` drops
  `--format json` and the JSON-envelope unwrap, adds `--wrap never`, and returns ANSI-stripped
  stdout directly for the adapter to scan.
- **Residual risk:** a spec's markdown could in principle contain a `===DUGOUT END===` /
  `===SPEC …===` line verbatim and corrupt parsing. The sentinel is deliberately distinctive to make
  this unlikely; it is accepted and documented rather than escaped (escaping is the cost we are
  removing). If it ever bites, a rarer sentinel or a length-prefixed section is the fix.
- **Follow-up (not required for a first green run):** retry once on parse failure — re-invoke kiro
  feeding back "your output didn't match the contract; emit exactly this format." Fits the one-shot
  re-assembly model (just another re-draft).
- Supersedes ADR-0007's paragraph describing the result as "JSON on stdout"; the rest of ADR-0007
  (the `DraftOutcome` tagged union, the read-only-trust rationale, the file-channel history) stands.
