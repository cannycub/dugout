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
  const [githubDraft, setGithubDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void dugout.getSettings().then((v) => {
      setView(v);
      setJiraDraft({ baseUrl: v.jira.baseUrl, email: v.jira.email, token: "" });
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

      <section className="field settings-section">
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

      <section className="field settings-section">
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

      <section className="field settings-section">
        <div className="field-head">
          <span className="panel-eyebrow">GitHub</span>
          <span className={`settings-chip ${view.github.configured ? "on" : ""}`}>
            {view.github.configured ? "token saved" : "no token"}
          </span>
        </div>
        <p className="muted small">
          Stored now in the same encrypted store; used by the live org catalog and PR creation as
          those adapters move off env configuration.
        </p>
        <div className="settings-row">
          <input
            className="declare-search"
            type="password"
            placeholder={view.github.configured ? "saved — enter to replace" : "fine-grained personal access token"}
            aria-label="GitHub token"
            value={githubDraft}
            onChange={(e) => setGithubDraft(e.target.value)}
          />
          <button
            type="button"
            className="call-btn turf"
            disabled={!view.encryptionAvailable || !githubDraft}
            onClick={() =>
              apply(() => dugout.saveGitHubToken(githubDraft), "GitHub token saved.").then(() =>
                setGithubDraft(""),
              )
            }
          >
            Save token
          </button>
          {view.github.configured && (
            <button
              type="button"
              className="call-btn"
              onClick={() => apply(() => dugout.clearGitHubToken(), "GitHub token cleared.")}
            >
              Clear
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
