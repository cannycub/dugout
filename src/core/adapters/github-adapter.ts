/**
 * Real GitHub adapter (#10): the GitHub REST API directly — never the `gh` CLI or any other
 * locally-installed tool, so it works for end users with nothing but the app (authenticated with
 * the developer's own token). Carries the whole GitHubPort:
 *
 * - `listOrgRepos` — the live team catalog (replaces FakeGitHub(SEED_CATALOG) in the running app).
 * - `createPullRequest` — one fully-linked PR per repo against the repo's default branch.
 *   Dugout NEVER auto-merges (invariant 5): nothing here can merge.
 * - `push` — delegated to an injected git mechanic: pushing a local story branch is a git
 *   operation (the REST API cannot push a local branch), performed on the clone's own remote.
 *
 * API errors fail loudly (operational): the developer fixes auth/scope and retries.
 */

import type {
  GitHubPort,
  OrgRepo,
  PushInput,
  CreatePullRequestInput,
  PullRequest,
} from "../ports/github.js";

export interface GitHubAdapterConfig {
  /** The GitHub org whose repos form the team catalog. */
  org: string;
  /** The developer's token (fine-grained PAT); lives in the secrets store (#17) / env until then. */
  token: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Push the local branch to the repo's remote — git mechanics injected from the host. */
  pushBranch: (repo: string, branch: string) => Promise<void>;
}

export class GitHubAdapter implements GitHubPort {
  constructor(private readonly config: GitHubAdapterConfig) {}

  async listOrgRepos(): Promise<OrgRepo[]> {
    const repos: OrgRepo[] = [];
    for (let page = 1; ; page++) {
      const body = (await this.get(
        `https://api.github.com/orgs/${this.config.org}/repos?per_page=100&page=${page}`,
      )) as Array<{ name: string; ssh_url: string }>;
      repos.push(...body.map((r) => ({ name: r.name, remote: r.ssh_url })));
      if (body.length === 0) break; // page past the end ⇒ done (no Link-header parsing needed)
    }
    return repos;
  }

  async push(input: PushInput): Promise<void> {
    await this.config.pushBranch(input.repo, input.branch);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const { org } = this.config;
    // Base = the repo's default branch (queried, not assumed — repos differ).
    const meta = (await this.get(`https://api.github.com/repos/${org}/${input.repo}`)) as {
      default_branch: string;
    };
    const res = await (this.config.fetchImpl ?? fetch)(
      `https://api.github.com/repos/${org}/${input.repo}/pulls`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          title: input.title,
          head: input.head,
          base: meta.default_branch,
          body: input.body,
        }),
      },
    );
    if (!res.ok) throw new Error(`GitHub PR create failed for ${input.repo}: ${res.status}`);
    const body = (await res.json()) as { html_url: string };
    return { repo: input.repo, url: body.html_url, autoMerge: false };
  }

  private async get(url: string): Promise<unknown> {
    const res = await (this.config.fetchImpl ?? fetch)(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`GitHub API ${url} failed: ${res.status}`);
    return res.json();
  }

  private headers(json = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }
}
