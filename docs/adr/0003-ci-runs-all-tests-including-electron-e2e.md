# ADR 0003 — CI runs the full test suite, including real-Electron E2E, on Node 24

- **Status:** Accepted
- **Date:** 2026-06-04

## Context

The walking skeleton (ticket #2) ships with three test tiers: `typecheck`, Vitest unit tests
(the orchestration state machine + stores), and a Playwright **E2E** test that launches the
*real* built Electron app and drives the renderer through the fake-ticket lifecycle. The first
two run anywhere; the E2E test needs a display and the actual Electron binary. We want every PR
(against any branch) and every merge to `main` gated on all three, so regressions surface before
review rather than locally-only.

Standing up Electron E2E on GitHub's `ubuntu-latest` runner exposed three failure layers, the
first two expected and the third an upstream installer bug worth recording so we don't re-derive
it:

1. **Runtime floor.** `node:sqlite` (ADR-0002) is *flag-gated* on the Node 22.x/23.x lines and
   only available unflagged from **Node 24** (the version Electron 42 bundles). A `>=22.x` floor
   crashes the SQLite tests with `ERR_UNKNOWN_BUILTIN_MODULE`.
2. **System libraries.** A bare runner lacks the native libs Electron needs (`libnss3`,
   `libgbm`, `libasound2`, `libgtk-3`, …); without them the launch fails — and confusingly
   *surfaces* as a `path.txt ENOENT`, not a missing-library error.
3. **Electron's binary install races under Node 24.** Electron 42 ships **no postinstall**, so
   its binary is fetched lazily by `node_modules/electron/install.js` on first launch. That
   script downloads and checksum-validates the zip, then extracts it via a **floating promise**
   (`downloadArtifact().then(extractFile)` with no top-level `await`). Under Node 24 the process
   exits ~30 ms after the download is cached — *before* `extract-zip` finishes — leaving `dist/`
   empty and `path.txt` unwritten, so `electron.launch` fails with
   `ENOENT … node_modules/electron/path.txt`. Worse, Electron's bundled `extract-zip` returns a
   promise that **never settles** on the (checksum-valid) zip in this environment, so simply
   `await`-ing the existing machinery hangs the install instead.

## Decision

1. **One `CI` workflow runs `typecheck` → unit → E2E** on `ubuntu-latest`, on `pull_request`
   (no branch filter — all PRs) and `push` to `main`, with `concurrency` cancellation of
   superseded runs on the same ref.
2. **Pin CI (and `engines.node`) to Node 24.** Unit tests run under the same runtime family the
   app ships on, and `node:sqlite` works unflagged.
3. **Install Electron's system libraries via Playwright's maintained list** —
   `npx playwright install-deps chromium` (chromium's deps cover Electron) — rather than a
   hand-curated `apt` list.
4. **Fetch the Electron binary deterministically before E2E** with `scripts/ensure-electron.mjs`:
   keep `@electron/get` for the download (it works), but **extract with the synchronous system
   `unzip`** instead of the bundled `extract-zip` — there is no promise to leave unsettled. The
   script is a **no-op when the binary already exists**, so local dev (and machines without
   `unzip`) are untouched.
5. **Run E2E under a real `xvfb` screen** —
   `xvfb-run --auto-servernum --server-args="-screen 0 1280x960x24"` — not the bare default.

## Consequences

- All three tiers gate every PR and merge; the E2E test exercises the genuine Electron + IPC +
  renderer seam, not just the in-process API fake.
- We depend on `unzip` being present in CI (it is, on `ubuntu-latest`) and on `@electron/get`'s
  download path. If a future Electron release restores a working install, `ensure-electron.mjs`
  can be deleted and the step replaced by the stock installer — its no-op guard means it does no
  harm until then.
- The Node 24 pin is now expressed in three coupled places — `engines.node`, the CI
  `node-version`, and (implicitly) Electron 42's bundled runtime. Bumping any one is a
  deliberate, reviewed change.
- E2E adds ~50 s of wall-clock to CI (system libs + a one-time Electron download). Acceptable for
  a per-PR gate; revisit caching `~/.cache/electron` if it grows.
