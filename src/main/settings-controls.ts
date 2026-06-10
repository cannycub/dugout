/**
 * Settings surface (#17): the host-side implementation behind the DugoutApi settings methods.
 * Owns LIVE propagation (ADR-0017): edits reach the running adapters without a restart —
 * workspace roots flow into the GitWorkspace thunk + a rescan, and saving/clearing Jira
 * credentials swaps the live Jira port between the real API-token adapter and the seed fake.
 */

import type { JiraPort } from "../core/ports/jira.js";
import type {
  GitHubPort,
  PushInput,
  CreatePullRequestInput,
} from "../core/ports/github.js";
import type { GitHubConfigInput, SettingsView } from "../shared/dugout-api.js";
import type { JiraCredentials } from "./jira-credentials.js";
import type { SettingsStore } from "./settings-store.js";
import type { SecretsStore } from "./secrets-store.js";

/** Delegating Jira port whose backing adapter can be swapped at runtime (settings save/clear). */
export class SwappableJira implements JiraPort {
  constructor(private inner: JiraPort) {}

  swap(inner: JiraPort): void {
    this.inner = inner;
  }

  listAssignedTickets() {
    return this.inner.listAssignedTickets();
  }
  transitionTicket(ticketKey: string, transition: string) {
    return this.inner.transitionTicket(ticketKey, transition);
  }
  createSubtask(parentKey: string, summary: string) {
    return this.inner.createSubtask(parentKey, summary);
  }
  addComment(issueKey: string, body: string) {
    return this.inner.addComment(issueKey, body);
  }
  closeSubtask(subtaskKey: string, comment: string) {
    return this.inner.closeSubtask(subtaskKey, comment);
  }
}

/** Delegating GitHub port whose backing adapter can be swapped at runtime (settings save/clear). */
export class SwappableGitHub implements GitHubPort {
  constructor(private inner: GitHubPort) {}

  swap(inner: GitHubPort): void {
    this.inner = inner;
  }

  push(input: PushInput) {
    return this.inner.push(input);
  }
  createPullRequest(input: CreatePullRequestInput) {
    return this.inner.createPullRequest(input);
  }
  listOrgRepos() {
    return this.inner.listOrgRepos();
  }
}

export interface SettingsApi {
  getSettings(): Promise<SettingsView>;
  saveWorkspaceRoots(roots: string[]): Promise<SettingsView>;
  saveJiraCredentials(creds: JiraCredentials): Promise<SettingsView>;
  clearJiraCredentials(): Promise<SettingsView>;
  saveGitHubConfig(input: GitHubConfigInput): Promise<SettingsView>;
  clearGitHubConfig(): Promise<SettingsView>;
  saveKiroApiKey(apiKey: string): Promise<SettingsView>;
  clearKiroApiKey(): Promise<SettingsView>;
}

export interface SettingsControlsDeps {
  settingsStore: SettingsStore;
  secrets: SecretsStore;
  /** The live Jira port the orchestrator holds. */
  jira: SwappableJira;
  /** The unconfigured fallback (seed fake) the port reverts to when credentials clear. */
  fallbackJira: JiraPort;
  /** Build the real API-token adapter from saved credentials. */
  makeJiraAdapter: (creds: JiraCredentials) => JiraPort;
  /** The live GitHub port the orchestrator + catalog hold. */
  github: SwappableGitHub;
  /** The unconfigured fallback (seed catalog fake) the port reverts to when config clears. */
  fallbackGitHub: GitHubPort;
  /** Build the real org+token adapter from saved config. */
  makeGitHubAdapter: (config: GitHubConfigInput) => GitHubPort;
  /** Apply new roots to the live workspace thunk + trigger the rescan/re-bind. */
  applyWorkspaceRoots: (roots: string[]) => Promise<void>;
  /** Push the kiro key into the live executor's key holder (null reverts to the startup fallback). */
  applyKiroApiKey: (apiKey: string | null) => void;
  encryptionAvailable: () => boolean;
}

export function makeSettingsControls(deps: SettingsControlsDeps): SettingsApi {
  const view = async (): Promise<SettingsView> => {
    const settings = await deps.settingsStore.load();
    const jiraRaw = await deps.secrets.get("jira");
    const jira = jiraRaw ? (JSON.parse(jiraRaw) as JiraCredentials) : null;
    return {
      workspaceRoots: settings.workspaceRoots,
      // Token itself never crosses to the renderer — only its presence.
      jira: { baseUrl: jira?.baseUrl ?? "", email: jira?.email ?? "", configured: jira !== null },
      github: { org: settings.githubOrg, configured: (await deps.secrets.get("github")) !== null },
      kiro: { configured: (await deps.secrets.get("kiro")) !== null },
      encryptionAvailable: deps.encryptionAvailable(),
    };
  };

  return {
    getSettings: view,

    async saveWorkspaceRoots(roots: string[]): Promise<SettingsView> {
      const cleaned = roots.map((r) => r.trim()).filter(Boolean);
      const settings = await deps.settingsStore.load();
      await deps.settingsStore.save({ ...settings, workspaceRoots: cleaned });
      await deps.applyWorkspaceRoots(cleaned);
      return view();
    },

    async saveJiraCredentials(creds: JiraCredentials): Promise<SettingsView> {
      await deps.secrets.set("jira", JSON.stringify(creds));
      deps.jira.swap(deps.makeJiraAdapter(creds)); // live, no restart
      return view();
    },

    async clearJiraCredentials(): Promise<SettingsView> {
      await deps.secrets.delete("jira");
      deps.jira.swap(deps.fallbackJira); // revert to the seed fake
      return view();
    },

    async saveGitHubConfig({ org, token }: GitHubConfigInput): Promise<SettingsView> {
      // Org (non-secret) → settings.json; token → keyed secrets. Then swap the live catalog/PR
      // adapter so the org list goes live and PRs open for real, no restart (ADR-0017).
      const settings = await deps.settingsStore.load();
      await deps.settingsStore.save({ ...settings, githubOrg: org });
      await deps.secrets.set("github", token);
      deps.github.swap(deps.makeGitHubAdapter({ org, token }));
      return view();
    },

    async clearGitHubConfig(): Promise<SettingsView> {
      // Drop the token and revert to the seed fake; the org stays in settings so re-entering just
      // the token reconnects.
      await deps.secrets.delete("github");
      deps.github.swap(deps.fallbackGitHub);
      return view();
    },

    async saveKiroApiKey(apiKey: string): Promise<SettingsView> {
      // Persisted into the keyed store, then pushed into the live executor's key holder so the next
      // draft/execute uses it with no restart (ADR-0017).
      await deps.secrets.set("kiro", apiKey);
      deps.applyKiroApiKey(apiKey);
      return view();
    },

    async clearKiroApiKey(): Promise<SettingsView> {
      await deps.secrets.delete("kiro");
      deps.applyKiroApiKey(null); // revert to the startup fallback (kiro.cred / env)
      return view();
    },
  };
}
