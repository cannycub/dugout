import type { RepoIdentity, CatalogPort } from "./ports/catalog.js";
import type { WorkspacePort, DiscoveredClone } from "./ports/workspace.js";

/** Where a catalog identity lives (or doesn't) on this machine. */
export type CloneBinding =
  | { status: "cloned"; path: string }
  /** In the catalog, no matching clone under any workspace root. Still selectable. */
  | { status: "not-cloned" }
  /** >1 local clone matched the same remote; the developer must disambiguate before execute. */
  | { status: "ambiguous"; candidates: string[] };

/** A catalog identity plus its resolved local binding — the unit `search` returns. */
export interface RepoMatch {
  identity: RepoIdentity;
  clone: CloneBinding;
}

/**
 * A catalog identity put in scope for ONE story, bound (or not) to the developer's local clone
 * (CONTEXT.md "Declared repo"). Flows into `draft`. `clone.status` may be "not-cloned"; execute
 * mode (later) is what requires a path (ADR-0004).
 */
export interface DeclaredRepo {
  identity: RepoIdentity;
  clone: CloneBinding;
}
