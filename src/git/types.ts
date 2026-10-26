export type Sha = string;

export interface Commit {
  sha: Sha;
  parents: Sha[];
  subject: string;
  body: string;
  author: string;
  email: string;
  date: number; // unix ms
  files?: FileChange[]; // lazy in a real client
}

export type RefKind = 'head' | 'branch' | 'remote' | 'tag' | 'stash';

export interface Ref {
  name: string; // "main", "origin/main", "v1.2.0"
  kind: RefKind;
  sha: Sha;
  current?: boolean;
  upstream?: string;
  /** the upstream is configured but the remote branch no longer exists */
  gone?: boolean;
  ahead?: number;
  behind?: number;
}

export interface Remote {
  name: string;
  url: string;
  /** the fetch list follows only some branches (a `--single-branch` clone), so the others never appear locally */
  narrow?: boolean;
}

export interface Stash {
  index: number;
  message: string;
  date: number;
  sha: Sha;
  files: FileChange[];
}

export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

export type ContentKind = 'text' | 'image' | 'audio' | 'video' | 'binary' | 'submodule' | 'large';

/**
 * What comes back on the next launch: the open tabs of every workspace, the active one, and the branch filter of
 * each repository (by repository id). Kept by the engine in its state folder (`session.json`).
 */
export interface SavedSession {
  activeWorkspace?: string;
  screen?: 'welcome' | 'repo';
  tabs?: string[];
  activeTab?: string | null;
  workspaceTabs?: Record<string, { tabs: string[]; activeTab: string | null }>;
  filters?: Record<string, { mode: 'all' | 'current' | 'selected'; refs: string[]; hideRemotes: boolean }>;
}

/** what Fetch, Pull and Push send to the engine (the options of their dialogs, as in Fork) */
export interface FetchOptions {
  /** one remote; all of them when not given */
  remote?: string;
  /** drop remote branches that are gone from the server (--prune) */
  prune?: boolean;
  /** every tag of the remote, not only those on fetched commits (--tags) */
  tags?: boolean;
}
export interface PullOptions {
  strategy?: 'merge' | 'rebase' | 'ff';
  /** pull this branch of this remote (the current branch's upstream when not given) */
  remote?: string;
  branch?: string;
  /** local changes go to the stash before and come back after (--autostash) */
  autostash?: boolean;
}
export interface PushOptions {
  remote?: string;
  /** the local branch to push (the current one when not given) */
  branch?: string;
  /** its name on the remote (the branch it tracks there, else the same name) */
  remoteBranch?: string;
  /** --force-with-lease */
  force?: boolean;
  tags?: boolean;
  /** the local branch tracks the remote one afterwards (-u) */
  setUpstream?: boolean;
}
/** the dialogs' choices, remembered between uses (Fork keeps them too) */
export interface SyncPrefs {
  /** the remote Fetch picks ('' = all remotes) */
  fetchRemote: string;
  fetchPrune: boolean;
  fetchTags: boolean;
  pullAutostash: boolean;
  pushTags: boolean;
}

/**
 * One action in a repository's queue (the engine runs whatever changes a repository one at a time, and waits while
 * another git process holds the repository's lock): `lock` is the file it waits for, `lockSince` when that file last
 * changed (a lock unchanged for minutes was likely left by a crash).
 */
export interface QueueItem {
  id: number;
  label: string;
  state: 'queued' | 'waiting-lock' | 'running';
  since: number;
  lock?: string;
  lockSince?: number;
}

/**
 * How git signs in to the remotes of a repository: git's defaults, one SSH key from ~/.ssh, or a Prong account
 * (its token). Submodules and repositories inside its folder use the same unless they have their own.
 */
export type RepoAuth = { kind: 'default' } | { kind: 'ssh'; key: string } | { kind: 'account'; account: string };
export interface RepoAuthInfo {
  own: RepoAuth | null;
  inherited: { auth: RepoAuth; from: string; name: string } | null;
  describe: string;
  sshDir: string;
}

export interface FileChange {
  path: string;
  oldPath?: string; // for renames
  status: FileStatus;
  kind: ContentKind;
  additions: number;
  deletions: number;
  hunks?: Hunk[]; // text
  image?: { before?: string; after?: string; beforeSize?: string; afterSize?: string }; // data uri / colors
  binary?: { beforeBytes: number; afterBytes: number };
  submodule?: { before: Sha; after: Sha };
  similarity?: number;
  conflict?: { ours: string[]; theirs: string[]; base: string[] };
  /** listed without its diff (a commit with very many files): the diff is loaded when the file is selected */
  lazy?: boolean;
  /** the diff was cut short (more output than the engine reads at once) */
  truncated?: boolean;
}

export type LineKind = 'ctx' | 'add' | 'del';

export interface DiffLine {
  kind: LineKind;
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface Hunk {
  id: string;
  header: string; // @@ -a,b +c,d @@ fn
  lines: DiffLine[];
  staged?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  /** folder scanned for repositories */
  rootPath?: string;
  scanDepth?: number;
}

export interface RepoInfo {
  id: string;
  name: string;
  /** where the user put it (Open / Clone / Move) */
  workspace: string;
  /** workspaces whose folder scans find it (membership derived from scan roots) */
  workspaces?: string[];
  path: string;
  currentBranch: string;
  changes: number;
  lastOpened: number;
  pinned?: boolean;
  /** backed by the local git engine (real repository on disk) */
  live?: boolean;
}

export interface GitHubAccount {
  id: string;
  login: string;
  host: string; // github.com
  name: string;
  orgs: string[];
  avatarColor: string;
  avatar?: string;
}

export interface SshKey {
  id: string;
  name: string; // id_ed25519
  type: 'ed25519' | 'rsa' | 'ecdsa' | string;
  fingerprint: string;
  publicKey: string;
  inAgent: boolean;
  addedToGitHub: boolean;
  hasPassphrase: boolean | null;
}

export interface RepoSnapshot {
  commits: Commit[]; // topo order, newest first
  refs: Ref[];
  remotes: Remote[];
  stashes: Stash[];
  unstaged: FileChange[];
  staged: FileChange[];
  head: Sha;
  conflictFile?: FileChange;
  /** a shallow clone (`clone --depth`): its history is cut off, and unshallow completes it */
  shallow?: boolean;
}
