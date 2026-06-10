/**
 * Settings surface (#17): the host-side implementation behind the DugoutApi settings methods.
 * Owns LIVE propagation (ADR-0017): edits reach the running adapters without a restart —
 * workspace roots flow into the GitWorkspace thunk + a rescan, and saving/clearing Jira
 * credentials swaps the live Jira port between the real API-token adapter and the seed fake.
 */

import type { JiraPort } from "../core/ports/jira.js";
import type { SettingsView } from "../shared/dugout-api.js";
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

export interface SettingsApi {
  getSettings(): Promise<SettingsView>;
  saveWorkspaceRoots(roots: string[]): Promise<SettingsView>;
  saveJiraCredentials(creds: JiraCredentials): Promise<SettingsView>;
  clearJiraCredentials(): Promise<SettingsView>;
  saveGitHubToken(token: string): Promise<SettingsView>;
  clearGitHubToken(): Promise<SettingsView>;
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
  /** Apply new roots to the live workspace thunk + trigger the rescan/re-bind. */
  applyWorkspaceRoots: (roots: string[]) => Promise<void>;
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
      github: { configured: (await deps.secrets.get("github")) !== null },
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

    async saveGitHubToken(token: string): Promise<SettingsView> {
      // Persisted now; consumed when the live GitHub adapter reads from the secrets store
      // (today it is env-configured at startup — see #10's note / out-of-scope in #17).
      await deps.secrets.set("github", token);
      return view();
    },

    async clearGitHubToken(): Promise<SettingsView> {
      await deps.secrets.delete("github");
      return view();
    },
  };
}
