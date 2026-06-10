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
- **GitHub**: same swappable-port seam — the orchestrator + catalog share a `SwappableGitHub`.
  Saving org + token swaps in a fresh `GitHubAdapter` (org → `settings.json`, token → secrets);
  clearing the token reverts to the seed fake (the org is retained so re-entering the token
  reconnects).
- **kiro API key**: the executor adapters (`spawnKiroRunner`, `KiroExecuteAdapter`) take the key as
  a **getter** (`ApiKeySource = string | (() => string | undefined)`) and resolve it per run, so a
  save updates the host's `currentKiroKey` and the next draft/execute uses it. Clearing reverts to
  the startup fallback (legacy `kiro.cred` / env). A getter rather than a swappable port because the
  credential is a single value the adapter already re-reads each invocation, not a whole port.

**3. Secrets are write-only toward the renderer.** `SettingsView` carries presence
(`configured: boolean`) and non-secret fields (base URL, email, GitHub org) — never a token.
Mutation calls return the fresh view so the renderer needn't re-fetch.

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
  `saveJiraCredentials`/`clear…`, `saveGitHubConfig`/`clear…`, `saveKiroApiKey`/`clear…`),
  implemented by the Electron host (`settings-controls.ts`) and mirrored in-memory by the local API
  for tests/e2e.
- Env vars (`DUGOUT_WORKSPACE_ROOTS`, `DUGOUT_JIRA_*`, `DUGOUT_GITHUB_*`, `KIRO_API_KEY`) remain as
  stopgap fallbacks when the corresponding setting is empty — dev/CI environments keep working; the
  UI is the product path.
- **All four settings now propagate live** (workspace roots, Jira, GitHub, kiro) — no setting
  requires a restart. GitHub org joined `settings.json` as the first non-secret field beyond roots;
  the token moved onto the secrets store and the adapter is reconfigured at runtime via
  `SwappableGitHub`.
- The kiro key now lives in `secrets.enc` (read ahead of the legacy `kiro.cred` and the env
  stopgap) and is propagated live; the standalone `KiroCredentialStore` remains only as a
  read-time fallback until onboarding (#18) retires it.
