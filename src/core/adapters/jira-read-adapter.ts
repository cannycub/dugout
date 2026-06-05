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

/** A node in Atlassian Document Format: `text` leaves carry content; others nest `content`. */
interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

interface JiraIssue {
  key: string;
  /** v3 returns `description` as an ADF object; v2/empty may be a string or null. */
  fields: { summary: string; description?: string | AdfNode | null };
}

/**
 * Flatten a Jira description to plain text. v3 sends ADF (a node tree); we concatenate its text
 * leaves, breaking a line per block node so multi-paragraph acceptance criteria stay readable.
 */
function descriptionToText(description: string | AdfNode | null | undefined): string {
  if (description == null) return "";
  if (typeof description === "string") return description;
  return adfToText(description).trim();
}

function adfToText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  const inner = (node.content ?? []).map(adfToText).join("");
  // Block-level nodes (paragraph, heading, list item, …) get a trailing newline; inline marks don't.
  const isBlock = node.type !== "text" && node.type !== undefined && node.type !== "doc";
  return isBlock ? `${inner}\n` : inner;
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
    const auth = Buffer.from(`${this.config.email}:${this.config.token}`).toString("base64");
    const pageSize = 100;

    const issues: JiraIssue[] = [];
    for (let startAt = 0; ; ) {
      const url = `${this.config.baseUrl}/rest/api/3/search?jql=${jql}&fields=${fields}&startAt=${startAt}&maxResults=${pageSize}`;
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Jira read failed: ${res.status}`);
      }
      const body = (await res.json()) as { issues: JiraIssue[]; total?: number };
      issues.push(...body.issues);
      startAt += body.issues.length;
      // Stop when the page is empty (no progress), single-page (no total), or all collected.
      if (body.issues.length === 0 || body.total === undefined || startAt >= body.total) break;
    }

    return issues.map((i) => ({
      key: i.key,
      title: i.fields.summary,
      description: descriptionToText(i.fields.description),
    }));
  }
}
