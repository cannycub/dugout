import type { JiraPort, Ticket } from "../ports/jira.js";

export interface JiraReadConfig {
  /** e.g. "https://acme.atlassian.net". */
  baseUrl: string;
  /** The developer's Atlassian account email (the Basic-auth username). */
  email: string;
  /** The developer's personal API token (ADR-0005). Stored via safeStorage in main. */
  token: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

interface JiraIssue {
  key: string;
  fields: { summary: string; description?: string };
}

/**
 * Real Jira read adapter (ADR-0005): HTTP Basic with the developer's own API token, listing the
 * tickets assigned to them via JQL `assignee = currentUser()`. Read-only; Jira is a projection
 * (CONTEXT.md invariant 4). Tests inject `fetch`; no live Jira in tests (issue #3 AC).
 */
export class JiraReadAdapter implements JiraPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: JiraReadConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async listAssignedTickets(): Promise<Ticket[]> {
    const jql = encodeURIComponent("assignee = currentUser() ORDER BY updated DESC");
    const fields = "summary,description";
    const url = `${this.config.baseUrl}/rest/api/3/search?jql=${jql}&fields=${fields}`;
    const auth = Buffer.from(`${this.config.email}:${this.config.token}`).toString("base64");

    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Jira read failed: ${res.status}`);
    }
    const body = (await res.json()) as { issues: JiraIssue[] };
    return body.issues.map((i) => ({
      key: i.key,
      title: i.fields.summary,
      description: i.fields.description ?? "",
    }));
  }
}
