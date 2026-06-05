/**
 * Catalog port — the team-wide list of known repo identities (CONTEXT.md "Catalog").
 * Source in v1 is the GitHub org's repos; team-owned, never derived from disk layout.
 * Adapter swaps (GitHub org → cached file) without touching orchestration.
 */

/** A stable, machine-independent repo identity. The unit the developer selects from. NOT a path. */
export interface RepoIdentity {
  /** Catalog name, e.g. "widget-api". This is the value used as `spec.repo`. */
  name: string;
  /** Canonical remote URL — the ground truth matched against a clone's `origin`. */
  remote: string;
}

export interface CatalogPort {
  /** The full team catalog. Long; callers filter via RepoScope.search, not by re-fetching. */
  listRepos(): Promise<RepoIdentity[]>;
}
