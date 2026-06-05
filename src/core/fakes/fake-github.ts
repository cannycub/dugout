import type {
  CreatePullRequestInput,
  GitHubPort,
  OrgRepo,
  PullRequest,
  PushInput,
} from "../ports/github.js";

/** In-memory GitHub adapter; records pushes and PR creations, returns canned PRs. */
export class FakeGitHub implements GitHubPort {
  readonly pushes: PushInput[] = [];
  readonly pullRequests: CreatePullRequestInput[] = [];

  constructor(private readonly orgRepos: OrgRepo[] = []) {}

  async listOrgRepos(): Promise<OrgRepo[]> {
    return this.orgRepos;
  }

  async push(input: PushInput): Promise<void> {
    this.pushes.push(input);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    this.pullRequests.push(input);
    return {
      repo: input.repo,
      url: `https://github.com/fake/${input.repo}/pull/${this.pullRequests.length}`,
      autoMerge: false,
    };
  }
}
