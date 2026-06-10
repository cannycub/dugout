import { describe, it, expect } from "vitest";
import { GitHubAdapter } from "./github-adapter.js";

/** Scripted GitHub REST fake: records calls, replies per route. */
function fakeGitHubApi(
  opts: {
    repoPages?: Array<Array<{ name: string; ssh_url: string }>>;
    /** What `GET /users/{owner}` reports — an org or a personal account. Default org. */
    accountType?: "Organization" | "User";
    /** The login `GET /user` (the token's own account) returns. */
    authedLogin?: string;
  } = {},
) {
  const calls: Array<{ url: string; method: string; body?: unknown; auth?: string }> = [];
  let page = 0;
  const accountType = opts.accountType ?? "Organization";
  const impl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      auth: (init?.headers as Record<string, string>)["Authorization"]!,
    });
    // Account-type probe: GET /users/{owner} (no trailing /repos).
    if (/\/users\/[^/]+$/.test(u)) {
      return { ok: true, status: 200, json: async () => ({ type: accountType }) } as unknown as Response;
    }
    // The authenticated user: GET /user.
    if (u.endsWith("/user")) {
      return { ok: true, status: 200, json: async () => ({ login: opts.authedLogin ?? "acme" }) } as unknown as Response;
    }
    // Repo listing — org (/orgs/{o}/repos), other user (/users/{o}/repos), or own (/user/repos).
    if (/\/(orgs|users)\/[^/]+\/repos/.test(u) || u.includes("/user/repos")) {
      const pages = opts.repoPages ?? [[{ name: "widget-api", ssh_url: "git@github.com:acme/widget-api.git" }]];
      const body = pages[page] ?? [];
      page += 1;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }
    if (u.endsWith("/pulls")) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ html_url: "https://github.com/acme/widget-api/pull/7" }),
      } as unknown as Response;
    }
    // repo metadata (default branch)
    return { ok: true, status: 200, json: async () => ({ default_branch: "main" }) } as unknown as Response;
  }) as typeof fetch;
  return { calls, impl };
}

function adapter(impl: typeof fetch, pushed: Array<{ repo: string; branch: string }> = []) {
  return new GitHubAdapter({
    org: "acme",
    token: "gh-token",
    fetchImpl: impl,
    pushBranch: async (repo, branch) => {
      pushed.push({ repo, branch });
    },
  });
}

describe("GitHubAdapter (real REST adapter, #10)", () => {
  it("lists an org's repos via /orgs/{owner}/repos (paginated), mapping name + remote", async () => {
    const { calls, impl } = fakeGitHubApi({
      accountType: "Organization",
      repoPages: [
        [{ name: "widget-api", ssh_url: "git@github.com:acme/widget-api.git" }],
        [{ name: "pipeline", ssh_url: "git@github.com:acme/pipeline.git" }],
        [],
      ],
    });

    const repos = await adapter(impl).listOrgRepos();

    expect(repos).toEqual([
      { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
      { name: "pipeline", remote: "git@github.com:acme/pipeline.git" },
    ]);
    const listed = calls.filter((c) => c.url.includes("/repos?"));
    expect(listed[0]!.url).toBe("https://api.github.com/orgs/acme/repos?per_page=100&page=1");
    expect(listed[0]!.auth).toBe("Bearer gh-token");
    expect(calls.some((c) => c.url.includes("/users/acme/repos"))).toBe(false); // not the user path
  });

  it("lists a personal account's own repos via /user/repos (so private repos appear too)", async () => {
    // The owner is the token's own user account — 404 on /orgs, and /users/{owner}/repos would hide
    // private repos. /user/repos with affiliation=owner returns the developer's own repos, private
    // included.
    const { calls, impl } = fakeGitHubApi({ accountType: "User", authedLogin: "acme" });

    const repos = await adapter(impl).listOrgRepos();

    expect(repos).toEqual([{ name: "widget-api", remote: "git@github.com:acme/widget-api.git" }]);
    const listed = calls.find((c) => c.url.includes("/repos") && c.url.includes("page="))!;
    expect(listed.url).toContain("https://api.github.com/user/repos");
    expect(listed.url).toContain("affiliation=owner");
    expect(calls.some((c) => c.url.includes("/orgs/"))).toBe(false); // never the org endpoint
  });

  it("lists another user's public repos via /users/{owner}/repos", async () => {
    // The owner is a user but NOT the token's account — only their public repos are visible.
    const { calls, impl } = fakeGitHubApi({ accountType: "User", authedLogin: "someone-else" });

    await adapter(impl).listOrgRepos();

    const listed = calls.find((c) => c.url.includes("/repos") && c.url.includes("page="))!;
    expect(listed.url).toBe("https://api.github.com/users/acme/repos?per_page=100&page=1");
  });

  it("opens the PR against the repo's default branch and never auto-merges", async () => {
    const { calls, impl } = fakeGitHubApi();

    const pr = await adapter(impl).createPullRequest({
      repo: "widget-api",
      storyKey: "DUG-1",
      title: "[DUG-1] Stream widget events",
      body: "Specs in this PR: …",
      head: "story/DUG-1",
    });

    expect(pr).toEqual({ repo: "widget-api", url: "https://github.com/acme/widget-api/pull/7", autoMerge: false });
    const pulls = calls.find((c) => c.url.endsWith("/pulls"))!;
    expect(pulls).toMatchObject({
      url: "https://api.github.com/repos/acme/widget-api/pulls",
      method: "POST",
      body: { title: "[DUG-1] Stream widget events", head: "story/DUG-1", base: "main", body: "Specs in this PR: …" },
    });
  });

  it("delegates push to the injected git mechanic (REST cannot push a local branch)", async () => {
    const pushed: Array<{ repo: string; branch: string }> = [];
    await adapter(fakeGitHubApi().impl, pushed).push({ repo: "widget-api", branch: "story/DUG-1" });
    expect(pushed).toEqual([{ repo: "widget-api", branch: "story/DUG-1" }]);
  });

  it("fails loudly on an API error (operational, surfaced to the developer)", async () => {
    const impl = (async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    await expect(adapter(impl).listOrgRepos()).rejects.toThrow(/403/);
  });
});
