# Jira read authenticates with the developer's personal API token, not OAuth

Dugout authenticates to Jira Cloud using the **developer's own Atlassian API token** (HTTP Basic:
`email:token`) against the REST API, with the token stored encrypted at rest via Electron
`safeStorage` (OS keychain). Assigned tickets are read with JQL `assignee = currentUser()`.

We reached for OAuth first, but Atlassian's OAuth 2.0 (3LO) is a **confidential client**: the token
exchange and every refresh require a `client_secret`, and there is no public-client / PKCE option
exposed in the developer console (feature request ECO-283 is still open). For a **local-first app
with no backend** (ADR-0001) distributed **one-per-developer**, there is nowhere safe to hold that
secret — a shared secret shipped in the binary is extractable, and the principled alternatives
(a token-exchange broker, or a per-developer OAuth app) either reintroduce the backend we decided
against or impose a poor per-developer setup. A personal API token sidesteps all of this: it ships
no secret, is one click for the developer to create, and **never expires** until revoked — which
serves the "authenticate once, don't keep redoing it" goal *better* than OAuth's rotating 90-day
refresh tokens.

The `JiraPort` boundary is unchanged: auth is an adapter concern, orchestration depends only on the
port, and tests run against `FakeJira`. We can swap to a real public-client OAuth flow the moment
Atlassian exposes PKCE, without touching orchestration.

## Considered Options

- **Shared OAuth app (one secret in the binary)** — rejected: ships a pseudo-secret, and refresh
  tokens still force full re-auth after 90 days of inactivity.
- **Per-developer OAuth app** — rejected: each developer would register their own OAuth app
  (Atlassian's own suggested workaround, acknowledged as poor UX).
- **Token-exchange broker backend** — rejected: reintroduces the backend ADR-0001 rules out.

## Consequences

- The token is the developer's own identity (satisfies issue #3 AC: "auth uses the developer's own
  Jira identity/token"); it is stored encrypted via `safeStorage`, never in run-state or git.
- Best-effort token refresh/rotation logic is not needed in v1 (tokens are long-lived).
- Revisit if/when Atlassian ships public-client PKCE (ECO-283), at which point a browser-consent
  OAuth flow becomes viable without a backend or a shipped secret.
