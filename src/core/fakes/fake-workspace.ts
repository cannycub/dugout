import type { WorkspacePort, DiscoveredClone } from "../ports/workspace.js";

export interface FakeWorkspaceConfig {
  roots: string[];
  /** Clones "found" regardless of which roots are passed to discover(). */
  clones: DiscoveredClone[];
}

/** In-memory workspace adapter; canned roots + clones, no filesystem. */
export class FakeWorkspace implements WorkspacePort {
  readonly discoverCalls: string[][] = [];
  constructor(private readonly config: FakeWorkspaceConfig) {}

  async listRoots(): Promise<string[]> {
    return this.config.roots;
  }
  async discover(roots: string[]): Promise<DiscoveredClone[]> {
    this.discoverCalls.push(roots);
    return this.config.clones;
  }

  /** Simulate a clone appearing mid-flight (e.g. the developer clones a repo between scans). */
  addClone(clone: DiscoveredClone): void {
    this.config.clones.push(clone);
  }
}
