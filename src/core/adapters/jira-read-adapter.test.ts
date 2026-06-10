import { describe, it, expect } from "vitest";
import { JiraReadAdapter } from "./jira-read-adapter.js";

function fakeFetch(captured: { url?: string | undefined; auth?: string | undefined }): typeof globalThis.fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured.url = String(url);
    captured.auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        issues: [
          { key: "DUG-7", fields: { summary: "Add timeline", description: "AC: returns 200" } },
        ],
      }),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
}

describe("JiraReadAdapter.listAssignedTickets", () => {
  it("queries assignee=currentUser() and maps issues to tickets", async () => {
    const captured: { url?: string | undefined; auth?: string | undefined } = {};
    const jira = new JiraReadAdapter({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      token: "tok",
      fetch: fakeFetch(captured),
    });

    const tickets = await jira.listAssignedTickets();

    expect(tickets).toEqual([
      { key: "DUG-7", title: "Add timeline", description: "AC: returns 200" },
    ]);
    expect(decodeURIComponent(captured.url!)).toContain("assignee = currentUser()");
    // Enhanced JQL search endpoint — the legacy /search was removed (410 Gone) on Jira Cloud.
    expect(captured.url).toContain("/rest/api/3/search/jql");
    expect(captured.url).not.toContain("/search?");
    expect(captured.auth).toBe(`Basic ${Buffer.from("dev@acme.com:tok").toString("base64")}`);
  });

  it("flattens an ADF (rich-text) description to plain text", async () => {
    // Jira REST v3 returns `description` as an Atlassian Document Format object, not a string.
    const adf = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "AC: returns 200" }] },
        { type: "paragraph", content: [{ type: "text", text: "and logs the request" }] },
      ],
    };
    const jira = new JiraReadAdapter({
      baseUrl: "https://acme.atlassian.net",
      email: "d@a.com",
      token: "tok",
      fetch: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ issues: [{ key: "DUG-9", fields: { summary: "Rich", description: adf } }] }),
        }) as unknown as Response) as typeof globalThis.fetch,
    });

    const tickets = await jira.listAssignedTickets();
    expect(tickets[0]!.description).toBe("AC: returns 200\nand logs the request");
  });

  it("pages through all assigned tickets via nextPageToken (the new API drops startAt/total)", async () => {
    // Enhanced JQL search paginates by an opaque token and signals the end with isLast — there is
    // no startAt offset and no total count to drive a loop off of.
    const pages: Record<string, { issues: unknown[]; nextPageToken?: string; isLast: boolean }> = {
      "": {
        issues: [
          { key: "DUG-1", fields: { summary: "one" } },
          { key: "DUG-2", fields: { summary: "two" } },
        ],
        nextPageToken: "tok-2",
        isLast: false,
      },
      "tok-2": { issues: [{ key: "DUG-3", fields: { summary: "three" } }], isLast: true },
    };
    const seenTokens: (string | null)[] = [];
    const jira = new JiraReadAdapter({
      baseUrl: "https://acme.atlassian.net",
      email: "d@a.com",
      token: "tok",
      fetch: (async (url: Parameters<typeof fetch>[0]) => {
        const u = new URL(String(url));
        expect(u.pathname).toBe("/rest/api/3/search/jql"); // never the removed endpoint
        expect(u.searchParams.get("startAt")).toBeNull(); // offset pagination is gone
        const token = u.searchParams.get("nextPageToken");
        seenTokens.push(token);
        return { ok: true, status: 200, json: async () => pages[token ?? ""] } as unknown as Response;
      }) as typeof globalThis.fetch,
    });

    const tickets = await jira.listAssignedTickets();
    expect(tickets.map((t) => t.key)).toEqual(["DUG-1", "DUG-2", "DUG-3"]);
    expect(seenTokens).toEqual([null, "tok-2"]); // first page sends no token; second uses the returned one
  });

  it("throws a useful error on a non-ok response", async () => {
    const jira = new JiraReadAdapter({
      baseUrl: "https://acme.atlassian.net",
      email: "d@a.com",
      token: "bad",
      fetch: async () =>
        ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response,
    });
    await expect(jira.listAssignedTickets()).rejects.toThrow(/401/);
  });
});

/** A scripted fetch for the write paths: records every call, replies per URL+method. */
function writeFetch() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const impl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (u.endsWith("/transitions") && method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ transitions: [{ id: "31", name: "In Progress" }, { id: "41", name: "Done" }] }),
      } as unknown as Response;
    }
    if (u.endsWith("/rest/api/3/issue") && method === "POST") {
      return { ok: true, status: 201, json: async () => ({ key: "DUG-99" }) } as unknown as Response;
    }
    return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { calls, impl };
}

function writeAdapter(impl: typeof globalThis.fetch) {
  return new JiraReadAdapter({
    baseUrl: "https://acme.atlassian.net",
    email: "dev@acme.com",
    token: "tok",
    fetch: impl,
  });
}

describe("Jira write-back methods (#11) — developer's own identity, REST v3", () => {
  it("transitions by NAME: looks up the per-project transition id, then POSTs it", async () => {
    const { calls, impl } = writeFetch();
    await writeAdapter(impl).transitionTicket("DUG-1", "in progress");

    expect(calls[0]).toMatchObject({ method: "GET" });
    expect(calls[1]).toMatchObject({
      url: "https://acme.atlassian.net/rest/api/3/issue/DUG-1/transitions",
      method: "POST",
      body: { transition: { id: "31" } },
    });
  });

  it("throws (for the best-effort wrapper to catch) when the named transition is unavailable", async () => {
    const { impl } = writeFetch();
    await expect(writeAdapter(impl).transitionTicket("DUG-1", "Ready for QA")).rejects.toThrow(
      /Ready for QA.*In Progress, Done/s,
    );
  });

  it("creates a subtask under the parent, deriving the project key from the issue key", async () => {
    const { calls, impl } = writeFetch();
    const created = await writeAdapter(impl).createSubtask("DUG-1", "DUG-1-spec-1: Add endpoint");

    expect(created).toEqual({ key: "DUG-99" });
    expect(calls[0]).toMatchObject({
      url: "https://acme.atlassian.net/rest/api/3/issue",
      method: "POST",
      body: {
        fields: {
          project: { key: "DUG" },
          parent: { key: "DUG-1" },
          summary: "DUG-1-spec-1: Add endpoint",
          issuetype: { name: "Subtask" },
        },
      },
    });
  });

  it("closes a subtask: ADF completion comment first, then the Done transition", async () => {
    const { calls, impl } = writeFetch();
    await writeAdapter(impl).closeSubtask("DUG-99", "merged at green");

    expect(calls[0]).toMatchObject({
      url: "https://acme.atlassian.net/rest/api/3/issue/DUG-99/comment",
      method: "POST",
    });
    expect(JSON.stringify(calls[0]!.body)).toContain("merged at green");
    expect(calls[2]).toMatchObject({ method: "POST", body: { transition: { id: "41" } } });
  });
});
