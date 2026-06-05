/**
 * Workspace port — discovers local git clones under developer-chosen workspace roots
 * (CONTEXT.md "Workspace root"). Identity is matched by a clone's `origin` remote; NO directory
 * naming or nesting is enforced. The only filesystem-touching port in the seam.
 */

/** A git clone found on disk and the remote it points at, before catalog matching. */
export interface DiscoveredClone {
  /** Absolute path to the working tree root (the dir containing `.git`). */
  path: string;
  /** The clone's `origin` remote URL; undefined when the clone has no `origin`. */
  originRemote?: string;
}

export interface WorkspacePort {
  /** Developer-configured roots to scan. Machine-local config; one or many. */
  listRoots(): Promise<string[]>;
  /** Scan the given roots for git working trees. Read-only w.r.t. the repos. */
  discover(roots: string[]): Promise<DiscoveredClone[]>;
}
