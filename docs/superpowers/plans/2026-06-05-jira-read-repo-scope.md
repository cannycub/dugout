# Jira Read — Repo Scope & Ticket Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded fake ticket/repos with a real Jira read (developer's own API token), a searchable GitHub-org repo catalog, local-clone discovery, and a ticket-select + declare-repos UI feeding the existing state machine.

**Architecture:** A new **repo-scope seam** — two ports (`CatalogPort` = GitHub org, `WorkspacePort` = local clone discovery) composed by a plain `RepoScope` façade that binds catalog identities to local clones by normalized remote URL. A real `JiraReadAdapter` (Basic auth, API token via `safeStorage`) behind the existing `JiraPort`. `draftStory`/`draft` widen from `repos: string[]` to `DeclaredRepo[]`. UI built via the `frontend-design` skill. All behaviour tested through fakes; real git mechanics tested on throwaway temp repos.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest 4, Electron 42 (`safeStorage`, `contextBridge`), React 19, Node 24 (`node:test`-free — Vitest), `node:child_process`/`simple-git`-free (use `git` via `execFile`).

**Reference docs (read before starting):** `CONTEXT.md` (Catalog/Workspace root/Declared repo/Fan-out/Stop/Cascade), `docs/adr/0004` (local-clone boundary), `docs/adr/0005` (Jira API-token auth), `docs/adr/0006` (repo-scope seam contract), issue #3.

**Branch:** `git switch -c feat/3-jira-read` off `main` before Task 1.

**The four parts (each is independently testable; natural commit/PR groupings):**
- **Part A — Repo-scope seam** (Tasks A1–A7): types, two ports + fakes, `RepoScope` façade, real adapters.
- **Part B — Jira real adapter** (Tasks B1–B3): `JiraReadAdapter` + credential store.
- **Part C — Orchestrator + IPC wiring** (Tasks C1–C4): widen `draft` to `DeclaredRepo[]`, expose seam over `DugoutApi`.
- **Part D — UI** (Tasks D1–D3): ticket-select + declare-repos views via `frontend-design`.

---

## File Structure

**Create:**
- `src/core/ports/catalog.ts` — `CatalogPort`, `RepoIdentity`.
- `src/core/ports/workspace.ts` — `WorkspacePort`, `DiscoveredClone`.
- `src/core/repo-scope.ts` — `RepoScope` façade, `CloneBinding`, `RepoMatch`, `DeclaredRepo`, `canonicalRemote()`.
- `src/core/fakes/fake-catalog.ts` — `FakeCatalog`.
- `src/core/fakes/fake-workspace.ts` — `FakeWorkspace`.
- `src/core/adapters/github-catalog.ts` — real `CatalogPort` over `GitHubPort`.
- `src/core/adapters/git-workspace.ts` — real `WorkspacePort` (scans dirs, reads `origin` via `git`).
- `src/core/adapters/jira-read-adapter.ts` — real `JiraPort` (Basic auth, injected `fetch`).
- `src/main/jira-credentials.ts` — `safeStorage`-backed token store.
- Test files alongside each (`*.test.ts`).

**Modify:**
- `src/core/ports/executor.ts` — `DraftInput.repos: DeclaredRepo[]`.
- `src/core/ports/github.ts` — add `listOrgRepos()` to `GitHubPort`.
- `src/core/fakes/fake-github.ts` — implement `listOrgRepos()`.
- `src/core/orchestrator.ts` — `draftStory(ticketKey, { repos: DeclaredRepo[] })`; add `repoScope`/`catalog` deps + pass-through methods.
- `src/core/test-harness.ts` — wire the new ports/fakes; update `draftAndApprove`.
- `src/shared/dugout-api.ts` — `CHANNELS` + `DugoutApi`: `searchRepos`, `rescanRepos`, `listWorkspaceRoots`; `draft` takes `DeclaredRepo[]`.
- `src/preload/index.ts` — wire new channels.
- `src/main/index.ts` — register new IPC handlers.
- `src/main/orchestrator-host.ts` — wire real Jira/catalog/workspace adapters (config-gated).
- `src/renderer/src/local-dugout-api.ts` — implement new methods over the in-process orchestrator.
- `src/renderer/src/App.tsx` + `components.tsx` — ticket-select + declare-repos (Part D).

---

# Part A — Repo-scope seam

### Task A1: Seam types — `RepoIdentity`, `DiscoveredClone`, `CloneBinding`, `RepoMatch`, `DeclaredRepo`

**Files:**
- Create: `src/core/ports/catalog.ts`, `src/core/ports/workspace.ts`
- Create: `src/core/repo-scope.ts` (types portion; `RepoScope` class added in A4)

- [ ] **Step 1: Create the catalog port + identity type**

`src/core/ports/catalog.ts`:
```ts
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
```

- [ ] **Step 2: Create the workspace port + discovered-clone type**

`src/core/ports/workspace.ts`:
```ts
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
```

- [ ] **Step 3: Create the binding + declared-repo types (top of `src/core/repo-scope.ts`)**

`src/core/repo-scope.ts`:
```ts
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
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (new files compile; nothing references them yet).

- [ ] **Step 5: Commit**

```bash
git add src/core/ports/catalog.ts src/core/ports/workspace.ts src/core/repo-scope.ts
git commit -m "feat: repo-scope seam types (catalog/workspace ports, CloneBinding, DeclaredRepo)"
```

---

### Task A2: `canonicalRemote()` — remote-URL normalization

**Files:**
- Modify: `src/core/repo-scope.ts`
- Test: `src/core/repo-scope.canonical-remote.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/repo-scope.canonical-remote.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { canonicalRemote } from "./repo-scope.js";

describe("canonicalRemote", () => {
  it("normalizes ssh and https forms of the same repo to one key", () => {
    const ssh = canonicalRemote("git@github.com:acme/Widget-API.git");
    const https = canonicalRemote("https://github.com/acme/widget-api");
    expect(ssh).toBe(https);
    expect(ssh).toBe("github.com/acme/widget-api");
  });

  it("strips trailing slash and .git, lowercases host+path", () => {
    expect(canonicalRemote("https://GitHub.com/Acme/Repo.git/")).toBe("github.com/acme/repo");
  });

  it("returns empty string for an undefined/blank remote", () => {
    expect(canonicalRemote(undefined)).toBe("");
    expect(canonicalRemote("")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/repo-scope.canonical-remote.test.ts`
Expected: FAIL with "canonicalRemote is not a function" / not exported.

- [ ] **Step 3: Implement `canonicalRemote` (append to `src/core/repo-scope.ts`)**

```ts
/**
 * Reduce a git remote URL to a stable content-address key so ssh and https forms of the same
 * repo match: strip scheme/credentials, the trailing `.git` and slash, and lowercase host+path.
 * `git@github.com:acme/widget.git` and `https://github.com/acme/widget` → `github.com/acme/widget`.
 */
export function canonicalRemote(url: string | undefined): string {
  if (!url) return "";
  let s = url.trim();
  // scp-like ssh form: git@host:owner/repo(.git)
  const scp = /^[^/@]+@([^:]+):(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z]+:\/\//i, ""); // drop scheme
    s = s.replace(/^[^/@]+@/, ""); // drop user@ (ssh://user@host/…)
  }
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  return s.toLowerCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/repo-scope.canonical-remote.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/repo-scope.ts src/core/repo-scope.canonical-remote.test.ts
git commit -m "feat: canonicalRemote — normalize git remote URLs for clone matching"
```

---

### Task A3: Fakes — `FakeCatalog` and `FakeWorkspace`

**Files:**
- Create: `src/core/fakes/fake-catalog.ts`, `src/core/fakes/fake-workspace.ts`

- [ ] **Step 1: Create `FakeCatalog`**

`src/core/fakes/fake-catalog.ts`:
```ts
import type { CatalogPort, RepoIdentity } from "../ports/catalog.js";

/** In-memory catalog adapter returning a canned identity list. */
export class FakeCatalog implements CatalogPort {
  constructor(private readonly repos: RepoIdentity[]) {}
  async listRepos(): Promise<RepoIdentity[]> {
    return this.repos;
  }
}
```

- [ ] **Step 2: Create `FakeWorkspace`**

`src/core/fakes/fake-workspace.ts`:
```ts
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
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/fakes/fake-catalog.ts src/core/fakes/fake-workspace.ts
git commit -m "feat: FakeCatalog and FakeWorkspace adapters for repo-scope tests"
```

---

### Task A4: `RepoScope.search()` — bind catalog identities to clones, filter by query

**Files:**
- Modify: `src/core/repo-scope.ts`
- Test: `src/core/repo-scope.search.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/repo-scope.search.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RepoScope } from "./repo-scope.js";
import { FakeCatalog } from "./fakes/fake-catalog.js";
import { FakeWorkspace } from "./fakes/fake-workspace.js";

function scope() {
  const catalog = new FakeCatalog([
    { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
    { name: "pipeline", remote: "git@github.com:acme/pipeline.git" },
    { name: "ledger", remote: "git@github.com:acme/ledger.git" },
  ]);
  const workspace = new FakeWorkspace({
    roots: ["/ws"],
    clones: [
      // ssh↔https still matches widget-api:
      { path: "/ws/widget-api", originRemote: "https://github.com/acme/widget-api.git" },
      // two clones of pipeline ⇒ ambiguous:
      { path: "/ws/pipeline", originRemote: "git@github.com:acme/pipeline.git" },
      { path: "/ws/pipeline-copy", originRemote: "git@github.com:acme/pipeline.git" },
    ],
  });
  return new RepoScope(catalog, workspace);
}

describe("RepoScope.search", () => {
  it("binds cloned, not-cloned, and ambiguous repos", async () => {
    const all = await scope().search("");
    const byName = Object.fromEntries(all.map((m) => [m.identity.name, m.clone]));
    expect(byName["widget-api"]).toEqual({ status: "cloned", path: "/ws/widget-api" });
    expect(byName["ledger"]).toEqual({ status: "not-cloned" });
    expect(byName["pipeline"]).toEqual({
      status: "ambiguous",
      candidates: ["/ws/pipeline", "/ws/pipeline-copy"],
    });
  });

  it("filters by case-insensitive substring of the name", async () => {
    const hits = await scope().search("WIDGET");
    expect(hits.map((m) => m.identity.name)).toEqual(["widget-api"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/repo-scope.search.test.ts`
Expected: FAIL with "RepoScope is not a constructor".

- [ ] **Step 3: Implement `RepoScope` (append class to `src/core/repo-scope.ts`)**

```ts
/**
 * Repo-scope façade — binds catalog identities to discovered local clones to produce the story's
 * declared repos (CONTEXT.md, ADR-0006). A plain composer over two ports: nothing to swap
 * underneath, so it is not itself a port. Eager scan (cached), cheap in-memory filtering.
 */
export class RepoScope {
  private cache?: { catalog: RepoIdentity[]; clones: DiscoveredClone[] };

  constructor(
    private readonly catalog: CatalogPort,
    private readonly workspace: WorkspacePort,
  ) {}

  /** Filter the catalog by query; each result is resolved against local clones. Empty ⇒ all. */
  async search(query: string): Promise<RepoMatch[]> {
    const { catalog, clones } = await this.index();
    const q = query.trim().toLowerCase();
    return catalog
      .filter((id) => (q ? id.name.toLowerCase().includes(q) : true))
      .map((identity) => ({ identity, clone: bind(identity, clones) }));
  }

  /** Bind chosen catalog names to local clones for this story (CONTEXT.md "Declared repo"). */
  async declare(names: string[]): Promise<DeclaredRepo[]> {
    const { catalog, clones } = await this.index();
    return names.map((name) => {
      const identity = catalog.find((id) => id.name === name);
      if (!identity) throw new Error(`Repo "${name}" is not in the catalog`);
      return { identity, clone: bind(identity, clones) };
    });
  }

  /** Re-scan workspace roots and refresh the catalog+clone index (drops the cache). */
  async rescan(): Promise<void> {
    this.cache = undefined;
    await this.index();
  }

  /** Build (once) and cache the catalog + clone snapshot. */
  private async index(): Promise<{ catalog: RepoIdentity[]; clones: DiscoveredClone[] }> {
    if (!this.cache) {
      const roots = await this.workspace.listRoots();
      const [catalog, clones] = await Promise.all([
        this.catalog.listRepos(),
        this.workspace.discover(roots),
      ]);
      this.cache = { catalog, clones };
    }
    return this.cache;
  }
}

/** Resolve one identity against the discovered clones by normalized remote. */
function bind(identity: RepoIdentity, clones: DiscoveredClone[]): CloneBinding {
  const key = canonicalRemote(identity.remote);
  const matches = clones.filter((c) => canonicalRemote(c.originRemote) === key);
  if (matches.length === 0) return { status: "not-cloned" };
  if (matches.length === 1) return { status: "cloned", path: matches[0]!.path };
  return { status: "ambiguous", candidates: matches.map((c) => c.path) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/repo-scope.search.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/repo-scope.ts src/core/repo-scope.search.test.ts
git commit -m "feat: RepoScope.search — bind catalog to clones (cloned/not-cloned/ambiguous)"
```

---

### Task A5: `RepoScope.declare()` and `rescan()` behaviour

**Files:**
- Test: `src/core/repo-scope.declare.test.ts`

- [ ] **Step 1: Write the failing test** (implementation already added in A4; this locks the contract)

`src/core/repo-scope.declare.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RepoScope } from "./repo-scope.js";
import { FakeCatalog } from "./fakes/fake-catalog.js";
import { FakeWorkspace } from "./fakes/fake-workspace.js";

describe("RepoScope.declare / rescan", () => {
  it("declares a not-cloned repo (selectable, no path) and a cloned one", async () => {
    const scope = new RepoScope(
      new FakeCatalog([
        { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
        { name: "ledger", remote: "git@github.com:acme/ledger.git" },
      ]),
      new FakeWorkspace({
        roots: ["/ws"],
        clones: [{ path: "/ws/widget-api", originRemote: "git@github.com:acme/widget-api.git" }],
      }),
    );
    const declared = await scope.declare(["widget-api", "ledger"]);
    expect(declared.find((d) => d.identity.name === "widget-api")!.clone).toEqual({
      status: "cloned",
      path: "/ws/widget-api",
    });
    expect(declared.find((d) => d.identity.name === "ledger")!.clone).toEqual({
      status: "not-cloned",
    });
  });

  it("throws when declaring a name not in the catalog", async () => {
    const scope = new RepoScope(new FakeCatalog([]), new FakeWorkspace({ roots: [], clones: [] }));
    await expect(scope.declare(["nope"])).rejects.toThrow(/not in the catalog/);
  });

  it("rescan re-reads the workspace so newly-cloned repos bind", async () => {
    const workspace = new FakeWorkspace({ roots: ["/ws"], clones: [] });
    const scope = new RepoScope(
      new FakeCatalog([{ name: "ledger", remote: "git@github.com:acme/ledger.git" }]),
      workspace,
    );
    expect((await scope.declare(["ledger"]))[0]!.clone.status).toBe("not-cloned");
    // Developer clones it mid-flight:
    workspace["config"].clones.push({
      path: "/ws/ledger",
      originRemote: "git@github.com:acme/ledger.git",
    });
    await scope.rescan();
    expect((await scope.declare(["ledger"]))[0]!.clone).toEqual({
      status: "cloned",
      path: "/ws/ledger",
    });
  });
});
```

> Note: the `workspace["config"]` poke mirrors a mid-flight clone; if `FakeWorkspace.config` is `private`, add a `addClone(c: DiscoveredClone)` helper to `FakeWorkspace` instead and call it here.

- [ ] **Step 2: Run test to verify it passes** (or fails if a helper is needed)

Run: `npx vitest run src/core/repo-scope.declare.test.ts`
Expected: PASS (3 tests). If the `config` access fails to compile, add `addClone` to `FakeWorkspace` and re-run.

- [ ] **Step 3: Commit**

```bash
git add src/core/repo-scope.declare.test.ts src/core/fakes/fake-workspace.ts
git commit -m "test: RepoScope.declare + rescan behaviour"
```

---

### Task A6: Real `CatalogPort` over `GitHubPort` — `GitHubCatalog`

**Files:**
- Modify: `src/core/ports/github.ts` (add `listOrgRepos`), `src/core/fakes/fake-github.ts`
- Create: `src/core/adapters/github-catalog.ts`
- Test: `src/core/adapters/github-catalog.test.ts`

- [ ] **Step 1: Add `listOrgRepos` to `GitHubPort`**

In `src/core/ports/github.ts`, add to the `GitHubPort` interface and a type:
```ts
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
```

- [ ] **Step 2: Implement `listOrgRepos` in `FakeGitHub`**

In `src/core/fakes/fake-github.ts`, add a constructor + method:
```ts
import type { /* existing */ OrgRepo } from "../ports/github.js";

export class FakeGitHub implements GitHubPort {
  readonly pushes: PushInput[] = [];
  readonly pullRequests: CreatePullRequestInput[] = [];
  constructor(private readonly orgRepos: OrgRepo[] = []) {}

  async listOrgRepos(): Promise<OrgRepo[]> {
    return this.orgRepos;
  }
  // …existing push / createPullRequest unchanged…
}
```

- [ ] **Step 3: Write the failing test**

`src/core/adapters/github-catalog.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { GitHubCatalog } from "./github-catalog.js";
import { FakeGitHub } from "../fakes/fake-github.js";

describe("GitHubCatalog", () => {
  it("projects org repos into catalog identities", async () => {
    const gh = new FakeGitHub([
      { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
      { name: "pipeline", remote: "git@github.com:acme/pipeline.git" },
    ]);
    const catalog = new GitHubCatalog(gh);
    expect(await catalog.listRepos()).toEqual([
      { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
      { name: "pipeline", remote: "git@github.com:acme/pipeline.git" },
    ]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/core/adapters/github-catalog.test.ts`
Expected: FAIL with "Cannot find module './github-catalog.js'".

- [ ] **Step 5: Implement `GitHubCatalog`**

`src/core/adapters/github-catalog.ts`:
```ts
import type { CatalogPort, RepoIdentity } from "../ports/catalog.js";
import type { GitHubPort } from "../ports/github.js";

/** Real catalog: the GitHub org's repos, projected into catalog identities (ADR-0006). */
export class GitHubCatalog implements CatalogPort {
  constructor(private readonly github: GitHubPort) {}
  async listRepos(): Promise<RepoIdentity[]> {
    const repos = await this.github.listOrgRepos();
    return repos.map((r) => ({ name: r.name, remote: r.remote }));
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/core/adapters/github-catalog.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/ports/github.ts src/core/fakes/fake-github.ts src/core/adapters/github-catalog.ts src/core/adapters/github-catalog.test.ts
git commit -m "feat: GitHubCatalog — CatalogPort over the GitHub org's repos"
```

---

### Task A7: Real `WorkspacePort` — `GitWorkspace` (scans dirs, reads `origin`), tested on temp repos

**Files:**
- Create: `src/core/adapters/git-workspace.ts`
- Test: `src/core/adapters/git-workspace.test.ts`

- [ ] **Step 1: Write the failing test (real git on a throwaway temp dir — per CLAUDE.md)**

`src/core/adapters/git-workspace.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitWorkspace } from "./git-workspace.js";

const run = promisify(execFile);
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dugout-ws-"));
  // A clone WITH an origin:
  const a = join(root, "widget-api");
  await mkdir(a);
  await run("git", ["init", "-q"], { cwd: a });
  await run("git", ["remote", "add", "origin", "git@github.com:acme/widget-api.git"], { cwd: a });
  // A plain dir that is NOT a git repo (must be skipped):
  await mkdir(join(root, "not-a-repo"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("GitWorkspace.discover", () => {
  it("finds git clones under a root and reads their origin remote", async () => {
    const ws = new GitWorkspace({ roots: [root] });
    const clones = await ws.discover([root]);
    const widget = clones.find((c) => c.path.endsWith("widget-api"));
    expect(widget?.originRemote).toBe("git@github.com:acme/widget-api.git");
    expect(clones.some((c) => c.path.endsWith("not-a-repo"))).toBe(false);
  });

  it("returns the configured roots", async () => {
    expect(await new GitWorkspace({ roots: [root] }).listRoots()).toEqual([root]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/adapters/git-workspace.test.ts`
Expected: FAIL with "Cannot find module './git-workspace.js'".

- [ ] **Step 3: Implement `GitWorkspace`**

`src/core/adapters/git-workspace.ts`:
```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspacePort, DiscoveredClone } from "../ports/workspace.js";

const run = promisify(execFile);

export interface GitWorkspaceConfig {
  /** Developer-chosen directories to scan (one level deep) for git clones. */
  roots: string[];
}

/**
 * Real workspace adapter: scans each root's immediate children for git working trees and reads
 * each one's `origin` remote. One level deep keeps the scan cheap; identity comes from the
 * remote, not the path, so no naming/nesting is enforced (CONTEXT.md "Workspace root").
 */
export class GitWorkspace implements WorkspacePort {
  constructor(private readonly config: GitWorkspaceConfig) {}

  async listRoots(): Promise<string[]> {
    return this.config.roots;
  }

  async discover(roots: string[]): Promise<DiscoveredClone[]> {
    const clones: DiscoveredClone[] = [];
    for (const root of roots) {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue; // unreadable root degrades to nothing, never throws (invariant 7)
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(root, entry.name);
        const origin = await this.readOrigin(path);
        if (origin !== null) clones.push({ path, originRemote: origin || undefined });
      }
    }
    return clones;
  }

  /** Returns the origin URL, "" for a git repo with no origin, or null if not a git repo. */
  private async readOrigin(path: string): Promise<string | null> {
    try {
      const { stdout } = await run("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);
      if (stdout.trim() !== "true") return null;
    } catch {
      return null;
    }
    try {
      const { stdout } = await run("git", ["-C", path, "remote", "get-url", "origin"]);
      return stdout.trim();
    } catch {
      return ""; // git repo, no origin
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/adapters/git-workspace.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all pre-existing tests still green (note `draft` signature is still `string[]` until Part C).

- [ ] **Step 6: Commit**

```bash
git add src/core/adapters/git-workspace.ts src/core/adapters/git-workspace.test.ts
git commit -m "feat: GitWorkspace — discover local clones + read origin remote (temp-repo tested)"
```

---

# Part B — Jira real adapter (API token)

### Task B1: `JiraReadAdapter` — list assigned tickets over REST (injected `fetch`)

**Files:**
- Create: `src/core/adapters/jira-read-adapter.ts`
- Test: `src/core/adapters/jira-read-adapter.test.ts`

- [ ] **Step 1: Write the failing test (no live Jira — inject a fake `fetch`)**

`src/core/adapters/jira-read-adapter.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { JiraReadAdapter } from "./jira-read-adapter.js";

function fakeFetch(captured: { url?: string; auth?: string }) {
  return async (url: string, init?: { headers?: Record<string, string> }) => {
    captured.url = url;
    captured.auth = init?.headers?.["Authorization"];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        issues: [
          { key: "DUG-7", fields: { summary: "Add timeline", description: "AC: returns 200" } },
        ],
      }),
    } as unknown as Response;
  };
}

describe("JiraReadAdapter.listAssignedTickets", () => {
  it("queries assignee=currentUser() and maps issues to tickets", async () => {
    const captured: { url?: string; auth?: string } = {};
    const jira = new JiraReadAdapter({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      token: "tok",
      fetch: fakeFetch(captured),
    });

    const tickets = await jira.listAssignedTickets();

    expect(tickets).toEqual([
      { key: "DUG-7", title: "Add timeline", description: "AC: returns 200" },
    ]);
    expect(captured.url).toContain("assignee%20%3D%20currentUser()".replace(/%20/g, "+") /* jql */);
    expect(captured.url).toContain("/rest/api/3/search");
    expect(captured.auth).toBe(`Basic ${Buffer.from("dev@acme.com:tok").toString("base64")}`);
  });

  it("throws a useful error on a non-ok response", async () => {
    const jira = new JiraReadAdapter({
      baseUrl: "https://acme.atlassian.net",
      email: "d@a.com",
      token: "bad",
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response,
    });
    await expect(jira.listAssignedTickets()).rejects.toThrow(/401/);
  });
});
```

> The JQL assertion is fiddly to match exactly; if it's brittle, assert `decodeURIComponent(captured.url!).includes("assignee = currentUser()")` instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/adapters/jira-read-adapter.test.ts`
Expected: FAIL with "Cannot find module './jira-read-adapter.js'".

- [ ] **Step 3: Implement `JiraReadAdapter`**

`src/core/adapters/jira-read-adapter.ts`:
```ts
import type { JiraPort, Ticket } from "../ports/jira.js";

export interface JiraReadConfig {
  /** e.g. "https://acme.atlassian.net". */
  baseUrl: string;
  /** The developer's Atlassian account email (the Basic-auth username). */
  email: string;
  /** The developer's personal API token (ADR-0005). Stored via safeStorage in main. */
  token: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

interface JiraIssue {
  key: string;
  fields: { summary: string; description?: string };
}

/**
 * Real Jira read adapter (ADR-0005): HTTP Basic with the developer's own API token, listing the
 * tickets assigned to them via JQL `assignee = currentUser()`. Read-only; Jira is a projection
 * (CONTEXT.md invariant 4). Tests inject `fetch`; no live Jira in tests (issue #3 AC).
 */
export class JiraReadAdapter implements JiraPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: JiraReadConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async listAssignedTickets(): Promise<Ticket[]> {
    const jql = encodeURIComponent("assignee = currentUser() ORDER BY updated DESC");
    const fields = "summary,description";
    const url = `${this.config.baseUrl}/rest/api/3/search?jql=${jql}&fields=${fields}`;
    const auth = Buffer.from(`${this.config.email}:${this.config.token}`).toString("base64");

    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Jira read failed: ${res.status}`);
    }
    const body = (await res.json()) as { issues: JiraIssue[] };
    return body.issues.map((i) => ({
      key: i.key,
      title: i.fields.summary,
      description: i.fields.description ?? "",
    }));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/adapters/jira-read-adapter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/jira-read-adapter.ts src/core/adapters/jira-read-adapter.test.ts
git commit -m "feat: JiraReadAdapter — assigned tickets via API token (ADR-0005)"
```

---

### Task B2: `safeStorage`-backed credential store (main process)

**Files:**
- Create: `src/main/jira-credentials.ts`
- Test: `src/main/jira-credentials.test.ts`

- [ ] **Step 1: Write the failing test (inject a fake safeStorage + a temp file)**

`src/main/jira-credentials.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraCredentialStore, type SafeStorageLike } from "./jira-credentials.js";

// Reversible "encryption" stand-in for safeStorage (real safeStorage is unavailable in vitest).
const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ""),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dugout-cred-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JiraCredentialStore", () => {
  it("round-trips credentials encrypted at rest", async () => {
    const store = new JiraCredentialStore(join(dir, "jira.cred"), fakeSafe);
    expect(await store.load()).toBeNull();
    await store.save({ baseUrl: "https://acme.atlassian.net", email: "d@a.com", token: "tok" });
    expect(await store.load()).toEqual({
      baseUrl: "https://acme.atlassian.net",
      email: "d@a.com",
      token: "tok",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/jira-credentials.test.ts`
Expected: FAIL with "Cannot find module './jira-credentials.js'".

- [ ] **Step 3: Implement `JiraCredentialStore`**

`src/main/jira-credentials.ts`:
```ts
import { readFile, writeFile } from "node:fs/promises";

/** The subset of Electron's safeStorage we use (injectable for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  token: string;
}

/**
 * Stores the developer's Jira API token encrypted at rest via Electron safeStorage (ADR-0005).
 * The token is the developer's own identity; it is never persisted as run-state or in git.
 */
export class JiraCredentialStore {
  constructor(
    private readonly file: string,
    private readonly safe: SafeStorageLike,
  ) {}

  async load(): Promise<JiraCredentials | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.file);
    } catch {
      return null;
    }
    const json = this.safe.decryptString(encrypted);
    return JSON.parse(json) as JiraCredentials;
  }

  async save(creds: JiraCredentials): Promise<void> {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error("OS encryption unavailable; cannot store Jira token securely");
    }
    const encrypted = this.safe.encryptString(JSON.stringify(creds));
    await writeFile(this.file, encrypted);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/jira-credentials.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/jira-credentials.ts src/main/jira-credentials.test.ts
git commit -m "feat: JiraCredentialStore — safeStorage-backed token store (ADR-0005)"
```

---

### Task B3: (Wiring deferred to Part C) — note only

Real-adapter selection (fake vs `JiraReadAdapter`) happens in `orchestrator-host.ts` in Task C4, gated on whether a credential file + `DUGOUT_JIRA=1` env exists, so dev/test keep the fake. No new test here.

---

# Part C — Orchestrator + IPC wiring (widen `draft` to `DeclaredRepo[]`)

### Task C1: `executor.draft` + `orchestrator.draftStory` take `DeclaredRepo[]`

**Files:**
- Modify: `src/core/ports/executor.ts`, `src/core/orchestrator.ts`, `src/core/test-harness.ts`
- Test: existing `src/core/orchestrator.draft.test.ts` (update), all green after.

- [ ] **Step 1: Update the draft test to pass `DeclaredRepo[]`**

In `src/core/orchestrator.draft.test.ts`, change the `draftStory` call:
```ts
import type { DeclaredRepo } from "./repo-scope.js";

const widget: DeclaredRepo = {
  identity: { name: "web", remote: "git@github.com:acme/web.git" },
  clone: { status: "cloned", path: "/ws/web" },
};
const story = await orchestrator.draftStory("DUG-1", { repos: [widget] });
```

- [ ] **Step 2: Run test to verify it fails (type error)**

Run: `npm run typecheck`
Expected: FAIL — `draftStory` still expects `{ repos: string[] }`.

- [ ] **Step 3: Widen `DraftInput.repos`**

In `src/core/ports/executor.ts`:
```ts
import type { Ticket } from "./jira.js";
import type { DeclaredRepo } from "../repo-scope.js";

export interface DraftInput {
  ticket: Ticket;
  /** Repos declared in scope by the developer, bound to local clones (ADR-0006). */
  repos: DeclaredRepo[];
}
```

- [ ] **Step 4: Update `draftStory` signature + pass-through**

In `src/core/orchestrator.ts`, change `draftStory`:
```ts
import type { DeclaredRepo } from "./repo-scope.js";

async draftStory(ticketKey: string, opts: { repos: DeclaredRepo[] }): Promise<Story> {
  const tickets = await this.deps.jira.listAssignedTickets();
  const ticket = tickets.find((t) => t.key === ticketKey);
  if (!ticket) {
    throw new Error(`Ticket ${ticketKey} is not assigned to this developer`);
  }
  const result = await this.deps.executor.draft({ ticket, repos: opts.repos });
  // …rest unchanged: result.specs[].repo is still a catalog NAME (string).
```

- [ ] **Step 5: Update `FakeExecutor` + `test-harness` + `draftAndApprove`**

`FakeExecutor.draft` already ignores its input (`_input: DraftInput`) — no change. In `src/core/test-harness.ts`, update `draftAndApprove` to accept `DeclaredRepo[]`:
```ts
import type { DeclaredRepo } from "./repo-scope.js";

export async function draftAndApprove(
  orchestrator: Orchestrator,
  repos: DeclaredRepo[],
  ticketKey = "DUG-1",
) {
  await orchestrator.draftStory(ticketKey, { repos });
  await orchestrator.approveStory(ticketKey, {});
}
```

- [ ] **Step 6: Update every caller of `draftStory`/`draftAndApprove` in tests**

Run: `grep -rn "draftStory\|draftAndApprove" src/core/*.test.ts`
For each call passing `["repo"]` or `{ repos: ["..."] }`, replace with a `DeclaredRepo` literal:
```ts
const declared = (name: string): DeclaredRepo => ({
  identity: { name, remote: `git@github.com:acme/${name}.git` },
  clone: { status: "cloned", path: `/ws/${name}` },
});
// e.g. draftAndApprove(orchestrator, [declared("web")])
```
Add that helper near the top of each affected test file (it's small; repeating it per file keeps tasks independent).

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — all tests green with the widened signature.

- [ ] **Step 8: Commit**

```bash
git add src/core/ports/executor.ts src/core/orchestrator.ts src/core/test-harness.ts src/core/*.test.ts
git commit -m "refactor: draft takes DeclaredRepo[] (was string[]) — ADR-0006"
```

---

### Task C2: Orchestrator exposes the repo-scope seam (`searchRepos`, `rescanRepos`, `listWorkspaceRoots`)

**Files:**
- Modify: `src/core/orchestrator.ts`
- Test: `src/core/orchestrator.repo-scope.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/orchestrator.repo-scope.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { RepoScope } from "./repo-scope.js";
import { FakeCatalog } from "./fakes/fake-catalog.js";
import { FakeWorkspace } from "./fakes/fake-workspace.js";
import { FakeJira } from "./fakes/fake-jira.js";
import { FakeExecutor } from "./fakes/fake-executor.js";
import { FakeGitHub } from "./fakes/fake-github.js";
import { FakeMetrics } from "./fakes/fake-metrics.js";
import { FakeEnvReplay } from "./fakes/fake-env-replay.js";

function orchestratorWithScope() {
  const repoScope = new RepoScope(
    new FakeCatalog([{ name: "widget-api", remote: "git@github.com:acme/widget-api.git" }]),
    new FakeWorkspace({
      roots: ["/ws"],
      clones: [{ path: "/ws/widget-api", originRemote: "git@github.com:acme/widget-api.git" }],
    }),
  );
  return new Orchestrator({
    jira: new FakeJira({ tickets: [] }),
    executor: new FakeExecutor({ draft: { specs: [] } }),
    github: new FakeGitHub(),
    metrics: new FakeMetrics(),
    envReplay: new FakeEnvReplay(),
    repoScope,
  });
}

describe("orchestrator repo-scope pass-through", () => {
  it("searches the catalog and binds clones", async () => {
    const matches = await orchestratorWithScope().searchRepos("widget");
    expect(matches[0]!.clone).toEqual({ status: "cloned", path: "/ws/widget-api" });
  });

  it("throws if no repoScope is configured", async () => {
    const o = orchestratorWithScope();
    (o as unknown as { deps: { repoScope?: unknown } }).deps.repoScope = undefined;
    await expect(o.searchRepos("x")).rejects.toThrow(/repo scope/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/orchestrator.repo-scope.test.ts`
Expected: FAIL — `OrchestratorDeps` has no `repoScope`; `searchRepos` undefined.

- [ ] **Step 3: Add `repoScope` dep + pass-through methods**

In `src/core/orchestrator.ts`, add to `OrchestratorDeps`:
```ts
import type { RepoScope, RepoMatch, DeclaredRepo } from "./repo-scope.js";

export interface OrchestratorDeps {
  // …existing five ports + specStore/store…
  /** Catalog + clone discovery for the declare-repos step (Part A). Optional in tests. */
  repoScope?: RepoScope;
}
```
And add public methods to the class:
```ts
private requireRepoScope(): RepoScope {
  if (!this.deps.repoScope) throw new Error("repo scope not configured");
  return this.deps.repoScope;
}
searchRepos(query: string): Promise<RepoMatch[]> {
  return this.requireRepoScope().search(query);
}
declareRepos(names: string[]): Promise<DeclaredRepo[]> {
  return this.requireRepoScope().declare(names);
}
rescanRepos(): Promise<void> {
  return this.requireRepoScope().rescan();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/orchestrator.repo-scope.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/orchestrator.ts src/core/orchestrator.repo-scope.test.ts
git commit -m "feat: orchestrator exposes repo-scope seam (search/declare/rescan)"
```

---

### Task C3: `DugoutApi` surface + preload + main IPC

**Files:**
- Modify: `src/shared/dugout-api.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/renderer/src/local-dugout-api.ts`

- [ ] **Step 1: Extend `CHANNELS` + `DugoutApi`**

In `src/shared/dugout-api.ts`:
```ts
import type { DeclaredRepo, RepoMatch } from "../core/repo-scope.js";

// add to CHANNELS:
  searchRepos: "dugout:searchRepos",
  rescanRepos: "dugout:rescanRepos",
  listWorkspaceRoots: "dugout:listWorkspaceRoots",

// in DugoutApi:
  /** Search the catalog; each match carries its clone binding. v1: local filter. */
  searchRepos(query: string): Promise<RepoMatch[]>;
  /** Re-scan workspace roots (after the dev clones something mid-flight). */
  rescanRepos(): Promise<void>;
  /** The developer's configured workspace roots (for display). */
  listWorkspaceRoots(): Promise<string[]>;
  // CHANGE the existing draft signature:
  draft(storyKey: string, repos: DeclaredRepo[]): Promise<Story>;
```

- [ ] **Step 2: Wire preload**

In `src/preload/index.ts`, add to the `api` object:
```ts
  draft: (key, repos) => ipcRenderer.invoke(CHANNELS.draft, key, repos), // unchanged call, new type
  searchRepos: (query) => ipcRenderer.invoke(CHANNELS.searchRepos, query),
  rescanRepos: () => ipcRenderer.invoke(CHANNELS.rescanRepos),
  listWorkspaceRoots: () => ipcRenderer.invoke(CHANNELS.listWorkspaceRoots),
```

- [ ] **Step 3: Register main IPC handlers**

In `src/main/index.ts` `registerIpc`, change the `draft` handler to pass `DeclaredRepo[]` and add three handlers:
```ts
import type { DeclaredRepo } from "../core/repo-scope.js";

ipcMain.handle(CHANNELS.draft, async (_e, key: string, repos: DeclaredRepo[]) => {
  const story = await orchestrator.draftStory(key, { repos });
  afterTransition(key, story.status);
  return story;
});
ipcMain.handle(CHANNELS.searchRepos, (_e, query: string) => orchestrator.searchRepos(query));
ipcMain.handle(CHANNELS.rescanRepos, () => orchestrator.rescanRepos());
ipcMain.handle(CHANNELS.listWorkspaceRoots, () => orchestrator.listWorkspaceRoots());
```
Add a tiny `listWorkspaceRoots` pass-through to the orchestrator (in `orchestrator.ts`):
```ts
listWorkspaceRoots(): Promise<string[]> {
  return this.requireRepoScope()["workspace"].listRoots();
}
```
> If reaching `["workspace"]` is awkward (it's private on `RepoScope`), add a public `roots()` method to `RepoScope` that returns `this.workspace.listRoots()` and call that instead.

- [ ] **Step 4: Implement the new methods in `local-dugout-api.ts`**

In `src/renderer/src/local-dugout-api.ts`, the `LocalSeed` gains a `RepoScope`, and the returned api implements the new methods + the widened `draft`:
```ts
import { RepoScope } from "../../core/repo-scope.js";
import type { DeclaredRepo, RepoMatch } from "../../core/repo-scope.js";

export interface LocalSeed {
  ticket: Ticket;
  draft: DraftResult;
  repoScope: RepoScope; // NEW
}
// pass repoScope into the Orchestrator deps, and add to the returned object:
  draft: async (key, repos: DeclaredRepo[]) => {
    const story = await orchestrator.draftStory(key, { repos });
    afterTransition(story);
    return story;
  },
  searchRepos: (query) => orchestrator.searchRepos(query),
  rescanRepos: () => orchestrator.rescanRepos(),
  listWorkspaceRoots: () => orchestrator.listWorkspaceRoots(),
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (The renderer `App.tsx` still references old `draft(string[])` — fixed in Part D; if typecheck fails only in `App.tsx`, that's expected and resolved in D1. To keep this task green, temporarily cast in `App.tsx` or proceed directly to D1 before running typecheck.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/dugout-api.ts src/preload/index.ts src/main/index.ts src/renderer/src/local-dugout-api.ts src/core/orchestrator.ts
git commit -m "feat: expose searchRepos/rescanRepos/listWorkspaceRoots over DugoutApi; draft takes DeclaredRepo[]"
```

---

### Task C4: Wire real adapters in `orchestrator-host.ts` (config-gated)

**Files:**
- Modify: `src/main/orchestrator-host.ts`

- [ ] **Step 1: Wire catalog + workspace + (optional) real Jira**

In `src/main/orchestrator-host.ts` `createOrchestrator`, add the seam and gate the real Jira adapter behind config so dev/test keep the fake:
```ts
import { RepoScope } from "../core/repo-scope.js";
import { GitHubCatalog } from "../core/adapters/github-catalog.js";
import { GitWorkspace } from "../core/adapters/git-workspace.js";
import { JiraReadAdapter } from "../core/adapters/jira-read-adapter.js";
import { JiraCredentialStore } from "./jira-credentials.js";
import { safeStorage } from "electron";
import type { JiraPort } from "../core/ports/jira.js";

export async function createOrchestrator(userDataDir: string): Promise<Orchestrator> {
  const github = new FakeGitHub([
    // v1 seed catalog until the real GitHub list adapter lands; swap for a real GitHubPort later.
    { name: "widget-api", remote: "git@github.com:acme/widget-api.git" },
    { name: "pipeline", remote: "git@github.com:acme/pipeline.git" },
  ]);

  // Real Jira only when the developer has saved credentials; otherwise the seed fake (dev/test).
  let jira: JiraPort = new FakeJira({ tickets: [SEED_TICKET] });
  const creds = await new JiraCredentialStore(
    join(userDataDir, "jira.cred"),
    safeStorage,
  ).load();
  if (creds) jira = new JiraReadAdapter(creds);

  const repoScope = new RepoScope(
    new GitHubCatalog(github),
    new GitWorkspace({ roots: [join(userDataDir, "..", "..")] /* TODO: real configured roots */ }),
  );

  return new Orchestrator({
    jira,
    executor: new FakeExecutor({ draft: SEED_DRAFT }),
    github,
    metrics: new MetricsForwarder(),
    envReplay: new FakeEnvReplay(),
    specStore: new InMemorySpecStore(),
    store: openRunStateStore(userDataDir),
    repoScope,
  });
}
```
> `createOrchestrator` is now `async`; update its caller in `src/main/index.ts` (`app.whenReady().then(async () => { const orchestrator = await createOrchestrator(...) })`). Workspace roots are stubbed (`TODO`) — a roots-config UI is out of scope for #3; the dev's roots default can be revisited.

- [ ] **Step 2: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/orchestrator-host.ts src/main/index.ts
git commit -m "feat: wire GitHubCatalog/GitWorkspace + config-gated real Jira in the host"
```

---

# Part D — UI (ticket-select + declare-repos)

> **STANDING RULE (CLAUDE.md):** all UI work MUST go through the `frontend-design` skill. Invoke `frontend-design` BEFORE writing or changing any component in this part. The steps below specify the *behaviour contract and tests*; the component code/styling is produced via `frontend-design`.

### Task D1: Ticket-selection view (replaces hardcoded `STORY_KEY`)

**Files:**
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/components.tsx`
- Test: `src/renderer/src/App.test.tsx`

- [ ] **Step 1: Invoke `frontend-design`** for the ticket list + selection UI (list of assigned tickets, select one to begin). Follow its output for the component.

- [ ] **Step 2: Write the failing jsdom test (drives the in-process api)**

Add to `src/renderer/src/App.test.tsx` a test that renders `App` with a `local-dugout-api` seeded with two tickets and asserts both render and selecting one shows its title. Use the existing test's harness pattern (the file already wires `createLocalDugoutApi`). Seed now requires a `RepoScope` (from `FakeCatalog`/`FakeWorkspace`).

```ts
// sketch — match the existing App.test.tsx style:
const api = createLocalDugoutApi({
  ticket: { key: "DUG-7", title: "Add timeline", description: "AC" },
  draft: SEED_DRAFT_OR_SMALL,
  repoScope: new RepoScope(new FakeCatalog([...]), new FakeWorkspace({ roots: [], clones: [] })),
});
// render <App/> within the DugoutProvider value={api}; assert ticket list shows "Add timeline".
```

- [ ] **Step 3: Run test to verify it fails**, then implement the selection state in `App.tsx` (replace `const STORY_KEY = "DUG-101"` with `selectedKey` state set from the ticket list; `onDraft` uses `selectedKey`).

Run: `npx vitest run src/renderer/src/App.test.tsx`
Expected: FAIL → (after implementing) PASS.

- [ ] **Step 4: Typecheck + test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components.tsx src/renderer/src/App.test.tsx
git commit -m "feat: ticket-selection view (frontend-design); drop hardcoded STORY_KEY"
```

---

### Task D2: Declare-repos view (searchable catalog, cloned/not-cloned/ambiguous badges)

**Files:**
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/components.tsx`
- Test: `src/renderer/src/App.test.tsx`

- [ ] **Step 1: Invoke `frontend-design`** for the declare-repos step: a search box (filter-as-you-type calling `dugout.searchRepos`), a result list with a badge per `CloneBinding` status (cloned / not cloned / ambiguous), multi-select, and a "Declare N repos" action that calls `dugout.draft(selectedKey, declaredRepos)`.

- [ ] **Step 2: Write the failing jsdom test**

Assert: typing "widget" filters results; a not-cloned repo shows the "not cloned" badge but is still selectable; clicking Declare calls `draft` with the selected `DeclaredRepo[]` and advances the story to `drafted`. Build the `DeclaredRepo[]` from `searchRepos` results in the component (don't reconstruct paths in the UI).

- [ ] **Step 3: Run → fail → implement → pass**

Run: `npx vitest run src/renderer/src/App.test.tsx`
Expected: PASS after wiring `searchRepos` + declare into `App.tsx` (replace `const DECLARED_REPOS = [...]`).

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components.tsx src/renderer/src/App.test.tsx
git commit -m "feat: declare-repos view — searchable catalog with clone-status badges (frontend-design)"
```

---

### Task D3: End-to-end verification in the real app

**Files:** none (manual + E2E).

- [ ] **Step 1: Run the app** (use the `run` skill) and confirm: assigned tickets list → select one → search the catalog → declare repos (note clone-status badges) → draft proceeds. With no saved Jira creds, the seed ticket appears (the fake), proving the flow without live Jira.

- [ ] **Step 2: Run the full suite + E2E**

Run: `npm test` (and the Playwright/Electron E2E if it runs locally: check `package.json` scripts)
Expected: PASS.

- [ ] **Step 3: Update issue #3 checkboxes** that are now satisfied, and open the PR:

```bash
git push -u origin feat/3-jira-read
gh pr create --repo cannycub/dugout --title "feat: Jira read — repo scope & ticket selection (#3)" \
  --body "Implements #3. See ADR-0004/0005/0006. Closes #3."
```

- [ ] **Step 4: Review** the branch with the `review` skill before requesting human review.

---

## Self-Review notes (author check)

- **Spec coverage vs issue #3 ACs:** assigned-ticket list → B1/D1; API-token auth → B1/B2/C4; select ticket → D1; searchable catalog declare (no suggestion) → A4/D2; local-clone resolution → A4/A7; feeds state machine → C1; tested through fakes → A3/A4/A5/B1 (and real git on temp repos → A7). ✅
- **Type consistency:** `RepoIdentity{name,remote}`, `DiscoveredClone{path,originRemote?}`, `CloneBinding` (cloned/not-cloned/ambiguous), `RepoMatch{identity,clone}`, `DeclaredRepo{identity,clone}`, `CatalogPort.listRepos`, `WorkspacePort.listRoots/discover`, `RepoScope.search/declare/rescan` — used identically across A→D. ✅
- **Known soft spots (flagged inline, not placeholders):** the JQL URL assertion in B1 (fallback assertion given); `FakeWorkspace.config` poke in A5 (helper fallback given); workspace-roots config is stubbed in C4 with a `TODO` (roots-config UI is explicitly out of scope for #3). These are real decisions, noted so the implementer isn't guessing.
```
