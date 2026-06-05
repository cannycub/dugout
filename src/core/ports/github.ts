/**
 * GitHub port — push story branches and open pull requests. Dugout NEVER auto-merges and never
 * replaces peer review (CONTEXT.md invariant 5): the merge decision always stays with humans.
 */

export interface PushInput {
  repo: string;
  /** The local story branch being pushed (single end-of-story push). */
  branch: string;
}

export interface CreatePullRequestInput {
  repo: string;
  /** Story (Jira) key, stamped into the PR title for end-to-end traceability. */
  storyKey: string;
  title: string;
  /** Fully-linked body: AC mapping, specs, test results, what changed and why. */
  body: string;
  /** The story branch pushed for this repo. */
  head: string;
}

export interface PullRequest {
  repo: string;
  url: string;
  /** Always false — Dugout never auto-merges. */
  autoMerge: false;
}

/** A repo as listed by the org (the catalog source). */
export interface OrgRepo {
  name: string;
  /** Canonical clone URL advertised by GitHub (e.g. the ssh or https remote). */
  remote: string;
}

export interface GitHubPort {
  push(input: PushInput): Promise<void>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  /** List the configured org's repos (the team catalog source). */
  listOrgRepos(): Promise<OrgRepo[]>;
}
