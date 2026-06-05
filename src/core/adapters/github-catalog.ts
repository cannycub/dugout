import type { CatalogPort, RepoIdentity } from "../ports/catalog.js";
import type { GitHubPort } from "../ports/github.js";

/** Real catalog: the GitHub org's repos, projected into catalog identities (ADR-0006). */
export class GitHubCatalog implements CatalogPort {
  constructor(private readonly github: GitHubPort) {}
  async listRepos(): Promise<RepoIdentity[]> {
    const repos = await this.github.listOrgRepos();
    return repos.map((r) => ({ name: r.name, remote: r.remote }));
  }
}
