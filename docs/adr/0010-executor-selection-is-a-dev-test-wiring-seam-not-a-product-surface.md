# Executor selection is a dev/test wiring seam (env), not a product surface

Dugout's shipped intent is **always live**: drafting runs the real (kiro) agent, with the API key
sourced from onboarding (#18). The in-memory **fakes** exist for deterministic dev/test runs (the
testing pyramid's unit + e2e tiers), not for the developer to choose at runtime. The question this
ADR settles: **where does fakes-vs-live selection live, and what is its default?**

Originally a `SwitchableExecutor` let the developer flip drafting between fakes and live from a
topbar chip, persisting the choice in a `settings-store`. That scaffolding had **leaked into the
product** — it sat in the `DugoutApi`, the preload, and the UI — and, worse, it **drove the default
the wrong way**: `settings-store` defaulted to `fakes`, so the shipped app started on the *test*
executor and a real user had to manually flip to LIVE. The e2e's determinism depended on that
backwards default. The selector was a runtime control for a choice the product should make once, at
startup.

**Decision: executor selection is a startup-time wiring seam keyed on an environment variable, with
no runtime toggle and no product UI.**

- **Shipped app (env unset) → live** drafting (kiro). This is the product default.
- **`DUGOUT_EXECUTOR=fakes` → fakes**, selected once at startup — consistent with the existing
  `DUGOUT_SEED_CLARIFY` / `DUGOUT_JIRA_*` dev/test env stopgaps. The e2e launches set it explicitly.
- **`execute` is always fake for now** — there is no sandbox/execute adapter yet (later slice, #7).
  "Always live" affects **drafting only**.
- `SwitchableExecutor` is **deleted**: its sole purpose was *runtime* switching for the UI toggle,
  and with the mode fixed at startup there is nothing to switch. The Electron host inlines the
  composition (`draft: (fakes ? fake : kiro).draft; execute: fake.execute`); `local-dugout-api`
  uses the `FakeExecutor` directly.
- The product surface is **stripped**: `getExecutorMode` / `setExecutorMode` (and their IPC
  channels and preload bindings) and the `ExecutorMode` type leave the `DugoutApi`; the
  `ExecutorModeSelector` topbar chip is **removed entirely** (no passive badge); `executorMode`
  leaves `settings-store`, which — left empty — is removed along with its test until #17
  reintroduces real settings.

This removes a shallow module justified only by a requirement we are deleting, removes a dev/test
concern from the product `DugoutApi` and UI, and fixes a real product bug: the default flips from
fakes → live.

## Considered Options

- **Keep `SwitchableExecutor`, just invert the default to `live`** — rejected: it leaves a runtime
  switching mechanism (and its `DugoutApi` / UI surface) in the product for a choice the product
  should make once at startup. The leak, not only the default, is the problem.
- **Keep a passive read-only "LIVE/FAKES" badge in the topbar** — rejected: a status badge for a
  fixed-at-startup wiring detail is noise to the head coach and re-opens the door to a control.
  Drafting being live is the assumed normal; the dev/test seam is invisible to users by design.
- **A build-time flag (separate dev build) instead of a runtime env var** — rejected: the e2e and
  local dev runs need to select fakes against the *same* built app, matching how
  `DUGOUT_SEED_CLARIFY` / `DUGOUT_JIRA_*` already work; a separate build is heavier and divergent.

## Consequences

- Enforces the standing `always-live-executor` decision (the shipped app is always live; the
  FAKES/LIVE selector was dev/test scaffolding, not a product surface).
- The e2e (`app.spec.ts`) stops leaning on a `fakes` default and sets `DUGOUT_EXECUTOR=fakes` on
  every launch; a missing key no longer matters to the e2e because it never reaches live drafting.
- `settings-store` is gone for now; #17 (settings UI) reintroduces persisted settings when there is
  real, non-secret config to hold. Secrets remain in safeStorage (ADR-0005).
- Re-introducing a runtime executor toggle (or surfacing the mode in the `DugoutApi`/UI) requires a
  new ADR superseding this one.
