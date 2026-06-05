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
    expect(captured.url).toContain("/rest/api/3/search");
    expect(captured.auth).toBe(`Basic ${Buffer.from("dev@acme.com:tok").toString("base64")}`);
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
