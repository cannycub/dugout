# Settings persistence: `settings.json` + one keyed `secrets.enc`; edits propagate to live ports without restart

User configuration (workspace roots, Jira credentials, a GitHub token) previously had no UI and no
durable home: roots came only from the `DUGOUT_WORKSPACE_ROOTS` env var (unreachable in a packaged
app — every catalog repo bound as "not-cloned"), Jira credentials had a store (ADR-0005) but no UI
to fill it, and each new secret implied a new bespoke store class. #17 adds the Settings surface;
this ADR records the persistence seam and the live-propagation pattern behind it.

## Decision

**1. Persistence splits by sensitivity — two files in `userData`, neither SQLite nor git.**
User settings are durable, machine-local config: not run-state (so never SQLite, which stays
rebuildable), not spec content (so never git, which stays canonical contract).

- **Non-secret config → `settings.json`** (plain JSON; `SettingsStore`). Workspace roots today;
  future preferences land here. Corrupt/missing degrades to defaults — settings can never crash
  startup.
- **Secrets → `secrets.enc`** — ONE `safeStorage`-encrypted blob holding a JSON map keyed by
  credential name (`SecretsStore`: `jira`, `github`, …). Adding a credential is a new key, not a
  new store class. Read = decrypt + parse the whole blob; write = merge a key, re-encrypt, rewrite.
  The ciphertext is the file; the encryption key lives in the OS keychain (macOS Keychain /
  Windows DPAPI / Linux libsecret), tied to the OS user — so the blob survives sessions by design,
  and legitimately fails to decrypt on a foreign machine / after a keychain reset, degrading to
  "not set" (re-prompt), never a crash. When `isEncryptionAvailable()` is false the UI says so and
  `set()` refuses — secrets are never persisted in plaintext. The legacy single-purpose
  `JiraCredentialStore` file is folded in once (`migrateLegacyJira`), never clobbering a newer
  value.

**2. Live propagation: a roots thunk + a swappable port — not orchestrator reconstruction.**
Adapters were wired once at `createOrchestrator`; edits must reach them without a restart. Two
narrow seams, chosen over re-wiring the orchestrator on save (which would tear down in-flight
state for a config change):

- **Workspace roots**: `GitWorkspace` accepts `roots: string[] | (() => string[])`. The host holds
  the current roots in a variable behind the thunk; `saveWorkspaceRoots` persists, updates the
  variable, and triggers `repoScope.rescan()` — clone bindings reflect the new roots immediately.
- **Jira**: the orchestrator holds a `SwappableJira` (a delegating `JiraPort`). Saving credentials
  swaps the inner adapter to a fresh `JiraReadAdapter`; clearing swaps back to the seed fake. The
  orchestrator never knows.

**3. Secrets are write-only toward the renderer.** `SettingsView` carries presence
(`configured: boolean`) and non-secret fields (base URL, email) — never a token. Mutation calls
return the fresh view so the renderer needn't re-fetch.

## Considered Options

- **One file for everything.** Rejected: roots in an encrypted blob are needlessly opaque (users
  may want to inspect/edit them), and credentials in plain JSON are unacceptable.
- **OS keychain entries per secret (no blob).** Rejected: Electron's `safeStorage` doesn't expose
  named keychain entries portably; one encrypted file keyed by name gets the same effect with one
  code path.
- **Re-create the orchestrator on settings save.** Rejected: heavy-handed (drops in-flight run
  state and event subscriptions for a config edit) and spreads "what must be rebuilt" knowledge
  into the settings path. The thunk + swappable-port seams are two lines each at the wiring site.
- **Plaintext fallback when encryption is unavailable.** Rejected outright; the UI explains
  instead (the env-var stopgaps still work for headless/dev environments).

## Consequences

- `DugoutApi` gains the settings surface (`getSettings`, `saveWorkspaceRoots`,
  `saveJiraCredentials`/`clear…`, `saveGitHubToken`/`clear…`), implemented by the Electron host
  (`settings-controls.ts`) and mirrored in-memory by the local API for tests/e2e.
- Env vars (`DUGOUT_WORKSPACE_ROOTS`, `DUGOUT_JIRA_*`) remain as stopgap fallbacks when the
  corresponding setting is empty — dev/CI environments keep working; the UI is the product path.
- The GitHub token is persisted but not yet consumed (the live GitHub adapter reads env at
  startup, #10); moving its construction onto the secrets store is the natural follow-up when the
  adapter needs runtime reconfiguration.
- The kiro API key (`KiroCredentialStore`) stays separate for now — it predates the keyed store
  and is owned by onboarding (#18); migrating it into `secrets.enc` is mechanical when #18 lands.
