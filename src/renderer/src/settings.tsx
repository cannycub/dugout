import { useEffect, useState } from "react";
import type { SettingsView } from "../../shared/dugout-api.js";
import { useDugout } from "./dugout-context.js";

/**
 * Settings surface (#17): workspace roots, Jira credentials, GitHub token — the durable,
 * machine-local user config (ADR-0017). Edits propagate live (roots → rescan + re-bind; Jira save
 * swaps the live adapter); secrets are write-only here, never echoed back.
 */
export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const dugout = useDugout();
  const [view, setView] = useState<SettingsView | null>(null);
  const [rootDraft, setRootDraft] = useState("");
  const [jiraDraft, setJiraDraft] = useState({ baseUrl: "", email: "", token: "" });
  const [githubDraft, setGithubDraft] = useState({ org: "", token: "" });
  const [kiroDraft, setKiroDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void dugout.getSettings().then((v) => {
      setView(v);
      setJiraDraft({ baseUrl: v.jira.baseUrl, email: v.jira.email, token: "" });
      setGithubDraft({ org: v.github.org, token: "" });
    });
  }, [dugout]);

  if (!view) return null;

  const apply = async (op: () => Promise<SettingsView>, done: string) => {
    setError(null);
    try {
      setView(await op());
      setNotice(done);
    } catch (err) {
      setNotice(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addRoot = () =>
    apply(
      () => dugout.saveWorkspaceRoots([...view.workspaceRoots, rootDraft]),
      "Roots saved — clones rescanned.",
    ).then(() => setRootDraft(""));

  const removeRoot = (root: string) =>
    apply(
      () => dugout.saveWorkspaceRoots(view.workspaceRoots.filter((r) => r !== root)),
      "Roots saved — clones rescanned.",
    );

  const saveJira = () =>
    apply(() => dugout.saveJiraCredentials(jiraDraft), "Jira connected — live, no restart needed.").then(
      () => setJiraDraft((d) => ({ ...d, token: "" })),
    );

  return (
    <div className="settings">
      <div className="settings-head">
        <button type="button" className="back-btn" onClick={onBack}>
          ◂ Back
        </button>
        <span className="panel-eyebrow">Settings</span>
      </div>

      {!view.encryptionAvailable && (
        <div className="error-bar">
          ⚠ Secure storage is unavailable on this system (no OS keyring). Credentials cannot be
          saved — they would otherwise be stored in plaintext, which Dugout refuses to do.
        </div>
      )}
      {notice && <div className="settings-notice">{notice}</div>}
      {error && <div className="error-bar">⚠ {error}</div>}

      <section className="settings-card">
        <div className="field-head">
          <span className="panel-eyebrow">Workspace roots</span>
          <span className="field-count">{view.workspaceRoots.length}</span>
        </div>
        <p className="muted small">
          Directories scanned (one level deep) for git clones. Declared repos bind to clones found
          here; saving rescans immediately.
        </p>
        <ul className="root-list">
          {view.workspaceRoots.map((root) => (
            <li key={root} className="root-row">
              <code className="root-path">{root}</code>
              <button type="button" className="root-remove" onClick={() => removeRoot(root)}>
                remove
              </button>
            </li>
          ))}
          {view.workspaceRoots.length === 0 && (
            <li className="muted small">No roots yet — every repo will show as “not cloned”.</li>
          )}
        </ul>
        <div className="settings-row">
          <input
            className="declare-search"
            type="text"
            placeholder="/path/to/your/workspace"
            aria-label="Add workspace root"
            value={rootDraft}
            onChange={(e) => setRootDraft(e.target.value)}
          />
          <button type="button" className="call-btn turf" disabled={!rootDraft.trim()} onClick={addRoot}>
            Add root
          </button>
        </div>
      </section>

      <div className="settings-credentials">
      <section className="settings-card">
        <div className="field-head">
          <span className="panel-eyebrow">Jira</span>
          <span className={`settings-chip ${view.jira.configured ? "on" : ""}`}>
            {view.jira.configured ? "connected" : "not connected"}
          </span>
        </div>
        <p className="muted small">
          Your own Atlassian account — every Jira read/write rides your personal API token.
        </p>
        <div className="settings-grid">
          <label>
            base URL
            <input
              className="declare-search"
              type="text"
              placeholder="https://acme.atlassian.net"
              aria-label="Jira base URL"
              value={jiraDraft.baseUrl}
              onChange={(e) => setJiraDraft({ ...jiraDraft, baseUrl: e.target.value })}
            />
          </label>
          <label>
            email
            <input
              className="declare-search"
              type="text"
              placeholder="you@acme.com"
              aria-label="Jira email"
              value={jiraDraft.email}
              onChange={(e) => setJiraDraft({ ...jiraDraft, email: e.target.value })}
            />
          </label>
          <label>
            API token
            <input
              className="declare-search"
              type="password"
              placeholder={view.jira.configured ? "saved — enter to replace" : "paste your token"}
              aria-label="Jira API token"
              value={jiraDraft.token}
              onChange={(e) => setJiraDraft({ ...jiraDraft, token: e.target.value })}
            />
          </label>
        </div>
        <div className="settings-row">
          <button
            type="button"
            className="call-btn turf"
            disabled={
              !view.encryptionAvailable || !jiraDraft.baseUrl.trim() || !jiraDraft.email.trim() || !jiraDraft.token
            }
            onClick={saveJira}
          >
            Save & connect
          </button>
          {view.jira.configured && (
            <button
              type="button"
              className="call-btn"
              onClick={() => apply(() => dugout.clearJiraCredentials(), "Jira disconnected.")}
            >
              Clear
            </button>
          )}
        </div>
      </section>

      <div className="settings-col">
      <section className="settings-card">
        <div className="field-head">
          <span className="panel-eyebrow">GitHub</span>
          <span className={`settings-chip ${view.github.configured ? "on" : ""}`}>
            {view.github.configured ? "connected" : "not connected"}
          </span>
        </div>
        <p className="muted small">
          Org + your fine-grained PAT. Saving takes the live org catalog and PR creation live
          immediately — no restart.
        </p>
        <div className="settings-grid">
          <label>
            org
            <input
              className="declare-search"
              type="text"
              placeholder="acme-inc"
              aria-label="GitHub org"
              value={githubDraft.org}
              onChange={(e) => setGithubDraft({ ...githubDraft, org: e.target.value })}
            />
          </label>
          <label>
            token
            <input
              className="declare-search"
              type="password"
              placeholder={view.github.configured ? "saved — enter to replace" : "fine-grained personal access token"}
              aria-label="GitHub token"
              value={githubDraft.token}
              onChange={(e) => setGithubDraft({ ...githubDraft, token: e.target.value })}
            />
          </label>
        </div>
        <div className="settings-row">
          <button
            type="button"
            className="call-btn turf"
            disabled={!view.encryptionAvailable || !githubDraft.org.trim() || !githubDraft.token}
            onClick={() =>
              apply(
                () => dugout.saveGitHubConfig({ org: githubDraft.org.trim(), token: githubDraft.token }),
                "GitHub connected — live, no restart needed.",
              ).then(() => setGithubDraft((d) => ({ ...d, token: "" })))
            }
          >
            Save & connect
          </button>
          {view.github.configured && (
            <button
              type="button"
              className="call-btn"
              onClick={() => apply(() => dugout.clearGitHubConfig(), "GitHub disconnected.")}
            >
              Clear
            </button>
          )}
        </div>
      </section>

      <section className="settings-card">
        <div className="field-head">
          <span className="panel-eyebrow">Kiro</span>
          <span className={`settings-chip ${view.kiro.configured ? "on" : ""}`}>
            {view.kiro.configured ? "key saved" : "no key"}
          </span>
        </div>
        <p className="muted small">
          API key for the build agent that drafts and executes specs. Stored encrypted; the next
          draft/execute uses it — no restart.
        </p>
        <div className="settings-row">
          <input
            className="declare-search"
            type="password"
            placeholder={view.kiro.configured ? "saved — enter to replace" : "paste your kiro API key"}
            aria-label="Kiro API key"
            value={kiroDraft}
            onChange={(e) => setKiroDraft(e.target.value)}
          />
          <button
            type="button"
            className="call-btn turf"
            disabled={!view.encryptionAvailable || !kiroDraft}
            onClick={() =>
              apply(() => dugout.saveKiroApiKey(kiroDraft), "Kiro API key saved — live, no restart.").then(
                () => setKiroDraft(""),
              )
            }
          >
            Save key
          </button>
          {view.kiro.configured && (
            <button
              type="button"
              className="call-btn"
              onClick={() => apply(() => dugout.clearKiroApiKey(), "Kiro API key cleared.")}
            >
              Clear
            </button>
          )}
        </div>
      </section>
      </div>
      </div>
    </div>
  );
}
