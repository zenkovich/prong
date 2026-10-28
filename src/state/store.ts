import { useMemo, useSyncExternalStore } from 'react';
import { Commit, FetchOptions, FileChange, GitHubAccount, PullOptions, PushOptions, QueueItem, RepoAuth, RepoInfo, RepoSnapshot, Sha, SshKey, Stash, SyncPrefs, Workspace } from '../git/types';
import { buildSmallSnapshot, buildSnapshot, cloneFile, fakeSha, WORKSPACES } from '../git/mock/fixtures';
import { SCHEMES, ThemeName, UI_SCALES, THEMES } from '../theme';
import { AgentMessage, AgentSettings, AgentTarget, AppMods, AppVersion, FACTORY_MODS } from '../agent/types';
import { plan as planCommand } from '../agent/mockAgent';
import * as live from './live';
import type { ServerSettings, Submodule } from '../git/GitClient';
import { GraphFilter } from '../components/graphLayout';
import { toggleFilterRef } from '../components/branchFilter';
import { nextSelection } from '../components/refSelection';

/** smallest heights of the resizable commit box and commit description block */
export const COMMIT_BOX_MIN = 124;
export const DETAILS_HEADER_MIN = 64;

// ---------- types ----------

export type Section = 'changes' | 'commits';
export type Area = 'unstaged' | 'staged' | 'commit' | 'stash';

export interface RepoState extends RepoSnapshot {
  id: string;
  section: Section;
  selectedCommit: Sha | null; // commit sha, or stash sha
  selectedStash: number | null;
  selectedFile: string | null;
  selectedArea: Area;
  commitMessage: string;
  commitDescription: string;
  amend: boolean;
  search: string;
  graphFilter: GraphFilter;
  collapsedMerges: Record<Sha, boolean>;
  fileView: 'list' | 'tree';
  diffMode: 'unified' | 'split';
  collapsedGroups: Record<string, boolean>;
  collapsedHunks: Record<string, boolean>;
  loadedLarge: Record<string, boolean>;
  mergeInProgress?: { branch: string };
  path?: string;
  live?: boolean;
  loading?: boolean;
  stale?: boolean;
  opKind?: 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  submodules?: Submodule[];
  historyPath?: string | null;
  historyCommits?: Commit[];
  /** `loading`: the lines are on their way (an empty file has none) */
  blame?: { path: string; lines: { sha: string; author: string; date: number; line: string }[]; loading?: boolean } | null;
  loadingMore?: boolean;
  logExhausted?: boolean;
  /** live repos: commits for the current branch filter, fetched from the engine (null = all) */
  filteredCommits?: Commit[] | null;
  /** the filtered history has no more pages */
  filterExhausted?: boolean;
  /** the folder is not a repository any more (deleted, moved, renamed): its path; the tab says so */
  missing?: string;
  /**
   * live repositories: what the commit search found in the whole history (the list filters only what is loaded);
   * `commits` null while git looks; `more`: there are more matches than were read
   */
  searchResults?: { q: string; commits: Commit[] | null; more: boolean } | null;
  /** scroll the commit list to this commit (nonce: a new request for the same commit) */
  reveal?: { sha: Sha; nonce: number } | null;
  /** branches picked with ⌘/Shift in the sidebar for a batch action, and the last one clicked (Shift runs) */
  refSelection: string[];
  refAnchor: string | null;
  /**
   * Changes' files picked together with ⌘/Shift (two or more, all in `selectedArea`; empty: just `selectedFile`), and
   * the last one clicked (Shift runs). The diff shows `selectedFile`.
   */
  fileSelection: string[];
  fileAnchor: string | null;
}

/** one choice of a dropdown (`showPicker`): what it sets, how it reads, a quiet note on the right */
export interface PickOption {
  value: string;
  label: string;
  hint?: string;
}
export interface PickerState {
  /** the field it opens under (window rect, layout px) */
  anchor: { x: number; y: number; w: number; h: number };
  options: PickOption[];
  value?: string;
  onPick: (value: string) => void;
  /** a filter field on top (long lists: remote branches) */
  filter?: boolean;
  testID?: string;
  /** set by showPicker: each opening is a fresh list (filter and cursor start over) */
  id?: number;
}

export interface MenuItem {
  label?: string;
  separator?: boolean;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  onPress?: () => void;
}

export type Dialog =
  | { type: 'clone'; url?: string }
  | { type: 'open' }
  | { type: 'init' }
  /** `token`: straight to signing in with a personal access token */
  | { type: 'accounts'; tab?: 'github' | 'ssh' | 'general'; token?: boolean }
  | { type: 'rebase'; onto?: string; interactive?: boolean; fromSha?: Sha }
  /** `branch`: the local branch to push (the current one when not given) */
  | { type: 'push'; branch?: string }
  | { type: 'pull' }
  | { type: 'fetch' }
  /** `stash`: "Branch from stash" (the branch starts where that stash was made and gets its changes) */
  | { type: 'branch'; fromSha?: Sha; /** the branch or tag it starts from (the sidebar's menus) */ fromName?: string; stash?: number }
  | { type: 'merge'; source?: string }
  | { type: 'tag'; sha: Sha }
  | { type: 'reset'; sha: Sha }
  | { type: 'stash' }
  | { type: 'palette' }
  | { type: 'shortcuts' }
  | { type: 'workspace'; id?: string }
  | { type: 'renameBranch'; name: string }
  | { type: 'upstream'; branch: string }
  | { type: 'remote'; name?: string; url?: string }
  | { type: 'connection' }
  | { type: 'deleteBranches'; names: string[] }
  /** Git LFS files the working copy holds as pointers, to restore (`focus`: open with that file's folder picked) */
  | { type: 'lfs'; focus?: string }
  | { type: 'confirm'; title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void };

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
  detail?: string;
  /** an error toast points at its entry in the error log (a click opens the error dialog) */
  errorId?: number;
}

/**
 * One action that can be taken back (the toolbar's Undo, ⌘Z). `head` is the HEAD the action left: undoing needs it
 * unchanged, so after another commit, checkout or a command in a terminal the entry is stale instead of harmful.
 */
export interface UndoEntry {
  id: number;
  /** what is undone: "Commit “Fix login”" */
  label: string;
  at: number;
  head: Sha;
  run: (path: string) => Promise<unknown>;
  /** asked before undoing (the commit is already on the remote…); read when undoing */
  warn?: () => string | undefined;
  /** HEAD moves back: the submodules follow, as after any checkout */
  moves?: boolean;
}

/** One entry of the session's error log, shown in the error dialog. */
export interface ErrorEntry {
  id: number;
  title: string;
  /** the full message: git's output, a stack */
  detail?: string;
  at: number;
  /** the same error again within a minute counts here instead of piling up */
  count: number;
  /** a way out offered in the error dialog, e.g. "Delete 7 anyway" */
  action?: { label: string; run: () => void };
  /** the repository on screen when it happened (path): where the agent looks into it */
  repo?: string;
}

export interface Operation {
  label: string;
  progress: number; // 0..1
  log: string[];
}

/** Result of an agent run shown as a card under the agent bar until the user closes it. */
export interface AgentNotice {
  id: number;
  msgId: number;
  ok: boolean;
  title: string;
  text: string;
  target?: 'repo' | 'app';
  actions: string[];
  versionId?: number;
  cost?: string;
  durationMs?: number;
  time: number;
}

export interface AgentState {
  /** the full chat panel */
  open: boolean;
  /** the compact command line in the tab bar is expanded */
  bar: boolean;
  /** one-line description of what the agent is doing while busy */
  status: string | null;
  startedAt: number | null;
  notices: AgentNotice[];
  width: number;
  tab: 'chat' | 'changes' | 'settings';
  target: AgentTarget;
  messages: AgentMessage[];
  /** the Claude Code session of the chat's last run: a follow-up in the same place continues it */
  session: { id: string; mode: 'repo' | 'app'; cwd: string } | null;
  busy: boolean;
  versions: AppVersion[];
  settings: AgentSettings;
}

export interface AppState {
  engine: { online: boolean; git: string; version: string; ui?: 'static' | 'dev'; uiBuild?: 'factory' | 'agent' };
  serverSettings: ServerSettings | null;
  agentAvailable: { ok: boolean; path: string | null; version: string } | null;
  scanning: string | null;
  agent: AgentState;
  screen: 'welcome' | 'repo';
  theme: ThemeName;
  uiScale: number;
  /** defaults for new repository views (persisted with the other UI preferences) */
  fileView: 'list' | 'tree';
  diffMode: 'unified' | 'split';
  submoduleView: 'list' | 'tree';
  commitAction: 'commit' | 'commit-push';
  /** tab groups (a repository with its open submodules) the user folded, by the parent tab id */
  collapsedTabGroups: Record<string, boolean>;
  workspaces: Workspace[];
  activeWorkspace: string;
  /** tabs of the workspaces that are not active */
  workspaceTabs: Record<string, { tabs: string[]; activeTab: string | null }>;
  repos: RepoInfo[];
  tabs: string[];
  activeTab: string | null;
  repoStates: Record<string, RepoState>;
  accounts: GitHubAccount[];
  sshKeys: SshKey[];
  dialog: Dialog | null;
  toasts: Toast[];
  /** errors of this session, newest first (at most 50) */
  errors: ErrorEntry[];
  /** the error shown in the error dialog; null: closed */
  errorOpen: number | null;
  operation: Operation | null;
  /** the engine's action queues by repository path (what waits for its turn or for another git process's lock) */
  queues: Record<string, QueueItem[]>;
  contextMenu: { x: number; y: number; items: MenuItem[] } | null;
  /** an open dropdown of a dialog field (above the dialog, like the context menu) */
  picker: PickerState | null;
  /** what the Fetch / Pull / Push dialogs had ticked last time */
  syncPrefs: SyncPrefs;
  /** what can be undone, per repository (newest last) */
  undo: Record<string, UndoEntry[]>;
  /** whether each GitHub account's sign-in works, by account id (checked at start and after signing in) */
  accountStatus: Record<string, { state: 'ok' | 'expired' | 'error' | 'checking'; message?: string }>;
  /** the repository list of the start page as a popup (the + in the tab bar, ⌘T), at a window position */
  repoPicker: { x: number; y: number } | null;
  layout: { sidebar: number; details: number; files: number; commitBox: number; detailsHeader: number };
  /** the description field of the commit box, and the description block of a commit in history, unfolded */
  commitDescOpen: boolean;
  detailsDescOpen: boolean;
  sidebarCollapsed: boolean;
}

// ---------- store core ----------

type Listener = () => void;
let state: AppState = {
  engine: { online: false, git: '', version: '' },
  serverSettings: null,
  agentAvailable: null,
  scanning: null,
  agent: {
    open: false,
    bar: false,
    status: null,
    startedAt: null,
    notices: [],
    width: 360,
    tab: 'chat',
    target: 'auto',
    session: null,
    busy: false,
    versions: [],
    messages: [
      {
        id: 1,
        role: 'system',
        time: Date.now(),
        text: 'Prong поставляется с исходниками и собирает интерфейс из них на лету. Я могу выполнять команды в репозитории и менять само приложение: каждое изменение интерфейса попадает в журнал версий, его можно откатить или сбросить всё к заводской сборке.',
      },
    ],
    settings: {
      provider: 'anthropic-claude-code',
      model: 'claude-fable-5-1',
      cliPath: '/opt/homebrew/bin/claude',
      sourcesPath: '~/Library/Application Support/Prong/src',
      askBeforeApply: false,
      autoRollbackOnBuildError: true,
      connected: true,
      cliVersion: '2.1.4',
    },
  },
  screen: 'welcome',
  theme: 'amber',
  uiScale: 1,
  fileView: 'tree',
  diffMode: 'unified',
  submoduleView: 'tree',
  commitAction: 'commit',
  collapsedTabGroups: {},
  workspaces: WORKSPACES,
  activeWorkspace: 'work',
  workspaceTabs: {},
  repos: [],
  tabs: [],
  activeTab: null,
  repoStates: {},
  accounts: [],
  sshKeys: [],
  dialog: null,
  toasts: [],
  errors: [],
  errorOpen: null,
  operation: null,
  queues: {},
  contextMenu: null,
  picker: null,
  syncPrefs: { fetchRemote: '', fetchPrune: true, fetchTags: false, pullAutostash: false, pushTags: false },
  undo: {},
  accountStatus: {},
  repoPicker: null,
  layout: { sidebar: 230, details: 0.46, files: 300, commitBox: 170, detailsHeader: 130 },
  commitDescOpen: true,
  detailsDescOpen: true,
  sidebarCollapsed: false,
};
const listeners = new Set<Listener>();

export function getState() {
  return state;
}
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export function useRepo(): RepoState {
  return useStore((s) => s.repoStates[s.activeTab ?? ''] ?? EMPTY_REPO);
}
/**
 * One value of the active repository. A component that renders one of thousands of rows (branches, tags) uses
 * this instead of `useRepo`, so it re-renders when its value changes, not on every change of the repository.
 */
export function useRepoValue<T>(pick: (r: RepoState) => T): T {
  return useStore((s) => pick(s.repoStates[s.activeTab ?? ''] ?? EMPTY_REPO));
}

/** Sidebar groups that start collapsed: branches stay open, the rest is noise until asked for. */
export const DEFAULT_COLLAPSED_GROUPS: Record<string, boolean> = { tags: true, remotes: true, stashes: true };

export const EMPTY_REPO: RepoState = {
  id: '',
  commits: [],
  refs: [],
  remotes: [],
  stashes: [],
  unstaged: [],
  staged: [],
  head: '',
  section: 'commits',
  selectedCommit: null,
  selectedStash: null,
  selectedFile: null,
  selectedArea: 'commit',
  commitMessage: '',
  commitDescription: '',
  amend: false,
  search: '',
  graphFilter: { mode: 'all', refs: [], hideRemotes: false },
  collapsedMerges: {},
  fileView: 'tree',
  diffMode: 'unified',
  collapsedGroups: { ...DEFAULT_COLLAPSED_GROUPS },
  collapsedHunks: {},
  loadedLarge: {},
  refSelection: [],
  refAnchor: null,
  fileSelection: [],
  fileAnchor: null,
};

function activeRepo(): RepoState | null {
  return state.activeTab ? state.repoStates[state.activeTab] ?? null : null;
}

export function updateRepo(patch: Partial<RepoState> | ((r: RepoState) => Partial<RepoState>), id?: string) {
  const rid = id ?? state.activeTab;
  if (!rid) return;
  const r = state.repoStates[rid];
  if (!r) return;
  const p = typeof patch === 'function' ? patch(r) : patch;
  setState({ repoStates: { ...state.repoStates, [rid]: { ...r, ...p } } });
}

// ---------- toasts & ops ----------

let toastId = 0;
let errorSeq = 0;
/**
 * An error the user has to see: it goes into the session's error log and the error dialog opens on it
 * (the same error again within a minute only counts up).
 */
export function reportError(title: string, detail?: string, action?: ErrorEntry['action']): number {
  const now = Date.now();
  const last = state.errors[0];
  if (last && last.title === title && last.detail === detail && now - last.at < 60000) {
    const again = { ...last, count: last.count + 1, at: now, action: action ?? last.action };
    setState((s) => ({ errors: [again, ...s.errors.slice(1)], errorOpen: again.id }));
    return again.id;
  }
  const shown = state.screen === 'repo' ? state.repos.find((r) => r.id === state.activeTab) : undefined;
  const e: ErrorEntry = { id: ++errorSeq, title, detail: detail?.slice(0, 50000), at: now, count: 1, action, repo: shown?.live ? shown.path : undefined };
  setState((s) => ({ errors: [e, ...s.errors].slice(0, 50), errorOpen: e.id }));
  return e.id;
}
/** open the error dialog on one entry, or on the newest */
export function showErrors(id?: number) {
  setState((s) => ({ errorOpen: id ?? s.errors[0]?.id ?? null }));
}
export function closeErrors() {
  setState({ errorOpen: null });
}
export function clearErrors() {
  setState((s) => ({ errors: [], errorOpen: null, toasts: s.toasts.filter((t) => t.kind !== 'error') }));
}

export function toast(text: string, kind: Toast['kind'] = 'info', detail?: string, action?: ErrorEntry['action']) {
  const id = ++toastId;
  const errorId = kind === 'error' ? reportError(text, detail, action) : undefined;
  // the status line shows the first line; the dialog has the rest
  const short = detail?.split('\n').find((l) => l.trim()) ?? detail;
  setState((s) => ({ toasts: [...s.toasts, { id, text, kind, detail: short, errorId }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500);
}
export function dismissToast(id: number) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function runOperation(label: string, ms: number, log: string[], onDone?: () => void) {
  if (state.operation) {
    toast(`Already running: ${state.operation.label}`, 'error');
    return;
  }
  const start = Date.now();
  setState({ operation: { label, progress: 0, log: [] } });
  const tick = () => {
    const elapsed = Date.now() - start;
    const p = Math.min(1, elapsed / ms);
    const shown = Math.floor(p * log.length);
    setState({ operation: { label, progress: p, log: log.slice(0, shown) } });
    if (p < 1) setTimeout(tick, 50);
    else {
      setState({ operation: null });
      onDone?.();
    }
  };
  setTimeout(tick, 50);
}

export function cancelOperation() {
  if (live.isLiveActive() || live.agentReady()) return live.stopRunning();
  setState({ operation: null });
  toast('Operation cancelled', 'info');
}

// ---------- ui ----------

export function openDialog(d: Dialog) {
  setState({ dialog: d, contextMenu: null });
}
export function closeDialog() {
  setState({ dialog: null });
}
export function confirm(title: string, message: string, onConfirm: () => void, confirmLabel = 'OK', danger = false) {
  openDialog({ type: 'confirm', title, message, onConfirm, confirmLabel, danger });
}
export function showContextMenu(x: number, y: number, items: MenuItem[]) {
  setState({ contextMenu: { x, y, items } });
}
let pickerSeq = 0;
export function showPicker(p: PickerState) {
  setState({ picker: { ...p, id: ++pickerSeq } });
}
export function hidePicker() {
  if (state.picker) setState({ picker: null });
}
export function hideContextMenu() {
  if (state.contextMenu) setState({ contextMenu: null });
}
export function setTheme(theme: ThemeName) {
  setState({ theme });
  live.persistUi({ theme });
}
export function toggleTheme() {
  const i = SCHEMES.findIndex((x) => x.id === state.theme);
  // remembered like a scheme picked in Preferences (the palette's "Next colour scheme" used to be lost on reload)
  setTheme(SCHEMES[(i + 1) % SCHEMES.length].id);
}
export function setUiScale(uiScale: number) {
  const v = Math.min(2, Math.max(0.6, Math.round(uiScale * 100) / 100));
  setState({ uiScale: v });
  live.persistUi({ uiScale: v });
}
export function stepUiScale(dir: 1 | -1 | 0) {
  setState((s) => {
    if (dir === 0) return { uiScale: 1 };
    const i = UI_SCALES.findIndex((v) => v >= s.uiScale - 0.001);
    const idx = i === -1 ? UI_SCALES.length - 1 : i;
    const next = UI_SCALES[Math.min(UI_SCALES.length - 1, Math.max(0, idx + dir))];
    return { uiScale: next };
  });
  live.persistUi({ uiScale: state.uiScale });
}

// ---------- workspaces ----------

/** A repository is listed in its own workspace and in every workspace whose folder scan found it. */
export const inWorkspace = (r: RepoInfo, ws: string) => r.workspace === ws || (r.workspaces ?? []).includes(ws);
/** the start page's order: pinned first, then the most recently opened; `q` matches name or path */
export function sortRepos(list: RepoInfo[], q = ''): RepoInfo[] {
  const k = q.trim().toLowerCase();
  return list
    .filter((r) => !k || r.name.toLowerCase().includes(k) || r.path.toLowerCase().includes(k))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.lastOpened - a.lastOpened);
}
export function openRepoPicker(x: number, y: number) {
  setState({ repoPicker: { x, y }, contextMenu: null });
}
/** from the keyboard (⌘T) or the palette: near the top, centred */
export function openRepoPickerCentered() {
  const w = typeof window !== 'undefined' ? window.innerWidth / (state.uiScale || 1) : 1000;
  openRepoPicker(Math.max(8, (w - 540) / 2), 44);
}
export function closeRepoPicker() {
  setState({ repoPicker: null });
}

export function useWorkspaceRepos(): RepoInfo[] {
  // selectors must return stable references: derive with useMemo, not inside the selector
  const repos = useStore((s) => s.repos);
  const ws = useStore((s) => s.activeWorkspace);
  return useMemo(() => repos.filter((r) => inWorkspace(r, ws)), [repos, ws]);
}

/**
 * Makes another workspace active, with the tabs it had. `stayHome`: switched from the start screen's list of
 * workspaces — the start screen stays and shows that workspace's repositories (it used to jump into the
 * workspace's last tab).
 */
export function switchWorkspace(id: string, stayHome = false) {
  if (id === state.activeWorkspace || !state.workspaces.some((w) => w.id === id)) return;
  const saved = state.workspaceTabs[id] ?? { tabs: [], activeTab: null };
  const workspaceTabs = { ...state.workspaceTabs, [state.activeWorkspace]: { tabs: state.tabs, activeTab: state.activeTab } };
  delete workspaceTabs[id];
  const screen = saved.activeTab && !(stayHome && state.screen === 'welcome') ? 'repo' : 'welcome';
  setState({ activeWorkspace: id, workspaceTabs, tabs: saved.tabs, activeTab: saved.activeTab, screen, dialog: null, contextMenu: null });
  // a tab restored from the last session is read when it is first shown
  if (screen === 'repo' && saved.activeTab && !state.repoStates[saved.activeTab] && state.repos.find((r) => r.id === saved.activeTab)?.live) void live.openLive(saved.activeTab);
  toast(`Workspace: ${state.workspaces.find((w) => w.id === id)?.name}`, 'info');
}

export function createWorkspace(name: string, activate = true) {
  const clean = name.trim();
  if (!clean) return;
  const id = `ws-${Date.now().toString(36)}`;
  setState((s) => ({ workspaces: [...s.workspaces, { id, name: clean }] }));
  closeDialog();
  void live.persistWorkspaces();
  if (activate) switchWorkspace(id);
  else toast(`Created workspace ${clean}`, 'success');
  return id;
}

export function renameWorkspace(id: string, name: string) {
  const clean = name.trim();
  if (!clean) return;
  setState((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name: clean } : w)) }));
  closeDialog();
  void live.persistWorkspaces();
}

export function deleteWorkspace(id: string) {
  if (state.workspaces.length < 2) {
    toast('Keep at least one workspace', 'error');
    return;
  }
  const ws = state.workspaces.find((w) => w.id === id);
  const target = state.workspaces.find((w) => w.id !== id)!;
  confirm(`Delete workspace ${ws?.name}?`, `Its repositories move to "${target.name}". Nothing is deleted on disk.`, () => {
    if (state.activeWorkspace === id) switchWorkspace(target.id);
    // the engine keeps each repository's own workspace: left at the deleted one, the workspace came back (named by
    // its id) on the next launch
    for (const r of state.repos) if (r.live && r.path && r.workspace === id) void live.client.moveRepo(r.path, target.id).catch(() => {});
    setState((s) => {
      const workspaceTabs = { ...s.workspaceTabs };
      delete workspaceTabs[id];
      return {
        workspaces: s.workspaces.filter((w) => w.id !== id),
        repos: s.repos.map((r) => ({ ...r, workspace: r.workspace === id ? target.id : r.workspace, workspaces: r.workspaces?.filter((w) => w !== id) })),
        workspaceTabs,
      };
    });
    void live.persistWorkspaces();
  }, 'Delete', true);
}

/**
 * Moves a repository out of the active workspace into another: out of the active one's list even when its folder
 * scan finds it (the scan stops listing it there; it used to stay, the move seemed to do nothing).
 */
export function moveRepoToWorkspace(repoId: string, workspace: string) {
  const info = state.repos.find((r) => r.id === repoId);
  const from = state.activeWorkspace;
  if (info?.live && info.path) void live.client.moveRepo(info.path, workspace, from).catch(() => {});
  if (state.tabs.includes(repoId)) closeTab(repoId);
  setState((s) => ({ repos: s.repos.map((r) => (r.id === repoId ? { ...r, workspace, workspaces: from !== workspace ? r.workspaces?.filter((w) => w !== from) : r.workspaces } : r)) }));
  toast(`Moved to ${state.workspaces.find((w) => w.id === workspace)?.name}`, 'info');
}
export function setLayout(patch: Partial<AppState['layout']>) {
  setState((s) => ({ layout: { ...s.layout, ...patch } }));
  if (patch.sidebar !== undefined) live.persistUi({ sidebarWidth: patch.sidebar });
  if (patch.commitBox !== undefined) live.persistUi({ commitBoxHeight: patch.commitBox });
  if (patch.detailsHeader !== undefined) live.persistUi({ detailsHeaderHeight: patch.detailsHeader });
  // the history / details split is remembered too (it used to be back at the default after a reload)
  if (patch.details !== undefined) live.persistUi({ detailsRatio: patch.details });
}
export function toggleCommitDesc() {
  const v = !state.commitDescOpen;
  setState({ commitDescOpen: v });
  live.persistUi({ commitDescOpen: v });
}
export function toggleDetailsDesc() {
  const v = !state.detailsDescOpen;
  setState({ detailsDescOpen: v });
  live.persistUi({ detailsDescOpen: v });
}
/** a commit in whatever history is loaded: the main log, the branch-filtered log, a file history, search results */
export function findCommit(r: RepoState, sha: Sha | null | undefined): Commit | undefined {
  if (!sha) return undefined;
  return r.commits.find((c) => c.sha === sha) ?? r.filteredCommits?.find((c) => c.sha === sha) ?? r.historyCommits?.find((c) => c.sha === sha) ?? r.searchResults?.commits?.find((c) => c.sha === sha);
}
/** a ⌘ / Shift click on a branch row; `order` is the order the sidebar shows (Shift runs) */
/** the Changes files an action applies to in `area`: the picked ones, or the selected one */
export function pickedFiles(r: RepoState | null | undefined, area: 'unstaged' | 'staged'): string[] {
  if (!r || r.selectedArea !== area) return [];
  const list = area === 'unstaged' ? r.unstaged : r.staged;
  // (a folder's pick can be thousands of files)
  const shown = new Set(list.map((f) => f.path));
  const picked = r.fileSelection.filter((p) => shown.has(p));
  if (picked.length > 1) return picked;
  return r.selectedFile && list.some((f) => f.path === r.selectedFile) ? [r.selectedFile] : [];
}
/**
 * ⌘ / Shift on a Changes file (as on branches): ⌘ toggles it, Shift picks the run from the last clicked one in the
 * order the list shows. A pick in the other list starts over there. The diff follows the clicked file.
 */
export function clickFileSelection(area: 'unstaged' | 'staged', path: string, mods: { meta: boolean; shift: boolean }, order: string[]) {
  const r = activeRepo();
  if (!r) return;
  const same = r.selectedArea === area;
  const base = same ? (r.fileSelection.length > 1 ? r.fileSelection : r.selectedFile ? [r.selectedFile] : []) : [];
  const n = nextSelection(base, same ? r.fileAnchor ?? r.selectedFile : null, path, mods, order);
  setFileSelection(area, n.sel, n.sel.includes(path) ? path : n.sel.at(-1) ?? path, n.anchor ?? path);
}
/**
 * A click on a Changes folder picks the files under it (`inside`, in the order shown), as a click on a file picks
 * that file: plain, the folder alone; ⌘, its files join the selection (or leave it, when all were in); Shift, the run
 * from the last clicked file to the folder, the folder whole. The diff shows its first file.
 */
export function clickFolderSelection(area: 'unstaged' | 'staged', inside: string[], mods: { meta: boolean; shift: boolean }, order: string[]) {
  const r = activeRepo();
  if (!r || !inside.length) return;
  const same = r.selectedArea === area;
  const base = same ? (r.fileSelection.length > 1 ? r.fileSelection : r.selectedFile ? [r.selectedFile] : []) : [];
  if (mods.shift) {
    const anchor = same ? r.fileAnchor ?? r.selectedFile : null;
    // the run reaches the folder's near end; the rest of the folder joins it
    const at = anchor ? order.indexOf(anchor) : -1;
    const near = at >= 0 && at > order.indexOf(inside[0]) ? inside[0] : inside[inside.length - 1];
    const n = nextSelection(base, anchor, near, mods, order);
    const had = new Set(n.sel);
    return setFileSelection(area, [...n.sel, ...inside.filter((p) => !had.has(p))], near, n.anchor ?? near);
  }
  if (mods.meta) {
    const had = new Set(base);
    if (inside.every((p) => had.has(p))) {
      const out = new Set(inside);
      const rest = base.filter((p) => !out.has(p));
      return rest.length ? setFileSelection(area, rest, rest[rest.length - 1], rest[rest.length - 1]) : undefined;
    }
    return setFileSelection(area, [...base, ...inside.filter((p) => !had.has(p))], inside[0], inside[0]);
  }
  setFileSelection(area, inside, inside[0], inside[0]);
}
/** the picked files of a list (one or none: a plain selection), the one the diff shows, the anchor of Shift runs */
export function setFileSelection(area: 'unstaged' | 'staged', paths: string[], focus?: string, anchor?: string) {
  const sel = [...new Set(paths)];
  const shown = focus ?? sel.at(-1) ?? null;
  updateRepo({ fileSelection: sel.length > 1 ? sel : [], fileAnchor: anchor ?? shown });
  if (shown) selectFile(area, shown, true);
}
export function clearFileSelection() {
  if (activeRepo()?.fileSelection.length) updateRepo({ fileSelection: [] });
}
/** `what`: the folder the files are (the action is named for it) */
export function stageFiles(paths: string[], what?: string) {
  if (live.isLiveActive()) return live.stageFiles(paths, what);
  paths.forEach(stageFile);
  updateRepo({ fileSelection: [] });
}
export function unstageFiles(paths: string[], what?: string) {
  if (live.isLiveActive()) return live.unstageFiles(paths, what);
  paths.forEach(unstageFile);
  updateRepo({ fileSelection: [] });
}
export function discardFiles(paths: string[], what?: string) {
  if (live.isLiveActive()) return live.discardFiles(paths, what);
  if (paths.length === 1) return discardFile(paths[0]);
  confirm(`Discard ${paths.length} files?`, 'Their changes are dropped (mock).', () => updateRepo((r) => ({ unstaged: r.unstaged.filter((f) => !paths.includes(f.path)), fileSelection: [] })), 'Discard', true);
}

export function clickRefSelection(name: string, mods: { meta: boolean; shift: boolean }, order: string[]) {
  updateRepo((r) => {
    const n = nextSelection(r.refSelection, r.refAnchor, name, mods, order);
    return { refSelection: n.sel, refAnchor: n.anchor };
  });
}
export function clearRefSelection() {
  if (activeRepo()?.refSelection.length) updateRepo({ refSelection: [], refAnchor: null });
}
/** delete the given branches (the batch dialog); a mock repository just forgets them */
export function deleteBranchesBatch(names: string[], opts: { force: boolean; withRemote: boolean }) {
  if (live.isLiveActive()) return void live.deleteBranchesBatch(names, opts);
  closeDialog();
  updateRepo((r) => ({ refs: r.refs.filter((x) => !names.includes(x.name) || x.current), refSelection: [], refAnchor: null }));
  toast(`Deleted ${names.length} branches (mock)`, 'info');
}
export function pushBranchesBatch(names: string[]) {
  if (live.isLiveActive()) return live.pushBranchesBatch(names);
  toast(`Pushed ${names.length} branches (mock)`, 'success');
}
/** the history shows only the selected branches (their funnels lit); `add` keeps the ones already in the filter */
export function filterToSelection(add = false) {
  const r = activeRepo();
  if (!r?.refSelection.length) return;
  const refs = add && r.graphFilter.mode === 'selected' ? [...new Set([...r.graphFilter.refs, ...r.refSelection])] : [...r.refSelection];
  updateRepo((rr) => ({ graphFilter: { ...rr.graphFilter, mode: 'selected', refs } }));
  if (live.isLiveActive()) void live.applyGraphFilter();
}

/** Fork-style branch filter: the funnel next to a branch */
export function toggleBranchFilter(name: string) {
  updateRepo((r) => ({ graphFilter: toggleFilterRef(r.graphFilter, name) }));
  if (live.isLiveActive()) void live.applyGraphFilter();
}
export function clearBranchFilter() {
  setGraphFilter({ mode: 'all', refs: [] });
}
let revealNonce = 0;
/** Select a commit and scroll the history to it (a click on a branch or tag in the sidebar). */
export function revealCommit(sha: Sha) {
  if (live.isLiveActive()) return void live.revealCommit(sha);
  selectCommit(sha);
  updateRepo({ reveal: { sha, nonce: ++revealNonce } });
}
export const nextRevealNonce = () => ++revealNonce;

// ---------- repositories ----------

function makeRepoState(id: string, snap: RepoSnapshot): RepoState {
  return {
    ...EMPTY_REPO,
    ...snap,
    collapsedGroups: { ...DEFAULT_COLLAPSED_GROUPS },
    fileView: state.fileView,
    diffMode: state.diffMode,
    id,
    selectedCommit: snap.head,
    selectedFile: snap.commits.find((c) => c.sha === snap.head)?.files?.[0]?.path ?? null,
  };
}

export function openRepo(id: string) {
  const info = state.repos.find((r) => r.id === id);
  if (!info) return;
  if (!inWorkspace(info, state.activeWorkspace)) switchWorkspace(info.workspace);
  if (info.live) {
    void live.openLive(id);
    return;
  }
  const repoStates = { ...state.repoStates };
  if (!repoStates[id]) {
    repoStates[id] = makeRepoState(id, id === 'prong' ? buildSnapshot() : buildSmallSnapshot());
  }
  const tabs = state.tabs.includes(id) ? state.tabs : [...state.tabs, id];
  setState({
    repoStates,
    tabs,
    activeTab: id,
    screen: 'repo',
    repos: state.repos.map((r) => (r.id === id ? { ...r, lastOpened: Date.now() } : r)),
  });
}

/**
 * Closes a tab. The active one hands over to its neighbour (the next one, else the one before), which is read
 * first when it has not been shown yet (a tab restored from the last session: it used to show an empty
 * repository). The start screen stays the start screen.
 */
export function closeTab(id: string) {
  const at = state.tabs.indexOf(id);
  const tabs = state.tabs.filter((t) => t !== id);
  if (state.activeTab !== id) return setState({ tabs });
  const next = tabs[Math.min(Math.max(0, at), tabs.length - 1)] ?? null;
  const onStart = state.screen === 'welcome';
  setState({ tabs, activeTab: next, screen: next && !onStart ? 'repo' : 'welcome' });
  if (next && !onStart) activateTab(next);
}

export function goWelcome() {
  setState({ screen: 'welcome' });
}

export function activateTab(id: string) {
  // a tab restored after an interface reload is loaded when first shown
  if (!state.repoStates[id] && state.repos.find((r) => r.id === id)?.live) {
    void live.openLive(id);
    return;
  }
  setState({ activeTab: id, screen: 'repo' });
}

export function togglePin(id: string) {
  const info = state.repos.find((r) => r.id === id);
  // kept by the engine: a pin used to be lost on the next launch
  if (info?.live && info.path) void live.client.pinRepo(info.path, !info.pinned).catch((e) => toast('Could not save the pin', 'error', String(e?.message ?? e)));
  setState((s) => ({ repos: s.repos.map((r) => (r.id === id ? { ...r, pinned: !r.pinned } : r)) }));
}

export function removeRepo(id: string) {
  const info = state.repos.find((r) => r.id === id);
  if (info?.live && info.path) void live.client.forgetRepo(info.path).catch(() => {});
  if (state.tabs.includes(id)) closeTab(id);
  setState((s) => ({ repos: s.repos.filter((r) => r.id !== id), activeTab: s.activeTab === id ? null : s.activeTab }));
}

/** `name`: the folder made in `dir` (the address's last part when not given) */
export function cloneRepo(url: string, dir: string, recursive: boolean, auth?: RepoAuth | null, partial = false, name?: string) {
  if (!state.engine.online) {
    toast('Git engine is offline', 'error', 'start it with npm run server (or use Prong.app)');
    return;
  }
  void live.clone(url, dir, recursive, auth, partial, name);
}

export function openLocalRepo(path: string) {
  if (!state.engine.online) {
    toast('Git engine is offline', 'error', 'start it with npm run server (or use Prong.app)');
    return;
  }
  void live.openPath(path);
}

// ---------- selection ----------

export function setSection(section: Section) {
  if (live.isLiveActive()) return live.setSection(section);
  updateRepo((r) => {
    if (section === 'changes') {
      const first = r.unstaged[0] ?? r.staged[0];
      return {
        section,
        selectedArea: r.unstaged[0] ? 'unstaged' : 'staged',
        selectedFile: r.selectedArea === 'commit' || r.selectedArea === 'stash' ? first?.path ?? null : r.selectedFile,
      };
    }
    const commit = r.commits.find((c) => c.sha === r.selectedCommit) ?? r.commits[0];
    return { section, selectedArea: 'commit', selectedCommit: commit?.sha ?? null, selectedStash: null, selectedFile: commit?.files?.[0]?.path ?? null };
  });
}

export function selectCommit(sha: Sha) {
  if (live.isLiveActive()) return live.selectCommit(sha);
  updateRepo((r) => {
    const commit = findCommit(r, sha);
    return { section: 'commits', selectedCommit: sha, selectedStash: null, selectedArea: 'commit', selectedFile: commit?.files?.[0]?.path ?? null };
  });
}

export function selectStash(index: number) {
  if (live.isLiveActive()) return live.selectStash(index);
  updateRepo((r) => {
    const st = r.stashes.find((s) => s.index === index);
    return { section: 'commits', selectedStash: index, selectedCommit: st?.sha ?? null, selectedArea: 'stash', selectedFile: st?.files[0]?.path ?? null };
  });
}

/** `keepPicked`: the ⌘/Shift selection stays (a click within it); otherwise this file alone */
export function selectFile(area: Area, path: string, keepPicked = false) {
  if (live.isLiveActive()) return live.selectFile(area, path, keepPicked);
  updateRepo(keepPicked ? { selectedArea: area, selectedFile: path } : { selectedArea: area, selectedFile: path, fileSelection: [], fileAnchor: path });
}

export function setSearch(search: string) {
  updateRepo({ search });
  // a live repository searches the whole history too (a moment after the typing stops)
  if (live.isLiveActive()) live.searchCommitsSoon();
}
export function setGraphFilter(patch: Partial<GraphFilter>) {
  updateRepo((r) => ({ graphFilter: { ...r.graphFilter, ...patch } }));
  if (live.isLiveActive()) void live.applyGraphFilter();
}
export function toggleGraphRef(name: string) {
  updateRepo((r) => {
    const f = r.graphFilter;
    // switching from "all"/"current" to an explicit selection starts from every ref
    const base = f.mode === 'selected' ? f.refs : r.refs.filter((x) => x.kind !== 'stash' && x.name !== 'origin/HEAD').map((x) => x.name);
    const refs = base.includes(name) ? base.filter((x) => x !== name) : [...base, name];
    return { graphFilter: { ...f, mode: 'selected', refs } };
  });
  if (live.isLiveActive()) void live.applyGraphFilter();
}
export function showOnlyRef(name: string) {
  updateRepo((r) => ({ graphFilter: { ...r.graphFilter, mode: 'selected', refs: [name] } }));
  if (live.isLiveActive()) void live.applyGraphFilter();
}
export function isRefVisible(r: RepoState, name: string) {
  const f = r.graphFilter;
  if (f.mode === 'all') return !(f.hideRemotes && name.includes('/') && r.refs.find((x) => x.name === name)?.kind === 'remote');
  if (f.mode === 'current') return !!r.refs.find((x) => x.name === name)?.current;
  return f.refs.includes(name);
}
export function toggleMerge(sha: Sha) {
  updateRepo((r) => {
    const c = findCommit(r, sha);
    if (!c || c.parents.length < 2) return {};
    const collapsedMerges = { ...r.collapsedMerges };
    if (collapsedMerges[sha]) delete collapsedMerges[sha];
    else collapsedMerges[sha] = true;
    return { collapsedMerges };
  });
}
export function setMergeCollapsed(sha: Sha, collapsed: boolean) {
  updateRepo((r) => {
    // ← on a plain commit folds nothing (it used to mark it, and the graph drew it as a folded merge)
    const c = findCommit(r, sha);
    if (collapsed && (!c || c.parents.length < 2)) return {};
    if (!collapsed && !r.collapsedMerges[sha]) return {};
    const collapsedMerges = { ...r.collapsedMerges };
    if (collapsed) collapsedMerges[sha] = true;
    else delete collapsedMerges[sha];
    return { collapsedMerges };
  });
}
export function collapseAllMerges() {
  updateRepo((r) => {
    const collapsedMerges: Record<Sha, boolean> = {};
    for (const c of r.filteredCommits ?? r.commits) if (c.parents.length > 1) collapsedMerges[c.sha] = true;
    return { collapsedMerges };
  });
}
export function expandAllMerges() {
  updateRepo({ collapsedMerges: {} });
}
/** list/tree is remembered globally: the choice applies to every repository and survives restarts */
export function setFileView(fileView: 'list' | 'tree') {
  setState((s) => ({ fileView, repoStates: Object.fromEntries(Object.entries(s.repoStates).map(([k, r]) => [k, { ...r, fileView }])) }));
  live.persistUi({ fileView });
}
export function setDiffMode(diffMode: 'unified' | 'split') {
  setState((s) => ({ diffMode, repoStates: Object.fromEntries(Object.entries(s.repoStates).map(([k, r]) => [k, { ...r, diffMode }])) }));
  live.persistUi({ diffMode });
}
export function toggleTabGroup(id: string) {
  setState((s) => ({ collapsedTabGroups: { ...s.collapsedTabGroups, [id]: !s.collapsedTabGroups[id] } }));
}
export function setSubmoduleView(submoduleView: 'list' | 'tree') {
  setState({ submoduleView });
  live.persistUi({ submoduleView });
}
export function setCommitAction(commitAction: 'commit' | 'commit-push') {
  setState({ commitAction });
  live.persistUi({ commitAction });
}
/** Applies persisted UI preferences (engine settings or local storage) without writing them back. */
export function applyUiPrefs(ui: Partial<{ theme: string; uiScale: number; fileView: 'list' | 'tree'; diffMode: 'unified' | 'split'; sidebarWidth: number; submoduleView: 'list' | 'tree'; commitAction: 'commit' | 'commit-push'; commitBoxHeight: number; detailsHeaderHeight: number; commitDescOpen: boolean; detailsDescOpen: boolean; detailsRatio: number; sync: Partial<SyncPrefs> }>) {
  setState((s) => ({
    syncPrefs: ui.sync ? { ...s.syncPrefs, ...ui.sync } : s.syncPrefs,
    commitDescOpen: ui.commitDescOpen ?? s.commitDescOpen,
    detailsDescOpen: ui.detailsDescOpen ?? s.detailsDescOpen,
    submoduleView: ui.submoduleView ?? s.submoduleView,
    commitAction: ui.commitAction ?? s.commitAction,
    theme: ui.theme && (ui.theme as ThemeName) in THEMES ? (ui.theme as ThemeName) : s.theme,
    uiScale: ui.uiScale ? Math.min(2, Math.max(0.6, ui.uiScale)) : s.uiScale,
    fileView: ui.fileView ?? s.fileView,
    diffMode: ui.diffMode ?? s.diffMode,
    layout: {
      ...s.layout,
      ...(ui.sidebarWidth ? { sidebar: Math.max(170, Math.min(420, ui.sidebarWidth)) } : {}),
      ...(ui.commitBoxHeight ? { commitBox: Math.max(COMMIT_BOX_MIN, Math.min(640, ui.commitBoxHeight)) } : {}),
      ...(ui.detailsHeaderHeight ? { detailsHeader: Math.max(DETAILS_HEADER_MIN, Math.min(480, ui.detailsHeaderHeight)) } : {}),
      ...(ui.detailsRatio ? { details: Math.max(0.2, Math.min(0.8, ui.detailsRatio)) } : {}),
    },
    repoStates: ui.fileView || ui.diffMode ? Object.fromEntries(Object.entries(s.repoStates).map(([k, r]) => [k, { ...r, fileView: ui.fileView ?? r.fileView, diffMode: ui.diffMode ?? r.diffMode }])) : s.repoStates,
  }));
}
export function toggleGroup(key: string) {
  updateRepo((r) => ({ collapsedGroups: { ...r.collapsedGroups, [key]: !r.collapsedGroups[key] } }));
}
export function toggleHunk(id: string) {
  updateRepo((r) => ({ collapsedHunks: { ...r.collapsedHunks, [id]: !r.collapsedHunks[id] } }));
}
export function loadLarge(path: string) {
  if (live.isLiveActive()) return live.loadLarge(path);
  updateRepo((r) => ({ loadedLarge: { ...r.loadedLarge, [path]: true } }));
}
export function setCommitMessage(commitMessage: string) {
  updateRepo({ commitMessage });
}
export function setCommitDescription(commitDescription: string) {
  updateRepo({ commitDescription });
}
/**
 * Amend on: an empty box gets the last commit's message (what is typed stays). Off: that loaded message goes
 * again, unless it was edited; a message the user typed stays (unticking used to wipe it).
 */
export function toggleAmend() {
  updateRepo((r) => {
    const amend = !r.amend;
    const head = r.commits.find((c) => c.sha === r.head);
    if (amend) return !r.commitMessage.trim() && !r.commitDescription.trim() ? { amend, commitMessage: head?.subject ?? '', commitDescription: head?.body ?? '' } : { amend };
    const loaded = !!head && r.commitMessage === head.subject && r.commitDescription === (head.body ?? '');
    return loaded ? { amend, commitMessage: '', commitDescription: '' } : { amend };
  });
  // ticked before the history arrived (a big repository, a tab just opened): the last commit's message is read
  if (live.isLiveActive()) void live.fillAmendMessage();
}

// ---------- staging ----------

const byPath = (a: FileChange, b: FileChange) => a.path.localeCompare(b.path);

export function stageFile(path: string) {
  if (live.isLiveActive()) return live.stageFile(path);
  updateRepo((r) => {
    const f = r.unstaged.find((x) => x.path === path);
    if (!f) return {};
    if (f.status === 'U' && f.conflict) {
      toast('Resolve the conflict first', 'error');
      return {};
    }
    const existing = r.staged.find((x) => x.path === path);
    const merged: FileChange = existing
      ? { ...existing, hunks: [...(existing.hunks ?? []), ...(f.hunks ?? [])], additions: existing.additions + f.additions, deletions: existing.deletions + f.deletions }
      : f;
    const unstaged = r.unstaged.filter((x) => x !== f);
    const staged = [...r.staged.filter((x) => x.path !== path), merged].sort(byPath);
    const next = unstaged[0] ?? staged[0];
    return { unstaged, staged, selectedArea: unstaged[0] ? 'unstaged' : 'staged', selectedFile: r.selectedFile === path ? next?.path ?? null : r.selectedFile };
  });
}

export function unstageFile(path: string) {
  if (live.isLiveActive()) return live.unstageFile(path);
  updateRepo((r) => {
    const f = r.staged.find((x) => x.path === path);
    if (!f) return {};
    const existing = r.unstaged.find((x) => x.path === path);
    const merged: FileChange = existing
      ? { ...existing, hunks: [...(existing.hunks ?? []), ...(f.hunks ?? [])], additions: existing.additions + f.additions, deletions: existing.deletions + f.deletions }
      : f;
    const staged = r.staged.filter((x) => x !== f);
    const unstaged = [...r.unstaged.filter((x) => x.path !== path), merged].sort(byPath);
    return { unstaged, staged, selectedArea: 'unstaged', selectedFile: path };
  });
}

export function stageAll() {
  if (live.isLiveActive()) return live.stageAll();
  updateRepo((r) => {
    const conflicts = r.unstaged.filter((f) => f.status === 'U' && f.conflict);
    const movable = r.unstaged.filter((f) => !conflicts.includes(f));
    return { unstaged: conflicts, staged: [...r.staged, ...movable].sort(byPath), selectedArea: 'staged', selectedFile: movable[0]?.path ?? r.selectedFile };
  });
}
export function unstageAll() {
  if (live.isLiveActive()) return live.unstageAll();
  updateRepo((r) => ({ unstaged: [...r.unstaged, ...r.staged].sort(byPath), staged: [], selectedArea: 'unstaged' }));
}

export function discardFile(path: string) {
  if (live.isLiveActive()) return live.discardFile(path);
  const r = activeRepo();
  if (!r) return;
  confirm('Discard changes?', `All changes in ${path} will be lost. This cannot be undone.`, () => {
    updateRepo((rr) => {
      const unstaged = rr.unstaged.filter((f) => f.path !== path);
      return { unstaged, selectedFile: rr.selectedFile === path ? unstaged[0]?.path ?? null : rr.selectedFile };
    });
    toast(`Discarded ${path}`, 'info');
  }, 'Discard', true);
}

export function discardAll() {
  if (live.isLiveActive()) return live.discardAll();
  confirm('Discard all changes?', 'All unstaged changes in the working copy will be lost.', () => {
    updateRepo({ unstaged: [], selectedFile: null });
    toast('Discarded all unstaged changes', 'info');
  }, 'Discard all', true);
}

export function stageHunk(path: string, hunkId: string) {
  if (live.isLiveActive()) return live.stageHunk(path, hunkId);
  updateRepo((r) => {
    const f = r.unstaged.find((x) => x.path === path);
    const h = f?.hunks?.find((x) => x.id === hunkId);
    if (!f || !h) return {};
    const restHunks = f.hunks!.filter((x) => x !== h);
    const existing = r.staged.find((x) => x.path === path);
    const stagedFile: FileChange = existing
      ? { ...existing, hunks: [...(existing.hunks ?? []), h] }
      : { ...cloneFile(f), hunks: [h] };
    recount(stagedFile);
    let unstaged: FileChange[];
    if (restHunks.length === 0) unstaged = r.unstaged.filter((x) => x !== f);
    else {
      const nf = { ...f, hunks: restHunks };
      recount(nf);
      unstaged = r.unstaged.map((x) => (x === f ? nf : x));
    }
    const staged = [...r.staged.filter((x) => x.path !== path), stagedFile].sort(byPath);
    const stillThere = unstaged.some((x) => x.path === path);
    return { unstaged, staged, selectedArea: stillThere ? 'unstaged' : 'staged' };
  });
}

export function unstageHunk(path: string, hunkId: string) {
  if (live.isLiveActive()) return live.unstageHunk(path, hunkId);
  updateRepo((r) => {
    const f = r.staged.find((x) => x.path === path);
    const h = f?.hunks?.find((x) => x.id === hunkId);
    if (!f || !h) return {};
    const restHunks = f.hunks!.filter((x) => x !== h);
    const existing = r.unstaged.find((x) => x.path === path);
    const unFile: FileChange = existing ? { ...existing, hunks: [...(existing.hunks ?? []), h] } : { ...cloneFile(f), hunks: [h] };
    recount(unFile);
    let staged: FileChange[];
    if (restHunks.length === 0) staged = r.staged.filter((x) => x !== f);
    else {
      const nf = { ...f, hunks: restHunks };
      recount(nf);
      staged = r.staged.map((x) => (x === f ? nf : x));
    }
    const unstaged = [...r.unstaged.filter((x) => x.path !== path), unFile].sort(byPath);
    const stillThere = staged.some((x) => x.path === path);
    return { unstaged, staged, selectedArea: stillThere ? 'staged' : 'unstaged' };
  });
}

/** stage / unstage / discard only the picked changed lines of a hunk (live repositories) */
export function stageLines(path: string, hunkId: string, lines: number[]) {
  if (live.isLiveActive()) return live.stageLines(path, hunkId, lines);
  toast('Line staging needs a repository opened through the engine', 'info');
}
export function unstageLines(path: string, hunkId: string, lines: number[]) {
  if (live.isLiveActive()) return live.unstageLines(path, hunkId, lines);
  toast('Line staging needs a repository opened through the engine', 'info');
}
export function discardLines(path: string, hunkId: string, lines: number[]) {
  if (live.isLiveActive()) return live.discardLines(path, hunkId, lines);
  toast('Line staging needs a repository opened through the engine', 'info');
}
export function discardHunk(path: string, hunkId: string) {
  if (live.isLiveActive()) return live.discardHunk(path, hunkId);
  confirm('Discard hunk?', 'The selected hunk will be reverted in the working copy.', () => {
    updateRepo((r) => {
      const f = r.unstaged.find((x) => x.path === path);
      if (!f?.hunks) return {};
      const restHunks = f.hunks.filter((x) => x.id !== hunkId);
      if (restHunks.length === 0) {
        const unstaged = r.unstaged.filter((x) => x !== f);
        return { unstaged, selectedFile: unstaged[0]?.path ?? null };
      }
      const nf = { ...f, hunks: restHunks };
      recount(nf);
      return { unstaged: r.unstaged.map((x) => (x === f ? nf : x)) };
    });
  }, 'Discard', true);
}

function recount(f: FileChange) {
  let a = 0;
  let d = 0;
  for (const h of f.hunks ?? [])
    for (const l of h.lines) {
      if (l.kind === 'add') a++;
      if (l.kind === 'del') d++;
    }
  f.additions = a;
  f.deletions = d;
}

/** a conflicted file edited by hand: marked resolved (staged) */
export function markResolved(path: string) {
  if (live.isLiveActive()) return live.markResolved(path);
  updateRepo((r) => {
    const f = r.unstaged.find((x) => x.path === path);
    if (!f) return {};
    const resolved: FileChange = { ...f, status: 'M', conflict: undefined };
    return { unstaged: r.unstaged.filter((x) => x !== f), staged: [...r.staged.filter((x) => x.path !== path), resolved].sort(byPath) };
  });
}
export function resolveConflict(path: string, take: 'ours' | 'theirs' | 'both') {
  if (live.isLiveActive()) return live.resolveConflict(path, take);
  updateRepo((r) => {
    const f = r.unstaged.find((x) => x.path === path);
    if (!f?.conflict) return {};
    const result = take === 'ours' ? f.conflict.ours : take === 'theirs' ? f.conflict.theirs : [...f.conflict.ours, ...f.conflict.theirs];
    const lines = [
      ...f.conflict.base.map((t, i) => ({ kind: 'del' as const, oldNo: i + 1, text: t })),
      ...result.map((t, i) => ({ kind: 'add' as const, newNo: i + 1, text: t })),
    ];
    const resolved: FileChange = {
      ...f,
      status: 'M',
      conflict: undefined,
      hunks: [{ id: `resolved-${Date.now()}`, header: `@@ -1,${f.conflict.base.length} +1,${result.length} @@`, lines }],
    };
    recount(resolved);
    return { unstaged: r.unstaged.map((x) => (x === f ? resolved : x)) };
  });
  toast(`Resolved ${path} using ${take}`, 'success');
}

// ---------- commits ----------

function currentBranch(r: RepoState) {
  return r.refs.find((x) => x.kind === 'branch' && x.current) ?? null;
}

export function commit(andPush = false) {
  if (live.isLiveActive()) return live.commit(andPush);
  const r = activeRepo();
  if (!r) return;
  if (!r.commitMessage.trim()) {
    toast('Commit message is empty', 'info', 'Write a summary first');
    return;
  }
  if (r.staged.length === 0 && !r.amend) {
    toast('Nothing staged', 'info', 'Stage files first (Space, or + on a file)');
    return;
  }
  const branch = currentBranch(r);
  updateRepo((rr) => {
    const headCommit = rr.commits.find((c) => c.sha === rr.head);
    const newSha = fakeSha(`${rr.commitMessage}-${Date.now()}`);
    let commits: Commit[];
    if (rr.amend && headCommit) {
      const amended: Commit = { ...headCommit, sha: newSha, subject: rr.commitMessage.trim(), body: rr.commitDescription.trim(), files: [...(headCommit.files ?? []), ...rr.staged], date: Date.now() };
      commits = rr.commits.map((c) => (c === headCommit ? amended : c));
    } else {
      const c: Commit = {
        sha: newSha,
        parents: rr.head ? [rr.head] : [],
        subject: rr.commitMessage.trim(),
        body: rr.commitDescription.trim(),
        author: 'Andrei Zenkovich',
        email: 'andrei@zenkovich.space',
        date: Date.now(),
        files: rr.staged,
      };
      commits = [c, ...rr.commits];
    }
    const refs = rr.refs.map((x) => {
      if (x.kind === 'branch' && x.current) return { ...x, sha: newSha, ahead: (x.ahead ?? 0) + (rr.amend ? 0 : 1) };
      if (x.sha === rr.head && x.kind === 'head') return { ...x, sha: newSha };
      return x;
    });
    return { commits, refs, head: newSha, staged: [], commitMessage: '', commitDescription: '', amend: false, mergeInProgress: undefined };
  });
  toast(r.amend ? 'Amended last commit' : `Committed to ${branch?.name ?? 'HEAD'}`, 'success');
  if (andPush) push();
}

/** the dialogs' choices for next time (local at once, the engine's settings shortly after) */
export function setSyncPrefs(patch: Partial<SyncPrefs>) {
  setState((s) => ({ syncPrefs: { ...s.syncPrefs, ...patch } }));
  live.persistUi({ sync: getState().syncPrefs });
}

export function fetch(opts: FetchOptions = {}) {
  if (live.isLiveActive()) return live.fetch(opts);
  closeDialog();
  runOperation('Fetching origin', 1400, ['From github.com:zenkovich/prong', ' * [new branch]      feature/blame -> origin/feature/blame', '   a1f3c2d..9be41ac  main       -> origin/main'], () => {
    updateRepo((r) => {
      const has = r.refs.some((x) => x.name === 'origin/feature/blame');
      if (has) return {};
      return { refs: [...r.refs, { name: 'origin/feature/blame', kind: 'remote', sha: r.refs.find((x) => x.name === 'origin/main')?.sha ?? r.head }] };
    });
    toast('Fetched origin', 'success', '1 new branch');
  });
}

/**
 * Widens a narrow (`--single-branch`) clone: the remote starts following every branch and is fetched, so its other
 * branches appear. A plain fetch never brings them — git asks only for the branches in the remote's fetch list.
 */
export function followAllBranches(remote?: string) {
  if (live.isLiveActive()) return live.followAllBranches(remote);
  closeDialog();
  const name = remote ?? activeRepo()?.remotes[0]?.name ?? 'origin';
  runOperation(`Fetching every branch of ${name}`, 1500, [`${name} follows every branch from now on`, `From github.com:zenkovich/prong`, ' * [new branch]      legacy/v1 -> origin/legacy/v1'], () => {
    updateRepo((r) => ({ remotes: r.remotes.map((x) => (x.name === name ? { ...x, narrow: false } : x)) }));
    toast(`${name} follows every branch (mock)`, 'success');
  });
}

/** Completes a shallow clone: fetches the history `clone --depth` left out. */
export function unshallow(opts: { remote?: string; allBranches?: boolean } = {}) {
  if (live.isLiveActive()) return live.unshallow(opts);
  closeDialog();
  runOperation('Fetching the full history', 1600, ['remote: Enumerating objects: 24180, done.', 'From github.com:zenkovich/prong', ' * [new branch]      legacy/v1 -> origin/legacy/v1'], () => {
    updateRepo({ shallow: false });
    toast('Full history fetched (mock)', 'success');
  });
}

export function pull(opts: PullOptions | 'merge' | 'rebase' | 'ff' = {}) {
  if (live.isLiveActive()) return live.pull(opts);
  const strategy = (typeof opts === 'string' ? opts : opts.strategy) ?? 'merge';
  closeDialog();
  const r = activeRepo();
  const b = r ? currentBranch(r) : null;
  runOperation(`Pulling ${b?.name ?? ''} (${strategy})`, 1200, ['From github.com:zenkovich/prong', 'Already up to date.'], () => {
    if (b && (b.behind ?? 0) > 0) {
      updateRepo((rr) => ({ refs: rr.refs.map((x) => (x === b ? { ...x, behind: 0 } : x)) }));
      toast(`Pulled ${b.name}`, 'success', `${strategy}: ${b.behind} commit(s)`);
    } else toast('Already up to date', 'info');
  });
}

export function push(opts: PushOptions = {}) {
  if (live.isLiveActive()) return live.push(opts);
  closeDialog();
  const r = activeRepo();
  if (!r) return;
  const b = currentBranch(r);
  if (!b) return;
  if ((b.ahead ?? 0) === 0 && b.upstream) {
    toast('Everything up-to-date', 'info');
    return;
  }
  runOperation(
    `Pushing ${b.name} to origin${opts.force ? ' (force-with-lease)' : ''}`,
    1800,
    ['Enumerating objects: 23, done.', 'Counting objects: 100% (23/23), done.', 'Compressing objects: 100% (14/14), done.', 'Writing objects: 100% (16/16), 3.2 KiB | 1.6 MiB/s, done.', `To github.com:zenkovich/prong.git\n   9be41ac..${b.sha.slice(0, 7)}  ${b.name} -> ${b.name}`],
    () => {
      updateRepo((rr) => {
        const remoteName = `origin/${b.name}`;
        const hasRemote = rr.refs.some((x) => x.name === remoteName);
        let refs = rr.refs.map((x) => {
          if (x.name === b.name) return { ...x, ahead: 0, upstream: remoteName };
          if (x.name === remoteName) return { ...x, sha: b.sha };
          return x;
        });
        if (!hasRemote) refs = [...refs, { name: remoteName, kind: 'remote', sha: b.sha }];
        return { refs };
      });
      toast(`Pushed ${b.name}`, 'success');
    },
  );
}

export function checkout(name: string) {
  if (live.isLiveActive()) return live.checkout(name);
  const r = activeRepo();
  if (!r) return;
  if (r.unstaged.length + r.staged.length > 0 && r.unstaged.some((f) => f.status === 'U')) {
    toast('Cannot checkout: unresolved conflicts', 'error');
    return;
  }
  const ref = r.refs.find((x) => x.name === name);
  if (!ref) return;
  if (ref.kind === 'remote') {
    const local = name.replace(/^origin\//, '');
    if (!r.refs.some((x) => x.name === local && x.kind === 'branch')) {
      updateRepo((rr) => ({ refs: [...rr.refs.map((x) => ({ ...x, current: false })), { name: local, kind: 'branch', sha: ref.sha, current: true, upstream: name, ahead: 0, behind: 0 }], head: ref.sha }));
      toast(`Created and checked out ${local}`, 'success', `tracking ${name}`);
      return;
    }
    checkout(local);
    return;
  }
  updateRepo((rr) => ({ refs: rr.refs.map((x) => ({ ...x, current: x.kind === 'branch' && x.name === name })), head: ref.sha }));
  setState((s) => ({ repos: s.repos.map((x) => (x.id === s.activeTab ? { ...x, currentBranch: name } : x)) }));
  toast(`Checked out ${name}`, 'success');
}

export function createBranch(name: string, sha: Sha, doCheckout: boolean) {
  if (live.isLiveActive()) return live.createBranch(name, sha, doCheckout);
  closeDialog();
  if (!name.trim()) return;
  updateRepo((r) => {
    if (r.refs.some((x) => x.name === name && x.kind === 'branch')) {
      toast(`Branch ${name} already exists`, 'error');
      return {};
    }
    const refs = [...r.refs.map((x) => (doCheckout ? { ...x, current: false } : x)), { name, kind: 'branch' as const, sha, current: doCheckout, ahead: 0, behind: 0 }];
    return { refs, head: doCheckout ? sha : r.head };
  });
  toast(`Created branch ${name}`, 'success');
}

export function deleteBranch(name: string, remote = false) {
  if (live.isLiveActive()) return live.deleteBranch(name, remote);
  const r = activeRepo();
  const ref = r?.refs.find((x) => x.name === name);
  if (!ref) return;
  if (ref.current) {
    toast('Cannot delete the current branch', 'error');
    return;
  }
  confirm(`Delete ${ref.kind === 'remote' ? 'remote branch' : 'branch'} ${name}?`, remote ? 'The branch will also be deleted on origin.' : 'Commits that are only reachable from this branch will become dangling.', () => {
    updateRepo((rr) => ({ refs: rr.refs.filter((x) => x.name !== name && (!remote || x.name !== `origin/${name}`)) }));
    toast(`Deleted ${name}`, 'info');
  }, 'Delete', true);
}

export function renameBranch(oldName: string, newName: string) {
  if (live.isLiveActive()) return live.renameBranch(oldName, newName);
  updateRepo((r) => ({ refs: r.refs.map((x) => (x.name === oldName && x.kind === 'branch' ? { ...x, name: newName } : x)) }));
  toast(`Renamed ${oldName} → ${newName}`, 'success');
}

/** `message`: an annotated tag's message (its name when empty); `remote`: where "push" sends it */
export function createTag(name: string, sha: Sha, annotated: boolean, pushIt: boolean, message?: string, remote?: string) {
  if (live.isLiveActive()) return live.createTag(name, sha, annotated, pushIt, message, remote);
  closeDialog();
  if (!name.trim()) return;
  updateRepo((r) => ({ refs: [...r.refs, { name, kind: 'tag', sha }] }));
  toast(`Created ${annotated ? 'annotated ' : ''}tag ${name}`, 'success');
  if (pushIt) runOperation(`Pushing tag ${name}`, 900, [`To github.com:zenkovich/prong.git\n * [new tag]  ${name} -> ${name}`], () => toast(`Pushed tag ${name}`, 'success'));
}

export function deleteTag(name: string) {
  if (live.isLiveActive()) return live.deleteTag(name);
  confirm(`Delete tag ${name}?`, 'The tag is removed locally only.', () => {
    updateRepo((r) => ({ refs: r.refs.filter((x) => !(x.kind === 'tag' && x.name === name)) }));
    toast(`Deleted tag ${name}`, 'info');
  }, 'Delete', true);
}

export function merge(source: string, opts: { noFf?: boolean; squash?: boolean } = {}) {
  if (live.isLiveActive()) return live.merge(source, opts);
  closeDialog();
  const r = activeRepo();
  if (!r) return;
  const src = r.refs.find((x) => x.name === source);
  const b = currentBranch(r);
  if (!src || !b) return;
  runOperation(`Merging ${source} into ${b.name}`, 1100, ['Auto-merging src/components/MergeBar.tsx', 'Merge made by the \'ort\' strategy.'], () => {
    updateRepo((rr) => {
      const sha = fakeSha(`merge-${source}-${Date.now()}`);
      const c: Commit = {
        sha,
        parents: opts.squash ? [rr.head] : [rr.head, src.sha],
        subject: opts.squash ? `Squash merge '${source}'` : `Merge branch '${source}' into ${b.name}`,
        body: '',
        author: 'Andrei Zenkovich',
        email: 'andrei@zenkovich.space',
        date: Date.now(),
        files: rr.commits.find((x) => x.sha === src.sha)?.files ?? [],
      };
      return { commits: [c, ...rr.commits], head: sha, refs: rr.refs.map((x) => (x === b ? { ...x, sha, ahead: (x.ahead ?? 0) + 1 } : x)), selectedCommit: sha };
    });
    toast(`Merged ${source}`, 'success');
  });
}

export interface RebaseTodo {
  sha: Sha;
  action: 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
  message: string;
}

/** Commits on the current branch that are not reachable from `onto` (first-parent walk, mock). */
export function commitsToRebase(r: RepoState, ontoSha: Sha): Commit[] {
  const reachable = new Set<Sha>();
  const stack = [ontoSha];
  const map = new Map(r.commits.map((c) => [c.sha, c]));
  while (stack.length) {
    const s = stack.pop()!;
    if (reachable.has(s)) continue;
    reachable.add(s);
    map.get(s)?.parents.forEach((p) => stack.push(p));
  }
  const out: Commit[] = [];
  let cur: Commit | undefined = map.get(r.head);
  while (cur && !reachable.has(cur.sha)) {
    out.push(cur);
    cur = map.get(cur.parents[0]);
  }
  return out.reverse(); // oldest first
}

export function rebase(onto: string, todo?: RebaseTodo[], opts: { autostash?: boolean; preserveMerges?: boolean } = {}) {
  if (live.isLiveActive()) return live.rebase(onto, todo, opts);
  closeDialog();
  const r = activeRepo();
  if (!r) return;
  const ontoRef = r.refs.find((x) => x.name === onto);
  const b = currentBranch(r);
  if (!ontoRef || !b) return;
  const list = todo ?? commitsToRebase(r, ontoRef.sha).map((c) => ({ sha: c.sha, action: 'pick' as const, message: c.subject }));
  runOperation(
    `Rebasing ${b.name} onto ${onto}`,
    1600,
    list.map((t, i) => `Rebasing (${i + 1}/${list.length}) ${t.action} ${t.message}`).concat([`Successfully rebased and updated refs/heads/${b.name}.`]),
    () => {
      updateRepo((rr) => {
        const map = new Map(rr.commits.map((c) => [c.sha, c]));
        const old = commitsToRebase(rr, ontoRef.sha);
        const oldShas = new Set(old.map((c) => c.sha));
        let parent = ontoRef.sha;
        const created: Commit[] = [];
        for (const t of list) {
          const src = map.get(t.sha);
          if (!src || t.action === 'drop') continue;
          if ((t.action === 'squash' || t.action === 'fixup') && created.length) {
            const last = created[created.length - 1];
            last.files = [...(last.files ?? []), ...(src.files ?? [])];
            if (t.action === 'squash') last.body = (last.body ? last.body + '\n\n' : '') + t.message;
            continue;
          }
          const sha = fakeSha(`${t.sha}-rebased-${parent}-${Date.now()}`);
          created.push({ ...src, sha, parents: [parent], subject: t.action === 'reword' ? t.message : src.subject, date: Date.now() });
          parent = sha;
        }
        const commits = [...created.reverse(), ...rr.commits.filter((c) => !oldShas.has(c.sha))];
        const head = created[0]?.sha ?? ontoRef.sha;
        const refs = rr.refs.map((x) => (x === b ? { ...x, sha: head, ahead: created.length, behind: 0 } : x));
        return { commits, head, refs, selectedCommit: head, selectedFile: created[0]?.files?.[0]?.path ?? null };
      });
      toast(`Rebased ${b.name} onto ${onto}`, 'success', todo ? `${todo.filter((t) => t.action !== 'drop').length} commits applied` : undefined);
    },
  );
}

export function cherryPick(sha: Sha) {
  if (live.isLiveActive()) return live.cherryPick(sha);
  const r = activeRepo();
  const src = r?.commits.find((c) => c.sha === sha);
  if (!r || !src) return;
  const b = currentBranch(r);
  updateRepo((rr) => {
    const nsha = fakeSha(`cp-${sha}-${Date.now()}`);
    const c: Commit = { ...src, sha: nsha, parents: [rr.head], date: Date.now(), body: (src.body ? src.body + '\n\n' : '') + `(cherry picked from commit ${sha})` };
    return { commits: [c, ...rr.commits], head: nsha, refs: rr.refs.map((x) => (x === b ? { ...x, sha: nsha, ahead: (x.ahead ?? 0) + 1 } : x)), selectedCommit: nsha };
  });
  toast(`Cherry-picked ${sha.slice(0, 7)}`, 'success');
}

export function revert(sha: Sha) {
  if (live.isLiveActive()) return live.revert(sha);
  const r = activeRepo();
  const src = r?.commits.find((c) => c.sha === sha);
  if (!r || !src) return;
  const b = currentBranch(r);
  updateRepo((rr) => {
    const nsha = fakeSha(`revert-${sha}-${Date.now()}`);
    const files = (src.files ?? []).map((f) => ({
      ...f,
      status: f.status === 'A' ? ('D' as const) : f.status === 'D' ? ('A' as const) : f.status,
      additions: f.deletions,
      deletions: f.additions,
      hunks: f.hunks?.map((h) => ({ ...h, lines: h.lines.map((l) => ({ ...l, kind: l.kind === 'add' ? ('del' as const) : l.kind === 'del' ? ('add' as const) : l.kind })) })),
    }));
    const c: Commit = { ...src, sha: nsha, parents: [rr.head], subject: `Revert "${src.subject}"`, body: `This reverts commit ${sha}.`, date: Date.now(), author: 'Andrei Zenkovich', email: 'andrei@zenkovich.space', files };
    return { commits: [c, ...rr.commits], head: nsha, refs: rr.refs.map((x) => (x === b ? { ...x, sha: nsha, ahead: (x.ahead ?? 0) + 1 } : x)), selectedCommit: nsha, selectedFile: files[0]?.path ?? null };
  });
  toast(`Reverted ${sha.slice(0, 7)}`, 'success');
}

export function reset(sha: Sha, mode: 'soft' | 'mixed' | 'hard') {
  if (live.isLiveActive()) return live.reset(sha, mode);
  closeDialog();
  const r = activeRepo();
  if (!r) return;
  const b = currentBranch(r);
  updateRepo((rr) => {
    // collect commits between head and sha (first-parent)
    const map = new Map(rr.commits.map((c) => [c.sha, c]));
    const dropped: Commit[] = [];
    let cur = map.get(rr.head);
    while (cur && cur.sha !== sha) {
      dropped.push(cur);
      cur = map.get(cur.parents[0]);
    }
    if (!cur) {
      toast('Target is not an ancestor of HEAD (mock limitation)', 'error');
      return {};
    }
    const droppedShas = new Set(dropped.map((c) => c.sha));
    const files = dropped.flatMap((c) => c.files ?? []);
    const commits = rr.commits.filter((c) => !droppedShas.has(c.sha));
    const refs = rr.refs.map((x) => (x === b ? { ...x, sha, ahead: Math.max(0, (x.ahead ?? 0) - dropped.length) } : x));
    const patch: Partial<RepoState> = { commits, refs, head: sha, selectedCommit: sha };
    if (mode === 'soft') patch.staged = [...rr.staged, ...files].sort(byPath);
    if (mode === 'mixed') patch.unstaged = [...rr.unstaged, ...files].sort(byPath);
    if (mode === 'hard') {
      patch.unstaged = [];
      patch.staged = [];
    }
    return patch;
  });
  toast(`Reset (${mode}) to ${sha.slice(0, 7)}`, 'success');
}

// ---------- stashes ----------

export function stash(message: string, keepStaged: boolean, includeUntracked: boolean) {
  if (live.isLiveActive()) return live.stash(message, keepStaged, includeUntracked);
  closeDialog();
  updateRepo((r) => {
    const moving = [...r.unstaged.filter((f) => includeUntracked || f.status !== '?'), ...(keepStaged ? [] : r.staged)];
    if (moving.length === 0) {
      toast('Nothing to stash', 'error');
      return {};
    }
    const st: Stash = { index: 0, message: message || `WIP on ${currentBranch(r)?.name ?? 'HEAD'}: ${r.commits.find((c) => c.sha === r.head)?.subject ?? ''}`, date: Date.now(), sha: fakeSha(`stash-${Date.now()}`), files: moving };
    const stashes = [st, ...r.stashes.map((s) => ({ ...s, index: s.index + 1 }))];
    return { stashes, unstaged: r.unstaged.filter((f) => !moving.includes(f)), staged: keepStaged ? r.staged : [], selectedFile: null };
  });
  toast('Saved working directory to stash', 'success');
}

export function applyStash(index: number, pop: boolean) {
  if (live.isLiveActive()) return live.applyStash(index, pop);
  updateRepo((r) => {
    const st = r.stashes.find((s) => s.index === index);
    if (!st) return {};
    const unstaged = [...r.unstaged, ...st.files.filter((f) => !r.unstaged.some((u) => u.path === f.path))].sort(byPath);
    const stashes = pop ? r.stashes.filter((s) => s !== st).map((s, i) => ({ ...s, index: i })) : r.stashes;
    return { unstaged, stashes, section: 'changes', selectedArea: 'unstaged', selectedFile: st.files[0]?.path ?? null, selectedStash: null };
  });
  toast(pop ? 'Popped stash' : 'Applied stash', 'success');
}

export function stashBranch(name: string, index: number) {
  if (live.isLiveActive()) return live.stashBranch(name, index);
  closeDialog();
  toast(`Created ${name} from stash@{${index}} (mock)`, 'success');
}
export function dropStash(index: number) {
  if (live.isLiveActive()) return live.dropStash(index);
  confirm('Drop stash?', 'The stashed changes will be lost.', () => {
    updateRepo((r) => ({ stashes: r.stashes.filter((s) => s.index !== index).map((s, i) => ({ ...s, index: i })), selectedStash: null, selectedArea: 'commit', selectedCommit: r.head }));
    toast('Dropped stash', 'info');
  }, 'Drop', true);
}

// ---------- accounts & keys ----------

export function addGitHubAccount(host: string, login: string) {
  if (state.engine.online) {
    void live.addAccount(host, login);
    return;
  }
  const id = `gh-${Date.now()}`;
  setState((s) => ({ accounts: [...s.accounts, { id, host, login, name: login, orgs: [], avatarColor: '#a371f7' }] }));
  toast(`Signed in as ${login}`, 'success');
}
export function removeGitHubAccount(id: string) {
  if (state.engine.online) {
    void live.removeAccount(id);
    return;
  }
  setState((s) => ({ accounts: s.accounts.filter((a) => a.id !== id) }));
  toast('Account removed', 'info');
}
export function generateSshKey(name: string, type: SshKey['type'], passphrase: boolean | string) {
  if (state.engine.online) {
    void live.generateKey(name, (type as 'ed25519' | 'rsa' | 'ecdsa') || 'ed25519', typeof passphrase === 'string' ? passphrase : '');
    return;
  }
  const id = `k-${Date.now()}`;
  setState((s) => ({
    sshKeys: [
      ...s.sshKeys,
      { id, name, type, fingerprint: `SHA256:${fakeSha(name).slice(0, 43)}`, publicKey: `ssh-${type} AAAA${fakeSha(name + 'pub')}... andrei@mbp`, inAgent: false, addedToGitHub: false, hasPassphrase: !!passphrase },
    ],
  }));
  toast(`Generated ~/.ssh/${name}`, 'success');
}
export function updateSshKey(id: string, patch: Partial<SshKey>) {
  setState((s) => ({ sshKeys: s.sshKeys.map((k) => (k.id === id ? { ...k, ...patch } : k)) }));
}
export function deleteSshKey(id: string) {
  confirm('Delete key?', 'Both private and public key files will be removed from ~/.ssh.', () => {
    setState((s) => ({ sshKeys: s.sshKeys.filter((k) => k.id !== id) }));
  }, 'Delete', true);
}

// ---------- helpers for views ----------

export function findHunk(r: RepoState): { file: FileChange | null; hunksEditable: boolean } {
  let file: FileChange | null = null;
  if (r.selectedArea === 'unstaged') file = r.unstaged.find((f) => f.path === r.selectedFile) ?? null;
  else if (r.selectedArea === 'staged') file = r.staged.find((f) => f.path === r.selectedFile) ?? null;
  else if (r.selectedArea === 'stash') file = r.stashes.find((s) => s.index === r.selectedStash)?.files.find((f) => f.path === r.selectedFile) ?? null;
  else file = findCommit(r, r.selectedCommit)?.files?.find((f) => f.path === r.selectedFile) ?? null;
  return { file, hunksEditable: r.selectedArea === 'unstaged' || r.selectedArea === 'staged' };
}

export function shortSha(sha: Sha) {
  return sha.slice(0, 7);
}

export function relTime(ts: number) {
  const d = Date.now() - ts;
  const m = Math.round(d / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function fullDate(ts: number) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}


// ---------- agent ----------

export function updateAgent(patch: Partial<AgentState> | ((a: AgentState) => Partial<AgentState>)) {
  setState((s) => ({ agent: { ...s.agent, ...(typeof patch === 'function' ? patch(s.agent) : patch) } }));
}
/** the full chat panel; opening it folds the command line away */
export function toggleAgent(open?: boolean) {
  updateAgent((a) => {
    const next = open ?? !a.open;
    return { open: next, bar: next ? false : a.bar };
  });
}
/** the chat panel on its Chat tab ("open chat", Ask AI): it used to open on whichever tab was last, e.g. Settings */
export function openAgentChat() {
  updateAgent({ open: true, bar: false, tab: 'chat' });
}
/** the compact command line in the tab bar */
export function toggleAgentBar(open?: boolean) {
  updateAgent((a) => ({ bar: open ?? !a.bar, open: (open ?? !a.bar) ? false : a.open }));
}
export function dismissAgentNotice(id: number) {
  updateAgent((a) => ({ notices: a.notices.filter((n) => n.id !== id) }));
}
export function agentStop() {
  if (live.agentReady()) void live.agentStop();
}
let noticeId = 0;
/**
 * End of a run: clears the busy state and, unless the chat panel is open (the answer is right there),
 * leaves a card with what was done that stays until closed.
 */
export function finishAgentRun(msgId: number, opts: { ok: boolean; error?: string; noChanges?: boolean }) {
  const a = state.agent;
  const durationMs = a.startedAt ? Date.now() - a.startedAt : undefined;
  updateAgent({ busy: false, status: null, startedAt: null });
  // the answer is in sight in the chat; with the panel on Changes or Settings the card still says it came
  if (state.agent.open && state.agent.tab === 'chat') return;
  const m = state.agent.messages.find((x) => x.id === msgId);
  if (!m) return;
  const cost = m.actions?.find((x) => x.startsWith('cost $'))?.slice(5);
  const actions = (m.actions ?? []).filter((x) => !x.startsWith('· ') && !x.startsWith('cost $'));
  const stopped = opts.error === 'Stopped';
  // past the cards that came back with the chat after an interface reload (their ids were counted by that page)
  noticeId = Math.max(noticeId, ...state.agent.notices.map((n) => n.id)) + 1;
  const notice: AgentNotice = {
    id: noticeId,
    msgId,
    ok: opts.ok,
    title: opts.noChanges ? 'No changes' : opts.ok ? (m.target === 'app' ? 'Interface updated' : 'Done') : stopped ? 'Stopped' : opts.error && /^No |^Interface build failed/.test(opts.error) ? opts.error : 'Failed',
    text: m.text.replace(/^\s*PRONG_TARGET:.*$/m, '').trim() || (opts.ok ? 'Finished without a reply.' : opts.error ?? 'The agent stopped.'),
    target: m.target,
    actions,
    versionId: m.versionId,
    cost,
    durationMs,
    time: Date.now(),
  };
  updateAgent((x) => ({ notices: [notice, ...x.notices].slice(0, 6) }));
}
export function setAgentTarget(target: AgentTarget) {
  updateAgent({ target });
}
export function setAgentTab(tab: AgentState['tab']) {
  updateAgent({ tab });
}
export function setAgentWidth(width: number) {
  updateAgent({ width: Math.max(280, Math.min(640, width)) });
}
export function updateAgentSettings(patch: Partial<AgentSettings>) {
  updateAgent((a) => ({ settings: { ...a.settings, ...patch } }));
}

/** Effective app modifications: factory + every applied version in order. */
export function effectiveMods(versions: AppVersion[]): AppMods {
  const out: AppMods = { ...FACTORY_MODS, hiddenToolbarButtons: [], extraToolbarButtons: [] };
  for (const v of versions) {
    if (v.status !== 'applied') continue;
    for (const k of Object.keys(v.patch) as (keyof AppMods)[]) {
      const val = v.patch[k] as any;
      if (k === 'hiddenToolbarButtons' || k === 'extraToolbarButtons') out[k] = Array.from(new Set([...out[k], ...(val as string[])]));
      else (out as any)[k] = val;
    }
  }
  return out;
}
export function useMods(): AppMods {
  const versions = useStore((s) => s.agent.versions);
  return useMemo(() => effectiveMods(versions), [versions]);
}

let msgId = 1;
function pushMessage(m: Omit<AgentMessage, 'id' | 'time'>) {
  const id = ++msgId;
  updateAgent((a) => ({ messages: [...a.messages, { ...m, id, time: Date.now() }] }));
  return id;
}

function runRepoAction(a: { run: string; arg?: string }): boolean {
  switch (a.run) {
    case 'createBranch': {
      const r = activeRepo();
      if (!r) return false;
      createBranch(a.arg!, r.head, true);
      return true;
    }
    case 'checkout': {
      const r = activeRepo();
      if (!r || !r.refs.some((x) => x.name === a.arg)) {
        toast(`No branch ${a.arg}`, 'error');
        return false;
      }
      checkout(a.arg!);
      return true;
    }
    case 'rebase': {
      const r = activeRepo();
      if (!r || !r.refs.some((x) => x.name === a.arg)) {
        toast(`No ref ${a.arg}`, 'error');
        return false;
      }
      rebase(a.arg!);
      return true;
    }
    case 'merge': {
      const r = activeRepo();
      if (!r || !r.refs.some((x) => x.name === a.arg)) {
        toast(`No ref ${a.arg}`, 'error');
        return false;
      }
      merge(a.arg!);
      return true;
    }
    case 'stageAll':
      stageAll();
      return true;
    case 'commit': {
      updateRepo({ commitMessage: a.arg ?? 'Update' });
      commit();
      return true;
    }
    case 'push':
      push();
      return true;
    case 'pull':
      pull('rebase');
      return true;
    case 'fetch':
      fetch();
      return true;
    case 'stash':
      stash('', false, true);
      return true;
    case 'collapseAll':
      collapseAllMerges();
      return true;
    case 'expandAll':
      expandAllMerges();
      return true;
    case 'section':
      setSection(a.arg as Section);
      return true;
    case 'scale':
      setUiScale(parseInt(a.arg ?? '100', 10) / 100);
      return true;
  }
  return false;
}

export function agentSend(text: string) {
  if (live.agentReady()) {
    void live.agentSend(text);
    return;
  }
  const clean = text.trim();
  if (!clean || state.agent.busy) return;
  pushMessage({ role: 'user', text: clean });
  if (state.engine.online) {
    // the offline demo agent never stands in for a missing Claude Code: it ran its scripted commands (create a
    // branch, commit, rebase, push) in the real repository
    const claude = state.agent.settings.provider === 'anthropic-claude-code';
    const id = pushMessage({
      role: 'agent',
      text: claude
        ? 'Claude Code не найден, запрос не выполнен. Установите его (`npm i -g @anthropic-ai/claude-code`) или укажите путь к нему в **Settings → Claude Code binary** и нажмите **check**.'
        : 'Этот провайдер пока не работает, запрос не выполнен. Выберите **Anthropic · local Claude Code** в Settings.',
    });
    finishAgentRun(id, { ok: false, error: claude ? 'No Claude Code' : 'No agent for this provider' });
    return;
  }
  updateAgent({ busy: true, status: 'Working… (offline demo agent)', startedAt: Date.now() });
  const p = planCommand(clean, state.agent.target);
  const delay = p.kind === 'help' ? 500 : p.kind === 'repo' ? 700 : 1400;
  setTimeout(() => {
    if (p.kind === 'help') {
      pushMessage({ role: 'agent', text: p.reply });
    } else if (p.kind === 'repo') {
      const needsRepo = p.actions.some((a) => a.run !== 'scale');
      if (needsRepo && !activeRepo()) {
        pushMessage({ role: 'agent', text: 'Сначала откройте репозиторий: команда относится к текущему репозиторию.', target: 'repo' });
      } else {
        const done: string[] = [];
        for (const a of p.actions) if (runRepoAction(a)) done.push(a.label);
        pushMessage({ role: 'agent', text: p.reply, actions: done, target: 'repo' });
      }
    } else {
      const n = state.agent.versions.length + 1;
      const version: AppVersion = { id: Date.now(), n, title: p.title, prompt: clean, time: Date.now(), files: p.files, diff: p.diff, patch: p.patch, status: 'applied', build: 'ok' };
      updateAgent((a) => ({ versions: [...a.versions, version] }));
      if (p.patch.scheme) setTheme(p.patch.scheme as ThemeName);
      pushMessage({ role: 'agent', text: p.reply, actions: [`edit ${p.files.join(', ')}`, 'typecheck ok · bundle 0.8s · hot reload'], versionId: version.id, target: 'app' });
      toast(`Applied v${n}: ${p.title}`, 'success', 'agent change, revertable in the Changes tab');
    }
    finishAgentRun(msgId, { ok: true });
  }, delay);
}

export function setVersionStatus(id: number, status: AppVersion['status']) {
  const real = state.agent.versions.find((x) => x.id === id);
  if (real?.sha) {
    void live.setRealVersionStatus(real, status).then((ok) => ok && toast(`${status === 'applied' ? 'Re-applied' : 'Reverted'} v${real.n}`, 'info', real.title));
    return;
  }
  updateAgent((a) => ({ versions: a.versions.map((v) => (v.id === id ? { ...v, status } : v)) }));
  const v = state.agent.versions.find((x) => x.id === id);
  if (v?.patch.scheme) setTheme(status === 'applied' ? (v.patch.scheme as ThemeName) : 'amber');
  toast(`${status === 'applied' ? 'Re-applied' : 'Reverted'} v${v?.n}`, 'info', v?.title);
}
/** Roll back to version n: everything after it is reverted, everything up to it applied. */
export function rollbackTo(n: number) {
  const real = state.agent.versions.filter((v) => v.sha);
  if (real.length) {
    // real versions: revert the applied ones above n in reverse order, re-apply reverted ones up to n
    void (async () => {
      // one interface rebuild at the end, not one per reverted version; a step git refuses stops it (its error is
      // shown), and what was done up to there is built — it used to go on and report the roll back as done
      let ok = true;
      for (const v of [...real].reverse()) if (ok && v.n > n && v.status === 'applied') ok = await live.setRealVersionStatus(v, 'reverted', false);
      for (const v of real) if (ok && v.n <= n && v.status === 'reverted') ok = await live.setRealVersionStatus(v, 'applied', false);
      if (ok) toast(n === 0 ? 'Reset to factory build' : `Rolled back to v${n}`, 'info');
      await live.rebuildInterface();
    })();
    updateAgent((a) => ({ versions: a.versions.map((v) => (v.sha ? v : { ...v, status: v.n <= n ? 'applied' : 'reverted' })) }));
    return;
  }
  updateAgent((a) => ({ versions: a.versions.map((v) => ({ ...v, status: v.n <= n ? 'applied' : 'reverted' })) }));
  const last = state.agent.versions.filter((v) => v.status === 'applied' && v.patch.scheme).pop();
  setTheme((last?.patch.scheme as ThemeName) ?? 'amber');
  pushMessage({ role: 'system', text: n === 0 ? 'Сброс к заводской сборке: все изменения интерфейса отменены, исходники восстановлены из factory-тега.' : `Откат к версии v${n}.` });
  toast(n === 0 ? 'Reset to factory build' : `Rolled back to v${n}`, 'info');
}
export function resetFactory() {
  confirm('Reset to factory build?', 'All agent changes to the interface are reverted. The change log is kept, so any version can be re-applied.', () => rollbackTo(0), 'Reset', true);
}
export function clearAgentChat() {
  if (state.agent.busy) return;
  // a new conversation: the agent no longer remembers the old one either
  updateAgent((a) => ({ messages: a.messages.slice(0, 1), session: null }));
}
