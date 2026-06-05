import type { CatalogPort, RepoIdentity } from "../ports/catalog.js";

/** In-memory catalog adapter returning a canned identity list. */
export class FakeCatalog implements CatalogPort {
  constructor(private readonly repos: RepoIdentity[]) {}
  async listRepos(): Promise<RepoIdentity[]> {
    return this.repos;
  }
}
