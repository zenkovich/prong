import { Platform } from 'react-native';
import { Commit, FileChange, Hunk, PullOptions, PushOptions, QueueItem, RepoAuth, RepoAuthInfo, RepoSnapshot, Sha, SavedSession, SubmoduleChanges, SyncPrefs } from './types';

/**
 * Everything the UI needs from a git engine. The HTTP implementation talks to the local
 * Prong server (`prong/server`), which shells out to git. A future native build keeps the
 * same interface and swaps the transport.
 */

export interface OpEvent {
  opId: string;
  label: string;
  /** broadcast by the engine: `ui-updated` the interface build changed, windows reload; `queue` a repository's
   * action queue changed (`repo`, `items`) */
  event?: 'ui-updated' | 'queue';
  repo?: string;
  items?: QueueItem[];
  line?: string;
  progress?: number | null;
  done?: boolean;
  error?: string;
}

export interface GhAccess {
  kind: 'app' | 'oauth' | 'pat' | 'unknown';
  installations: { account: string; slug: string; selection: string }[];
}

export interface AccountCheck {
  state: 'ok' | 'expired' | 'error';
  message?: string;
}

export interface KnownRepo {
  path: string;
  name: string;
  workspace: string;
  workspaces?: string[];
  lastOpened: number;
  pinned?: boolean;
  /** the branch it is on (read from its HEAD when listed; '' when detached or unknown) */
  branch?: string;
}

export interface OpState {
  kind: 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  /** the message git prepared for the commit that ends a merge, cherry-pick or revert */
  message?: string;
}

export interface Submodule {
  path: string;
  name: string;
  url: string;
  sha: string;
  state: 'ok' | 'uninitialized' | 'modified' | 'conflict';
  describe?: string;
  /** changes in its own files (edited, new), as the engine last read them */
  inside?: { modified: number; untracked: number };
}
export interface ServerWorkspace {
  id: string;
  name: string;
  rootPath?: string;
  scanDepth?: number;
}
export interface ScannedRepo {
  path: string;
  name: string;
  nested: boolean;
}
export interface ServerSettings {
  editor: string;
  terminal: string;
  diffTool: string;
  pullMode: 'merge' | 'rebase' | 'ff';
  /** after a checkout, pull, merge… the submodules whose recorded commit changed follow it */
  autoUpdateSubmodules?: boolean;
  signCommits: boolean;
  agent: { provider: 'anthropic-claude-code' | 'anthropic-api' | 'openai-compatible'; model: string; cliPath: string; sourcesPath: string; askBeforeApply: boolean; autoRollbackOnBuildError: boolean };
  githubClientId: string;
  avatars: boolean;
  ui: UiSettings;
}
export interface EngineHealth {
  ok: boolean;
  git: string;
  version: string;
  /** 'static': the engine serves the interface (desktop app); 'dev': a Metro dev server does */
  ui?: 'static' | 'dev';
  /** which interface the engine serves: the one built into the app, or the agent's latest build */
  uiBuild?: 'factory' | 'agent';
}
export interface AppVersionInfo {
  sha: string;
  n: number;
  title: string;
  prompt: string;
  time: number;
  files: { path: string; status: string; additions: number; deletions: number }[];
  status: 'applied' | 'reverted';
  revertSha?: string;
}
export interface BlobSide {
  rev: string;
  file: string;
  bytes: number;
  /** object id, or mtime+size for the working copy: part of the URL so a changed file is refetched */
  version: string;
  oid?: string;
}
export interface UiSettings {
  theme: string;
  uiScale: number;
  fileView: 'list' | 'tree';
  diffMode: 'unified' | 'split';
  sidebarWidth: number;
  submoduleView: 'list' | 'tree';
  commitAction: 'commit' | 'commit-push';
  commitBoxHeight: number;
  commitDescOpen: boolean;
  detailsHeaderHeight: number;
  detailsDescOpen: boolean;
  /** the share of the history's height the commit details take (the splitter under the commit list) */
  detailsRatio?: number;
  /** the Fetch / Pull / Push dialogs' remembered options */
  sync?: Partial<SyncPrefs>;
}
export interface SshKeyInfo {
  name: string;
  type: string;
  bits: number;
  fingerprint: string;
  comment: string;
  publicKey: string;
  inAgent: boolean;
  hasPassphrase: boolean | null;
}
export interface ServerAccount {
  id: string;
  host: string;
  login: string;
  name: string;
  avatar: string;
  orgs: string[];
}
export interface GhRepo {
  fullName: string;
  sshUrl: string;
  httpsUrl: string;
  private: boolean;
  pushedAt: string;
  description: string;
}

export interface RebaseTodoItem {
  sha: Sha;
  action: 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
  message?: string;
}

export interface GitClient {
  health(): Promise<EngineHealth>;
  /** Prong's own sources: agent versions (a shadow git log when the folder has none) and the interface build */
  appPrepare(sources: string): Promise<{ before: Record<string, string> }>;
  appRecord(sources: string, message: string, before: Record<string, string>): Promise<{ sha: string; files: string[] } | null>;
  appRevert(sources: string, sha: string): Promise<{ sha: string }>;
  appVersions(sources: string): Promise<AppVersionInfo[]>;
  /** the patch of one version */
  appDiff(sources: string, sha: string): Promise<{ diff: string }>;
  appRebuild(sources: string): Promise<{ opId: string | null; skipped?: string }>;
  appFactory(): Promise<void>;
  listRepos(): Promise<KnownRepo[]>;
  openRepo(path: string, workspace: string): Promise<KnownRepo>;
  forgetRepo(path: string): Promise<void>;
  /** `from`: the workspace it is taken out of (its scan stops listing it there) */
  moveRepo(path: string, workspace: string, from?: string): Promise<void>;
  pinRepo(path: string, pinned: boolean): Promise<void>;
  initRepo(path: string): Promise<{ path: string }>;
  /** `auth`: the connection to clone with (the clone is registered with it); not given: the folder's, else git's default */
  clone(url: string, dir: string, name: string | undefined, recursive: boolean, workspace: string, auth?: RepoAuth | null, partial?: boolean): Promise<{ opId: string; path: string }>;
  /** the connection the user's other repositories of that owner use (no network) */
  cloneHint(url: string): Promise<{ auth: RepoAuth; from: string } | null>;
  /** can the address be read with that connection? (read-only) */
  cloneTest(url: string, auth: RepoAuth | null): Promise<{ ok: boolean; output: string; describe: string }>;

  snapshot(path: string, limit?: number): Promise<RepoSnapshot & { op: OpState; timings?: Record<string, number> }>;
  snapshotCached(path: string): Promise<(RepoSnapshot & { op: OpState; stale: true }) | null>;
  status(path: string): Promise<{ unstaged: FileChange[]; staged: FileChange[] }>;
  commitFiles(path: string, sha: Sha): Promise<FileChange[]>;
  /** one file of a commit or stash (`rev` = sha or "stash@{n}") whose diff was not sent with the list */
  commitFileDiff(path: string, rev: string, file: string, oldPath?: string, force?: boolean, context?: number): Promise<FileChange | null>;
  /** the log from `skip` down to `sha` plus `after` more, in one pass; index -1 when it is deeper than `max` */
  logUntil(path: string, sha: Sha, skip: number, after: number, revs?: string[], max?: number): Promise<{ index: number; commits: Commit[] }>;
  /** position of a commit in the date-ordered log of `revs` (-1: not among the first `max`) */
  logPosition(path: string, sha: Sha, revs?: string[], max?: number): Promise<number>;
  stashFiles(path: string, index: number): Promise<FileChange[]>;
  fileDiff(path: string, file: string, area: 'unstaged' | 'staged', force?: boolean, context?: number): Promise<FileChange | null>;
  /** where both sides of a change live (no content); `area` is a working-copy area, a commit sha or a stash ref */
  mediaSides(path: string, file: string, area: string, oldPath?: string): Promise<{ before?: BlobSide; after?: BlobSide }>;
  /** URL of a file's content at a revision (WORKTREE, :0 or any rev), served with byte ranges */
  blobUrl(repo: string, rev: string, file: string, version?: string): string;
  /** a file on disk with that content (the working copy, or the blob extracted into the engine's cache) */
  blobFile(path: string, rev: string, file: string): Promise<{ path: string; bytes: number }>;
  /** OS icon for a file extension, served by the engine */
  fileIconUrl(ext: string): string;
  /** stops a running long operation (the agent) */
  cancelOp(opId: string): Promise<void>;
  /** URL of an author's avatar served (and cached) by the engine */
  avatarUrl(email: string): string;

  stage(path: string, paths: string[]): Promise<void>;
  stageAll(path: string): Promise<void>;
  unstage(path: string, paths: string[]): Promise<void>;
  unstageAll(path: string): Promise<void>;
  /** `undo`: the engine kept copies of what was discarded (undoDiscard puts them back); null when too large */
  /** `kept`: repositories of their own among the paths, which a discard leaves alone */
  discard(path: string, paths: string[]): Promise<{ undo: string | null; kept?: string[] }>;
  discardAll(path: string): Promise<{ undo: string | null }>;
  undoDiscard(path: string, token: string): Promise<{ restored: number }>;
  /** the index as a tree (null while files are in conflict), and back */
  writeTree(path: string): Promise<string | null>;
  readTree(path: string, tree: string): Promise<void>;
  /** a deleted branch or tag back at its object (only when nothing of that name exists) */
  restoreRef(path: string, ref: string, sha: string): Promise<void>;
  /** removes a branch or tag only while it still points at `sha` */
  deleteRefAt(path: string, ref: string, sha: string): Promise<void>;
  stashPopCommit(path: string, sha: string): Promise<void>;
  stashStore(path: string, sha: string, message: string): Promise<void>;
  /** submodules whose recorded commit differs between two commits, and whether each may follow */
  changedSubmodules(path: string, from: Sha, to: Sha): Promise<{ path: string; from: string; to: string; initialized: boolean; inSync: boolean }[]>;
  stageHunk(path: string, file: FileChange, hunk: Hunk): Promise<void>;
  unstageHunk(path: string, file: FileChange, hunk: Hunk): Promise<void>;
  discardHunk(path: string, file: FileChange, hunk: Hunk): Promise<{ undo: string | null }>;
  resolveConflict(path: string, file: string, take: 'ours' | 'theirs' | 'both'): Promise<void>;
  commit(path: string, message: string, amend: boolean): Promise<{ sha: Sha }>;

  fetch(path: string, remote?: string, prune?: boolean, tags?: boolean): Promise<{ opId: string }>;
  /** completes a shallow clone (`fetch --unshallow`); `allBranches` also widens a single-branch clone */
  unshallow(path: string, opts?: { remote?: string; allBranches?: boolean }): Promise<{ opId: string }>;
  /** widens a narrow (`--single-branch`) clone: follow every branch of the remote, then fetch */
  followAllBranches(path: string, remote?: string): Promise<{ opId: string }>;
  pull(path: string, strategy: 'merge' | 'rebase' | 'ff', opts?: Omit<PullOptions, 'strategy'>): Promise<{ opId: string }>;
  push(path: string, opts: PushOptions): Promise<{ opId: string }>;

  checkout(path: string, ref: string): Promise<void>;
  /** stash the local changes, check out (`start`: create `ref` from there), reapply them */
  checkoutWithStash(path: string, ref: string, start?: string): Promise<{ stashed: boolean; reapplied: boolean; output: string }>;
  /** a lock file another git process left behind (refused while it still changes) */
  removeLock(path: string, lock: string): Promise<{ removed: boolean }>;
  /** the action queues that have something in them, by repository path */
  queues(): Promise<Record<string, QueueItem[]>>;
  cancelQueued(id: number): Promise<boolean>;
  /** the name it got: on a case-insensitive disk an existing folder keeps its spelling (`Tmp/x` → `tmp/x`) */
  createBranch(path: string, name: string, start: string, checkout: boolean): Promise<{ name: string }>;
  deleteBranch(path: string, name: string, force: boolean, remote?: string): Promise<void>;
  deleteRemoteBranch(path: string, remote: string, branch: string): Promise<void>;
  renameBranch(path: string, oldName: string, newName: string): Promise<{ name: string }>;
  createTag(path: string, name: string, sha: string, message?: string): Promise<void>;
  deleteTag(path: string, name: string): Promise<{ sha: string }>;
  merge(path: string, source: string, opts: { noFf?: boolean; squash?: boolean }): Promise<{ conflicts: boolean }>;
  rebase(path: string, onto: string, opts: { preserveMerges?: boolean; autostash?: boolean }): Promise<{ conflicts: boolean }>;
  rebaseInteractive(path: string, onto: string, todo: RebaseTodoItem[], opts?: { autostash?: boolean }): Promise<{ conflicts: boolean }>;
  rebaseContinue(path: string): Promise<void>;
  rebaseAbort(path: string): Promise<void>;
  mergeAbort(path: string): Promise<void>;
  /** goes on with whichever of merge, rebase, cherry-pick and revert is in progress */
  continueOp(path: string): Promise<{ kind: string; conflicts: boolean }>;
  cherryPick(path: string, sha: Sha): Promise<{ conflicts: boolean }>;
  revert(path: string, sha: Sha): Promise<{ conflicts: boolean }>;
  reset(path: string, sha: Sha, mode: 'soft' | 'mixed' | 'hard' | 'keep'): Promise<void>;
  /** the new stash's commit (null: nothing to stash) */
  stashPush(path: string, message: string, keepIndex: boolean, includeUntracked: boolean): Promise<{ sha: string | null }>;
  stashApply(path: string, index: number, pop: boolean): Promise<void>;
  stashDrop(path: string, index: number): Promise<{ sha: string; message: string }>;
  /** a new branch at the stash's commit with the stash applied (`git stash branch`) */
  stashBranch(path: string, name: string, index: number): Promise<{ name: string }>;

  logPage(path: string, skip: number, limit: number, revs?: string[]): Promise<Commit[]>;
  /** history of a file (renames followed), from HEAD or from the commit `from` */
  logFile(path: string, file: string, limit?: number, from?: Sha): Promise<Commit[]>;
  /** commits of the whole history (of `revs`) matching `q`: message, author, e-mail, id prefix */
  searchLog(path: string, q: string, revs?: string[], limit?: number): Promise<{ commits: Commit[]; scanned: number; more: boolean }>;
  fileAt(path: string, rev: string, file: string): Promise<string | null>;
  /** blame of the working copy, or of the file in commit `rev` */
  blame(path: string, file: string, rev?: Sha): Promise<{ sha: string; author: string; date: number; line: string }[]>;
  submodules(path: string): Promise<Submodule[]>;
  /** the submodules with changes in their own files (read a few at a time; a read a moment ago is reused) */
  submoduleChanges(path: string): Promise<SubmoduleChanges[]>;
  submoduleUpdate(path: string, paths?: string[], recursive?: boolean): Promise<{ opId: string }>;
  submoduleSync(path: string): Promise<void>;
  submoduleCommits(path: string, sub: string, shas: string[]): Promise<Record<string, string>>;
  /** the submodule's commits between two pointers, pointers its clone lacks, whether it is checked out */
  submoduleRange(path: string, sub: string, before: string, after: string, limit?: number): Promise<{ added: Commit[]; removed: Commit[]; missing: string[]; uninitialized: boolean; more: boolean }>;
  addRemote(path: string, name: string, url: string): Promise<void>;
  setRemoteUrl(path: string, name: string, url: string): Promise<void>;
  renameRemote(path: string, oldName: string, newName: string): Promise<void>;
  removeRemote(path: string, name: string): Promise<void>;
  pruneRemote(path: string, name: string): Promise<{ output: string }>;
  pushTag(path: string, tag: string, remote?: string): Promise<{ opId: string }>;
  checkoutDetached(path: string, sha: string): Promise<void>;
  setUpstream(path: string, branch: string, upstream: string): Promise<void>;
  appendIgnore(path: string, pattern: string): Promise<void>;
  config(path: string, key: string): Promise<string | null>;
  setConfig(path: string, key: string, value: string): Promise<void>;
  globalConfig(path: string, key: string): Promise<string | null>;
  setGlobalConfig(path: string, key: string, value: string): Promise<void>;

  workspaces(): Promise<ServerWorkspace[]>;
  /** several branches at once; each failure comes back with git's reason */
  deleteBranches(path: string, names: string[], force: boolean, withRemote: boolean): Promise<BatchResult>;
  deleteRemoteBranches(path: string, refs: string[]): Promise<BatchResult>;
  pushBranches(path: string, names: string[], remote: string): Promise<{ opId: string }>;
  /** a repository's connection: its own setting, the inherited one, a read-only test against a remote */
  authInfo(path: string): Promise<RepoAuthInfo>;
  setAuth(path: string, auth: RepoAuth | null): Promise<unknown>;
  testAuth(path: string, remote: string, auth?: RepoAuth | null): Promise<{ ok: boolean; output: string; describe: string }>;
  /** tabs and branch filters saved for the next launch */
  loadSession(): Promise<SavedSession>;
  saveSession(s: SavedSession): Promise<unknown>;
  saveWorkspaces(list: ServerWorkspace[]): Promise<ServerWorkspace[]>;
  settings(): Promise<ServerSettings>;
  saveSettings(patch: Partial<ServerSettings>): Promise<ServerSettings>;
  scan(path: string, depth: number, register?: { workspace: string }): Promise<ScannedRepo[]>;
  systemOpen(path: string, app: string): Promise<void>;
  systemReveal(path: string): Promise<void>;
  systemTerminal(path: string, app?: string): Promise<void>;
  sshKeys(): Promise<SshKeyInfo[]>;
  sshGenerate(name: string, type: 'ed25519' | 'rsa' | 'ecdsa', passphrase: string, comment: string): Promise<{ file: string }>;
  sshAgentAdd(name: string): Promise<void>;
  sshTest(host: string): Promise<{ opId: string }>;
  accounts(): Promise<ServerAccount[]>;
  addAccount(host: string, token: string): Promise<ServerAccount>;
  removeAccount(id: string): Promise<void>;
  githubRepos(accountId: string, page?: number): Promise<GhRepo[]>;
  /** what the account's sign-in can see: its kind, and (a GitHub App) where the app is installed */
  githubAccess(accountId: string): Promise<GhAccess>;
  githubAddKey(accountId: string, title: string, key: string): Promise<{ id: number }>;
  githubDeviceStart(clientId: string, host?: string): Promise<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>;
  githubDevicePoll(clientId: string, deviceCode: string, host?: string): Promise<{ done: boolean; account?: ServerAccount; error?: string }>;
  agentCheck(): Promise<{ ok: boolean; path: string | null; version: string }>;
  /** `resume`: the Claude Code session to continue (a follow-up in the same chat and folder) */
  agentRun(prompt: string, cwd: string, mode: 'repo' | 'app', apply?: boolean, resume?: string): Promise<{ opId: string }>;

  /** subscribe to progress events of long operations; returns unsubscribe */
  /** `onConnection`: the event stream dropped (the engine stopped) or came back */
  events(listener: (e: OpEvent) => void, onConnection?: (up: boolean) => void): () => void;
}

/** Inside the desktop shell the UI is served by the engine itself, so the API lives at the page origin. */
/**
 * Engine base URL: an explicit `window.__PRONG_SERVER__` (tests, custom setups) wins; inside Prong.app the
 * page is served by the engine itself; the web dev server talks to the default engine port.
 */
export const DEFAULT_SERVER =
  typeof window !== 'undefined' && typeof (window as any).__PRONG_SERVER__ === 'string'
    ? String((window as any).__PRONG_SERVER__)
    : typeof window !== 'undefined' && (window as any).__PRONG_DESKTOP__ && typeof location !== 'undefined'
      ? location.origin
      : 'http://127.0.0.1:8790';

/** what a batch operation did */
export interface BatchResult {
  done: string[];
  failed: { name: string; error: string }[];
}

export class HttpGitClient implements GitClient {
  constructor(public baseUrl = DEFAULT_SERVER) {}

  private async post<T>(route: string, body: unknown): Promise<T> {
    const r = await fetch(`${this.baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error ?? `${route} failed (${r.status})`);
    return data as T;
  }
  private op<T>(name: string, path: string, args: Record<string, unknown> = {}) {
    return this.post<T>(`/api/repo/${name}`, { path, ...args });
  }

  async health(): Promise<EngineHealth> {
    const r = await fetch(`${this.baseUrl}/api/health`);
    return (await r.json()) as EngineHealth;
  }
  appPrepare(sources: string) {
    return this.post<{ before: Record<string, string> }>('/api/app/prepare', { sources });
  }
  appRecord(sources: string, message: string, before: Record<string, string>) {
    return this.post<{ sha: string; files: string[] } | null>('/api/app/record', { sources, message, before });
  }
  appRevert(sources: string, sha: string) {
    return this.post<{ sha: string }>('/api/app/revert', { sources, sha });
  }
  appVersions(sources: string) {
    return this.post<AppVersionInfo[]>('/api/app/versions', { sources });
  }
  appDiff(sources: string, sha: string) {
    return this.post<{ diff: string }>('/api/app/diff', { sources, sha });
  }
  appRebuild(sources: string) {
    return this.post<{ opId: string | null; skipped?: string }>('/api/app/rebuild', { sources });
  }
  async appFactory() {
    await this.post('/api/app/factory', {});
  }
  /** whether each account's sign-in still works ('expired': only signing in again helps) */
  checkAccounts() {
    return this.get<Record<string, AccountCheck>>('/api/accounts/check');
  }
  async listRepos(): Promise<KnownRepo[]> {
    const r = await fetch(`${this.baseUrl}/api/repos`);
    return (await r.json()) as KnownRepo[];
  }
  openRepo(path: string, workspace: string) {
    return this.post<KnownRepo>('/api/repos/open', { path, workspace });
  }
  async moveRepo(path: string, workspace: string, from?: string) {
    await this.post('/api/repos/move', { path, workspace, from });
  }
  async pinRepo(path: string, pinned: boolean) {
    await this.post('/api/repos/pin', { path, pinned });
  }
  async forgetRepo(path: string) {
    await this.post('/api/repos/forget', { path });
  }
  initRepo(path: string) {
    return this.post<{ path: string }>('/api/repos/init', { path });
  }
  clone(url: string, dir: string, name: string | undefined, recursive: boolean, workspace: string, auth?: RepoAuth | null, partial = false) {
    return this.post<{ opId: string; path: string }>('/api/repos/clone', { url, dir, name, recursive, workspace, partial, ...(auth !== undefined ? { auth } : {}) });
  }
  cloneHint(url: string) {
    return this.post<{ auth: RepoAuth; from: string } | null>('/api/repos/cloneHint', { url });
  }
  cloneTest(url: string, auth: RepoAuth | null) {
    return this.post<{ ok: boolean; output: string; describe: string }>('/api/repos/cloneTest', { url, auth });
  }

  snapshot(path: string, limit = 300) {
    return this.op<RepoSnapshot & { op: OpState; timings?: Record<string, number> }>('snapshot', path, { limit });
  }
  snapshotCached(path: string) {
    return this.op<(RepoSnapshot & { op: OpState; stale: true }) | null>('snapshotCached', path);
  }
  status(path: string) {
    return this.op<{ unstaged: FileChange[]; staged: FileChange[] }>('status', path);
  }
  commitFiles(path: string, sha: Sha) {
    return this.op<FileChange[]>('commitFiles', path, { sha });
  }
  commitFileDiff(path: string, rev: string, file: string, oldPath?: string, force = false, context?: number) {
    return this.op<FileChange | null>('commitFileDiff', path, { rev, file, oldPath, force, context });
  }
  logUntil(path: string, sha: Sha, skip: number, after: number, revs?: string[], max?: number) {
    return this.op<{ index: number; commits: Commit[] }>('logUntil', path, { sha, skip, after, revs, max });
  }
  logPosition(path: string, sha: Sha, revs?: string[], max?: number) {
    return this.op<number>('logPosition', path, { sha, revs, max });
  }
  stashFiles(path: string, index: number) {
    return this.op<FileChange[]>('stashFiles', path, { index });
  }
  fileDiff(path: string, file: string, area: 'unstaged' | 'staged', force = false, context?: number) {
    return this.op<FileChange | null>('fileDiff', path, { file, area, force, context });
  }
  mediaSides(path: string, file: string, area: string, oldPath?: string) {
    return this.op<{ before?: BlobSide; after?: BlobSide }>('mediaSides', path, { file, area, oldPath });
  }
  blobUrl(repo: string, rev: string, file: string, version?: string) {
    const q = new URLSearchParams({ repo, rev, file, ...(version ? { v: version } : {}) });
    return `${this.baseUrl}/api/blob?${q.toString()}`;
  }
  blobFile(path: string, rev: string, file: string) {
    return this.op<{ path: string; bytes: number }>('blobFile', path, { rev, file });
  }
  fileIconUrl(ext: string) {
    return `${this.baseUrl}/api/fileicon?ext=${encodeURIComponent(ext)}`;
  }
  async cancelOp(opId: string) {
    await this.post('/api/ops/cancel', { opId });
  }
  avatarUrl(email: string) {
    return `${this.baseUrl}/api/avatar?email=${encodeURIComponent(email.trim().toLowerCase())}`;
  }
  async stage(path: string, paths: string[]) {
    await this.op('stage', path, { paths });
  }
  async stageAll(path: string) {
    await this.op('stageAll', path);
  }
  async unstage(path: string, paths: string[]) {
    await this.op('unstage', path, { paths });
  }
  async unstageAll(path: string) {
    await this.op('unstageAll', path);
  }
  discard(path: string, paths: string[]) {
    return this.op<{ undo: string | null; kept?: string[] }>('discard', path, { paths });
  }
  discardAll(path: string) {
    return this.op<{ undo: string | null }>('discardAll', path);
  }
  undoDiscard(path: string, token: string) {
    return this.op<{ restored: number }>('undoDiscard', path, { token });
  }
  async writeTree(path: string) {
    return (await this.op<{ tree: string | null }>('writeTree', path)).tree;
  }
  async readTree(path: string, tree: string) {
    await this.op('readTree', path, { tree });
  }
  async restoreRef(path: string, ref: string, sha: string) {
    await this.op('restoreRef', path, { ref, sha });
  }
  async deleteRefAt(path: string, ref: string, sha: string) {
    await this.op('deleteRefAt', path, { ref, sha });
  }
  async stashPopCommit(path: string, sha: string) {
    await this.op('stashPopCommit', path, { sha });
  }
  async stashStore(path: string, sha: string, message: string) {
    await this.op('stashStore', path, { sha, message });
  }
  changedSubmodules(path: string, from: Sha, to: Sha) {
    return this.op<{ path: string; from: string; to: string; initialized: boolean; inSync: boolean }[]>('changedSubmodules', path, { from, to });
  }
  async stageHunk(path: string, file: FileChange, hunk: Hunk) {
    await this.op('stageHunk', path, { file: slim(file), hunk });
  }
  async unstageHunk(path: string, file: FileChange, hunk: Hunk) {
    await this.op('unstageHunk', path, { file: slim(file), hunk });
  }
  discardHunk(path: string, file: FileChange, hunk: Hunk) {
    return this.op<{ undo: string | null }>('discardHunk', path, { file: slim(file), hunk });
  }
  async resolveConflict(path: string, file: string, take: 'ours' | 'theirs' | 'both') {
    await this.op('resolveConflict', path, { file, take });
  }
  commit(path: string, message: string, amend: boolean) {
    return this.op<{ sha: Sha }>('commit', path, { message, amend });
  }
  fetch(path: string, remote?: string, prune = true, tags = false) {
    return this.op<{ opId: string }>('fetch', path, { remote, prune, tags });
  }
  unshallow(path: string, opts: { remote?: string; allBranches?: boolean } = {}) {
    return this.op<{ opId: string }>('unshallow', path, opts);
  }
  followAllBranches(path: string, remote?: string) {
    return this.op<{ opId: string }>('followAllBranches', path, { remote });
  }
  pull(path: string, strategy: 'merge' | 'rebase' | 'ff', opts: Omit<PullOptions, 'strategy'> = {}) {
    return this.op<{ opId: string }>('pull', path, { strategy, ...opts });
  }
  push(path: string, opts: PushOptions) {
    return this.op<{ opId: string }>('push', path, { ...opts });
  }
  async checkout(path: string, ref: string) {
    await this.op('checkout', path, { ref });
  }
  checkoutWithStash(path: string, ref: string, start?: string) {
    return this.op<{ stashed: boolean; reapplied: boolean; output: string }>('checkoutWithStash', path, { ref, start });
  }
  removeLock(path: string, lock: string) {
    return this.op<{ removed: boolean }>('removeLock', path, { lock });
  }
  queues() {
    return this.get<Record<string, QueueItem[]>>('/api/queue');
  }
  async cancelQueued(id: number) {
    return (await this.post<{ cancelled: boolean }>('/api/queue/cancel', { id })).cancelled;
  }
  createBranch(path: string, name: string, start: string, checkout: boolean) {
    return this.op<{ name: string }>('createBranch', path, { name, start, checkout });
  }
  async deleteRemoteBranch(path: string, remote: string, branch: string) {
    await this.op('deleteRemoteBranch', path, { remote, branch });
  }
  async deleteBranch(path: string, name: string, force: boolean, remote?: string) {
    await this.op('deleteBranch', path, { name, force, remote });
  }
  renameBranch(path: string, oldName: string, newName: string) {
    return this.op<{ name: string }>('renameBranch', path, { oldName, newName });
  }
  async createTag(path: string, name: string, sha: string, message?: string) {
    await this.op('createTag', path, { name, sha, message });
  }
  deleteTag(path: string, name: string) {
    return this.op<{ sha: string }>('deleteTag', path, { name });
  }
  merge(path: string, source: string, opts: { noFf?: boolean; squash?: boolean }) {
    return this.op<{ conflicts: boolean }>('merge', path, { source, ...opts });
  }
  rebase(path: string, onto: string, opts: { preserveMerges?: boolean; autostash?: boolean }) {
    return this.op<{ conflicts: boolean }>('rebase', path, { onto, ...opts });
  }
  rebaseInteractive(path: string, onto: string, todo: RebaseTodoItem[], opts: { autostash?: boolean } = {}) {
    return this.op<{ conflicts: boolean }>('rebaseInteractive', path, { onto, todo, ...opts });
  }
  async rebaseContinue(path: string) {
    await this.op('rebaseContinue', path);
  }
  async rebaseAbort(path: string) {
    await this.op('rebaseAbort', path);
  }
  continueOp(path: string) {
    return this.op<{ kind: string; conflicts: boolean }>('continueOp', path);
  }
  async mergeAbort(path: string) {
    await this.op('mergeAbort', path);
  }
  cherryPick(path: string, sha: Sha) {
    return this.op<{ conflicts: boolean }>('cherryPick', path, { sha });
  }
  revert(path: string, sha: Sha) {
    return this.op<{ conflicts: boolean }>('revert', path, { sha });
  }
  async reset(path: string, sha: Sha, mode: 'soft' | 'mixed' | 'hard' | 'keep') {
    await this.op('reset', path, { sha, mode });
  }
  stashPush(path: string, message: string, keepIndex: boolean, includeUntracked: boolean) {
    return this.op<{ sha: string | null }>('stashPush', path, { message, keepIndex, includeUntracked });
  }
  async stashApply(path: string, index: number, pop: boolean) {
    await this.op('stashApply', path, { index, pop });
  }
  stashBranch(path: string, name: string, index: number) {
    return this.op<{ name: string }>('stashBranch', path, { name, index });
  }
  stashDrop(path: string, index: number) {
    return this.op<{ sha: string; message: string }>('stashDrop', path, { index });
  }
  logPage(path: string, skip: number, limit: number, revs?: string[]) {
    return this.op<Commit[]>('logPage', path, { skip, limit, revs });
  }
  logFile(path: string, file: string, limit = 200, from?: Sha) {
    return this.op<Commit[]>('logFile', path, { file, limit, from });
  }
  searchLog(path: string, q: string, revs?: string[], limit = 300) {
    return this.op<{ commits: Commit[]; scanned: number; more: boolean }>('searchLog', path, { q, revs, limit });
  }
  async fileAt(path: string, rev: string, file: string) {
    return (await this.op<{ content: string | null }>('fileAt', path, { rev, file })).content;
  }
  blame(path: string, file: string, rev?: Sha) {
    return this.op<{ sha: string; author: string; date: number; line: string }[]>('blame', path, { file, rev });
  }
  submodules(path: string) {
    return this.op<Submodule[]>('submodules', path);
  }
  submoduleChanges(path: string) {
    return this.op<SubmoduleChanges[]>('submoduleChanges', path);
  }
  submoduleUpdate(path: string, paths?: string[], recursive = false) {
    return this.op<{ opId: string }>('submoduleUpdate', path, { paths, recursive });
  }
  async submoduleSync(path: string) {
    await this.op('submoduleSync', path);
  }
  submoduleRange(path: string, sub: string, before: string, after: string, limit?: number) {
    return this.op<{ added: Commit[]; removed: Commit[]; missing: string[]; uninitialized: boolean; more: boolean }>('submoduleRange', path, { sub, before, after, limit });
  }
  submoduleCommits(path: string, sub: string, shas: string[]) {
    return this.op<Record<string, string>>('submoduleCommits', path, { sub, shas });
  }
  async addRemote(path: string, name: string, url: string) {
    await this.op('addRemote', path, { name, url });
  }
  async setRemoteUrl(path: string, name: string, url: string) {
    await this.op('setRemoteUrl', path, { name, url });
  }
  async renameRemote(path: string, oldName: string, newName: string) {
    await this.op('renameRemote', path, { oldName, newName });
  }
  async removeRemote(path: string, name: string) {
    await this.op('removeRemote', path, { name });
  }
  pruneRemote(path: string, name: string) {
    return this.op<{ output: string }>('pruneRemote', path, { name });
  }
  pushTag(path: string, tag: string, remote = 'origin') {
    return this.op<{ opId: string }>('pushTag', path, { tag, remote });
  }
  async checkoutDetached(path: string, sha: string) {
    await this.op('checkoutDetached', path, { sha });
  }
  async setUpstream(path: string, branch: string, upstream: string) {
    await this.op('setUpstream', path, { branch, upstream });
  }
  async appendIgnore(path: string, pattern: string) {
    await this.op('appendIgnore', path, { pattern });
  }
  async config(path: string, key: string) {
    return (await this.op<{ value: string | null }>('config', path, { key })).value;
  }
  async setConfig(path: string, key: string, value: string) {
    await this.op('setConfig', path, { key, value });
  }
  async globalConfig(path: string, key: string) {
    return (await this.op<{ value: string | null }>('globalConfig', path, { key })).value;
  }
  async setGlobalConfig(path: string, key: string, value: string) {
    await this.op('setGlobalConfig', path, { key, value });
  }

  private async get<T>(route: string): Promise<T> {
    const r = await fetch(`${this.baseUrl}${route}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error ?? `${route} failed (${r.status})`);
    return data as T;
  }
  private async send<T>(method: string, route: string, body: unknown): Promise<T> {
    const r = await fetch(`${this.baseUrl}${route}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error ?? `${route} failed (${r.status})`);
    return data as T;
  }
  workspaces() {
    return this.get<ServerWorkspace[]>('/api/workspaces');
  }
  deleteBranches(path: string, names: string[], force: boolean, withRemote: boolean) {
    return this.op<BatchResult>('deleteBranches', path, { names, force, withRemote });
  }
  deleteRemoteBranches(path: string, refs: string[]) {
    return this.op<BatchResult>('deleteRemoteBranches', path, { refs });
  }
  pushBranches(path: string, names: string[], remote: string) {
    return this.op<{ opId: string }>('pushBranches', path, { names, remote });
  }
  authInfo(path: string) {
    return this.op<RepoAuthInfo>('authInfo', path);
  }
  setAuth(path: string, auth: RepoAuth | null) {
    return this.op<unknown>('setAuth', path, { auth });
  }
  testAuth(path: string, remote: string, auth?: RepoAuth | null) {
    return this.op<{ ok: boolean; output: string; describe: string }>('testAuth', path, auth === undefined ? { remote } : { remote, auth });
  }
  loadSession() {
    return this.get<SavedSession>('/api/session');
  }
  saveSession(s: SavedSession) {
    return this.send<unknown>('PUT', '/api/session', s);
  }
  saveWorkspaces(list: ServerWorkspace[]) {
    return this.send<ServerWorkspace[]>('PUT', '/api/workspaces', list);
  }
  settings() {
    return this.get<ServerSettings>('/api/settings');
  }
  saveSettings(patch: Partial<ServerSettings>) {
    return this.send<ServerSettings>('PUT', '/api/settings', patch);
  }
  scan(path: string, depth: number, register?: { workspace: string }) {
    return this.post<ScannedRepo[]>('/api/scan', { path, depth, register: !!register, workspace: register?.workspace });
  }
  async systemOpen(path: string, app: string) {
    await this.post('/api/system/open', { path, app });
  }
  async systemReveal(path: string) {
    await this.post('/api/system/reveal', { path });
  }
  async systemTerminal(path: string, app?: string) {
    await this.post('/api/system/terminal', { path, app });
  }
  sshKeys() {
    return this.get<SshKeyInfo[]>('/api/ssh/keys');
  }
  sshGenerate(name: string, type: 'ed25519' | 'rsa' | 'ecdsa', passphrase: string, comment: string) {
    return this.post<{ file: string }>('/api/ssh/generate', { name, type, passphrase, comment });
  }
  async sshAgentAdd(name: string) {
    await this.post('/api/ssh/agentAdd', { name });
  }
  sshTest(host: string) {
    return this.post<{ opId: string }>('/api/ssh/test', { host });
  }
  accounts() {
    return this.get<ServerAccount[]>('/api/accounts');
  }
  addAccount(host: string, token: string) {
    return this.post<ServerAccount>('/api/accounts', { host, token });
  }
  async removeAccount(id: string) {
    await this.send('DELETE', '/api/accounts', { id });
  }
  githubAccess(accountId: string) {
    return this.post<GhAccess>('/api/github/access', { accountId });
  }
  githubRepos(accountId: string, page = 1) {
    return this.post<GhRepo[]>('/api/github/repos', { accountId, page });
  }
  githubAddKey(accountId: string, title: string, key: string) {
    return this.post<{ id: number }>('/api/github/addKey', { accountId, title, key });
  }
  githubDeviceStart(clientId: string, host = 'github.com') {
    return this.post<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>('/api/github/deviceStart', { clientId, host });
  }
  githubDevicePoll(clientId: string, deviceCode: string, host = 'github.com') {
    return this.post<{ done: boolean; account?: ServerAccount; error?: string }>('/api/github/devicePoll', { clientId, deviceCode, host });
  }
  agentCheck() {
    return this.get<{ ok: boolean; path: string | null; version: string }>('/api/agent/check');
  }
  agentRun(prompt: string, cwd: string, mode: 'repo' | 'app', apply = true, resume?: string) {
    return this.post<{ opId: string }>('/api/agent/run', { prompt, cwd, mode, apply, resume });
  }

  events(listener: (e: OpEvent) => void, onConnection?: (up: boolean) => void): () => void {
    if (Platform.OS !== 'web' || typeof EventSource === 'undefined') return () => {};
    const es = new EventSource(`${this.baseUrl}/api/events`);
    // the browser reconnects by itself; meanwhile the engine is gone (stopped, crashed, restarting)
    es.onerror = () => onConnection?.(false);
    es.onopen = () => onConnection?.(true);
    es.onmessage = (m) => {
      try {
        listener(JSON.parse(m.data));
      } catch {
        /* ignore malformed event */
      }
    };
    return () => es.close();
  }
}

/** The server only needs the header fields to rebuild a hunk patch. */
function slim(f: FileChange): FileChange {
  return { path: f.path, oldPath: f.oldPath, status: f.status, kind: f.kind, additions: f.additions, deletions: f.deletions };
}
