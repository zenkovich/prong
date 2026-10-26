/**
 * Live repositories: the same store actions as the mock, but executed by the local git engine
 * (`prong/server`) through `GitClient`. Every mutation re-reads the repository snapshot; diffs and
 * commit files are loaded lazily when selected.
 */
import { Platform } from 'react-native';
import { classifyAgentTarget, mentionsTarget, RETARGET_MARKER } from '../agent/classify';
import { statusFromEvent } from '../agent/status';
import { partialHunk } from '../git/lineStaging';
import { filterRevs } from '../components/branchFilter';
import type { BlobSide, UiSettings } from '../git/GitClient';
import { GhRepo, HttpGitClient, OpEvent, RebaseTodoItem, ServerSettings, Submodule } from '../git/GitClient';
import { Commit, FetchOptions, FileChange, GitHubAccount, PullOptions, PushOptions, QueueItem, RepoAuth, RepoInfo, SavedSession, Sha, SshKey, Workspace } from '../git/types';
import { AgentMessage, AppVersion } from '../agent/types';
import { applyUiPrefs, Area, closeDialog, confirm, ErrorEntry, findCommit, toggleAgent, UndoEntry, finishAgentRun, getState, nextRevealNonce, openRepo, RebaseTodo, RepoState, Section, setState, subscribe, toast, updateAgent, updateRepo } from './store';

export const client = new HttpGitClient();

// ---------- engine status & events ----------

let unsubscribe: (() => void) | null = null;
const opLog = new Map<string, string[]>();

export async function bootstrap() {
  try {
    const h = await client.health();
    setState({ engine: { online: !!h.ok, git: h.git ?? '', version: h.version ?? '', ui: h.ui, uiBuild: h.uiBuild } });
    const known = await client.listRepos();
    setState((s) => {
      const existing = new Set(s.repos.map((r) => r.path));
      const added: RepoInfo[] = known
        .filter((k) => !existing.has(k.path))
        .map((k) => ({ id: `live:${k.path}`, name: k.name, workspace: k.workspace, workspaces: k.workspaces, path: k.path, currentBranch: '', changes: 0, lastOpened: k.lastOpened, pinned: k.pinned, live: true }));
      const wsIds = new Set(s.workspaces.map((w) => w.id));
      const newWs = [...new Set(added.map((r) => r.workspace))].filter((w) => !wsIds.has(w)).map((w) => ({ id: w, name: w }));
      return { repos: [...added, ...s.repos], workspaces: [...s.workspaces, ...newWs] };
    });
    if (!unsubscribe) unsubscribe = client.events(onEvent);
    watchReturns();
    // actions that already wait (a window opened while another git process holds a lock)
    void client.queues().then((queues) => setState({ queues }), () => {});
    await syncServerState();
    if (!savedSession) savedSession = await client.loadSession().catch(() => ({}));
    await restoreTabs();
    startSessionSaving();
  } catch {
    setState({ engine: { online: false, git: '', version: '' } });
  }
}

type ErrorAction = NonNullable<ErrorEntry['action']>;

/** the SSE handler, for tests that feed engine events */
export const handleEventForTest = (e: OpEvent) => onEvent(e);

function onEvent(e: OpEvent) {
  if (e.event === 'ui-updated') return onUiUpdated();
  if (e.event === 'queue') return onQueue(e.repo, e.items ?? []);
  if (rebuildOp && e.opId === rebuildOp.opId) return onRebuildEvent(e);
  if (handleAgentEvent(e)) return;
  const log = opLog.get(e.opId) ?? [];
  if (e.line) log.push(e.line);
  opLog.set(e.opId, log);
  if (e.done) {
    opLog.delete(e.opId);
    setState({ operation: null });
    if (e.opId === runningOpId) runningOpId = null;
    if (e.error === 'Cancelled' || e.error === 'Stopped') toast(`${e.label}: ${e.error === 'Stopped' ? 'stopped' : 'cancelled'}`, 'info');
    else if (e.error) toast(`${e.label} failed`, 'error', log.length ? `${e.error}\n\nOutput:\n${log.slice(-30).join('\n')}` : e.error);
    else toast(`${e.label}: done`, 'success', log[log.length - 1]);
    const id = liveId();
    const cb = pendingDone.get(e.opId);
    pendingDone.delete(e.opId);
    // the callback sees the repository as the operation left it
    void (async () => {
      if (id) await refresh(id).catch(() => {});
      cb?.(!e.error);
    })();
    return;
  }
  setState({ operation: { label: e.label, progress: e.progress ?? getState().operation?.progress ?? 0, log: [...log] } });
}

/** a repository's action queue changed: what waits for its turn, or for another git process's lock */
function onQueue(repo: string | undefined, items: QueueItem[]) {
  if (!repo) return;
  setState((s) => {
    const queues = { ...s.queues };
    if (items.length) queues[repo] = items;
    else delete queues[repo];
    return { queues };
  });
}

const pendingDone = new Map<string, (ok: boolean) => void>();
/** the long operation shown in the toolbar and status bar (its stop button stops this one) */
let runningOpId: string | null = null;
function track(op: { opId: string }, label: string, onDone?: (ok: boolean) => void) {
  if (onDone) pendingDone.set(op.opId, onDone);
  runningOpId = op.opId;
  setState({ operation: { label, progress: 0, log: [] } });
}
/**
 * Stops what runs: the agent, or the long operation (fetch, pull, push, submodule update — git is killed, the
 * repository stays as git leaves it on an interrupt).
 */
export function stopRunning() {
  if (agentOp) return void agentStop();
  if (runningOpId) return void client.cancelOp(runningOpId).catch(() => setState({ operation: null }));
  setState({ operation: null });
}

// ---------- helpers ----------

/** a path's last part, for short action names ("Stage README.md") */
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

export function liveInfo(id?: string | null): RepoInfo | null {
  const s = getState();
  const rid = id ?? s.activeTab;
  const info = s.repos.find((r) => r.id === rid);
  return info?.live && info.path ? info : null;
}
export function liveId(): string | null {
  return liveInfo()?.id ?? null;
}
export function isLiveActive() {
  return !!liveInfo();
}
function pathOf(id?: string | null) {
  return liveInfo(id)!.path;
}
function repoState(id?: string): RepoState | null {
  const s = getState();
  return s.repoStates[id ?? s.activeTab ?? ''] ?? null;
}

async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e: any) {
    // the whole message: the error dialog shows git's output in full
    toast(`${label} failed`, 'error', String(e?.message ?? e));
    return undefined;
  }
}

// ---------- loading ----------

function sameRefs(a: { name: string; sha: Sha }[], b: { name: string; sha: Sha }[]) {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((r) => [r.name, r.sha]));
  return b.every((r) => m.get(r.name) === r.sha);
}

/** when each repository was last read from git, and which are being read now (by repository id) */
const lastRead = new Map<string, number>();
const reading = new Set<string>();
/** coming back within this long after a read reads nothing new worth the work */
const RETURN_REFRESH_MS = 2000;

export async function refresh(id?: string) {
  const info = liveInfo(id);
  if (!info) return;
  reading.add(info.id);
  lastRead.set(info.id, Date.now());
  try {
    await readRepo(info);
  } finally {
    reading.delete(info.id);
  }
}

/**
 * As in Fork: back in the window (from a terminal, an IDE) or on another tab, the repository is read again, so the
 * commits, branches and changes made elsewhere show up without a refresh. Skipped while it is being read or loaded,
 * or when it was read a moment ago.
 */
export function refreshOnReturn(id = liveId()) {
  if (!id || !liveInfo(id)) return;
  const r = repoState(id);
  if (!r || r.loading || reading.has(id) || Date.now() - (lastRead.get(id) ?? 0) < RETURN_REFRESH_MS) return;
  void refresh(id).catch(() => {});
}

let watchingReturns = false;
/** the window coming back (focus, visible again, the macOS shell's `prong-activate`) and tab switches */
function watchReturns() {
  if (watchingReturns || Platform.OS !== 'web' || typeof window === 'undefined') return;
  watchingReturns = true;
  // a moment later: a tab switch that opens the repository reads it itself first
  const soon = (id?: string) => setTimeout(() => refreshOnReturn(id ?? liveId()), 50);
  window.addEventListener('focus', () => soon());
  window.addEventListener('prong-activate', () => soon());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && soon());
  let active = getState().activeTab;
  subscribe(() => {
    const a = getState().activeTab;
    if (a === active) return;
    active = a;
    if (a) soon(a);
  });
}

async function readRepo(info: RepoInfo) {
  const snap = await client.snapshot(info.path);
  // history read beyond the first page (scrolling, a branch click) stays: unchanged refs keep the list as it is,
  // changed refs re-read the same depth in one call
  const prev = repoState(info.id);
  const deep = !!prev && prev.commits.length > snap.commits.length;
  const same = deep && prev!.head === snap.head && sameRefs(prev!.refs, snap.refs);
  const reread = deep && !same ? await client.logPage(info.path, 0, prev!.commits.length).catch(() => null) : null;
  updateRepo((r) => {
    // keep lazily loaded commit files and the current selection
    const files = new Map(r.commits.filter((c) => c.files).map((c) => [c.sha, c.files!]));
    const fresh = same && r.commits.length > snap.commits.length ? r.commits : reread ?? snap.commits;
    const commits = fresh === r.commits ? fresh : fresh.map((c) => (files.has(c.sha) ? { ...c, files: files.get(c.sha) } : c));
    const keepDiff = (list: FileChange[], prev: FileChange[]) => list.map((f) => {
      const p = prev.find((x) => x.path === f.path && x.status === f.status && x.additions === f.additions && x.deletions === f.deletions);
      return p?.hunks || p?.image ? { ...f, hunks: p.hunks, image: p.image, kind: p.kind } : f;
    });
    const unstaged = keepDiff(snap.unstaged, r.unstaged);
    const staged = keepDiff(snap.staged, r.staged);
    const has = (list?: Commit[] | null) => !!list?.some((c) => c.sha === r.selectedCommit);
    const selectedCommit = r.selectedCommit && (has(commits) || has(r.filteredCommits) || has(r.historyCommits)) ? r.selectedCommit : snap.head;
    return { commits, refs: snap.refs, remotes: snap.remotes, stashes: snap.stashes, unstaged, staged, head: snap.head, selectedCommit, opKind: snap.op.kind, shallow: snap.shallow, loading: false };
  }, info.id);
  setState((s) => ({ repos: s.repos.map((r) => (r.id === info.id ? { ...r, currentBranch: snap.refs.find((x) => x.current)?.name ?? '', changes: snap.unstaged.length + snap.staged.length } : r)) }));
  const r = repoState(info.id);
  if (r?.filteredCommits) void applyGraphFilter(info.id);
  if (r && r.selectedFile && (r.selectedArea === 'unstaged' || r.selectedArea === 'staged')) await ensureFileDiff(info.id, r.selectedArea, r.selectedFile);
  if (r && r.selectedArea === 'commit' && r.selectedCommit) await ensureCommitFiles(info.id, r.selectedCommit);
}

export async function openLive(id: string) {
  const info = liveInfo(id);
  if (!info) return;
  // it reads the repository below: the tab switch it makes is no reason to read it once more
  lastRead.set(id, Date.now());
  const s = getState();
  const fresh = !s.repoStates[id];
  const empty = (await import('./store')).EMPTY_REPO;
  const base: RepoState = s.repoStates[id] ?? {
    ...empty,
    id,
    path: info.path,
    live: true,
    loading: true,
    // the branch filter it had at the last launch
    graphFilter: savedSession?.filters?.[id] ?? empty.graphFilter,
  };
  setState((st) => ({ repoStates: { ...st.repoStates, [id]: base }, tabs: st.tabs.includes(id) ? st.tabs : [...st.tabs, id], activeTab: id, screen: 'repo', repos: st.repos.map((r) => (r.id === id ? { ...r, lastOpened: Date.now() } : r)) }));
  await guard('Open repository', async () => {
    // paint the last known snapshot instantly, then refresh from git
    const cachedRaw = await client.snapshotCached(info.path).catch(() => null);
    const cached = cachedRaw && Array.isArray(cachedRaw.commits) ? cachedRaw : null;
    if (cached && !s.repoStates[id]) {
      updateRepo({ commits: cached.commits, refs: cached.refs, remotes: cached.remotes, stashes: cached.stashes, unstaged: cached.unstaged, staged: cached.staged, head: cached.head, opKind: cached.op.kind, shallow: cached.shallow, selectedCommit: cached.head, selectedArea: 'commit', section: 'commits', stale: true }, id);
    }
    await refresh(id);
    if (fresh) await reapplySavedFilter(id);
    const r = repoState(id)!;
    if (!cached || !s.repoStates[id]) updateRepo({ selectedCommit: r.head, selectedArea: 'commit', section: 'commits', stale: false }, id);
    else updateRepo({ stale: false }, id);
    await ensureCommitFiles(id, r.head);
    void loadSubmodules(id);
  });
}

export async function openPath(path: string) {
  const ws = getState().activeWorkspace;
  const known = await guard('Open repository', () => client.openRepo(path, ws));
  if (!known) return;
  closeDialog();
  const id = `live:${known.path}`;
  setState((s) => (s.repos.some((r) => r.id === id) ? {} : { repos: [{ id, name: known.name, workspace: ws, path: known.path, currentBranch: '', changes: 0, lastOpened: Date.now(), live: true }, ...s.repos] }));
  await openLive(id);
}

export async function initPath(path: string) {
  const r = await guard('Init repository', () => client.initRepo(path));
  if (r) await openPath(r.path);
}

export async function clone(url: string, dir: string, recursive: boolean) {
  const ws = getState().activeWorkspace;
  closeDialog();
  const op = await guard('Clone', () => client.clone(url, dir, undefined, recursive, ws));
  if (!op) return;
  track(op, `Cloning ${url.split('/').pop()?.replace(/\.git$/, '')}`, async (ok) => {
    if (ok) await openPath(op.path);
  });
}

export async function ensureCommitFiles(id: string, sha: Sha) {
  const r = repoState(id);
  const c = r && findCommit(r, sha);
  if (!r || !c || c.files) return;
  const files = await guard('Load commit', () => client.commitFiles(pathOf(id), sha));
  if (!files) return;
  // the commit may sit in the main log, the filtered log and a file history at once
  const put = (list?: Commit[] | null) => list?.map((x) => (x.sha === sha ? { ...x, files } : x));
  updateRepo(
    (rr) => ({
      commits: put(rr.commits)!,
      filteredCommits: rr.filteredCommits ? put(rr.filteredCommits) : rr.filteredCommits,
      historyCommits: rr.historyCommits ? put(rr.historyCommits) : rr.historyCommits,
      selectedFile: rr.selectedCommit === sha && !rr.selectedFile ? files[0]?.path ?? null : rr.selectedFile,
    }),
    id,
  );
  const after = repoState(id);
  if (after?.selectedArea === 'commit' && after.selectedCommit === sha && after.selectedFile) void ensureCommitFileDiff(id, 'commit', after.selectedFile);
}

/**
 * The diff of one file of a commit or stash that came as a bare list (a commit with hundreds of files), or of a
 * large diff the user asked to load anyway (`force`).
 */
export async function ensureCommitFileDiff(id: string, area: 'commit' | 'stash', path: string, force = false) {
  const r = repoState(id);
  if (!r) return;
  const stashIndex = r.selectedStash;
  const sha = r.selectedCommit;
  const files = area === 'stash' ? r.stashes.find((s) => s.index === stashIndex)?.files : findCommit(r, sha)?.files;
  const f = files?.find((x) => x.path === path);
  const rev = area === 'stash' ? (stashIndex != null ? `stash@{${stashIndex}}` : null) : sha;
  if (!rev || !f || (!force && !f.lazy)) return;
  // media previews read both sides by themselves; only text needs the patch
  if (!force && (f.kind === 'image' || f.kind === 'audio' || f.kind === 'video')) return;
  const d = await guard('Load diff', () => client.commitFileDiff(pathOf(id), rev, path, f.oldPath, force));
  const merged: FileChange = d ? { ...d, path: f.path, oldPath: f.oldPath ?? d.oldPath, status: f.status, lazy: false } : { ...f, lazy: false };
  const swap = (list?: FileChange[]) => list?.map((x) => (x.path === path ? merged : x));
  if (area === 'stash') {
    updateRepo((rr) => ({ stashes: rr.stashes.map((s) => (s.index === stashIndex ? { ...s, files: swap(s.files)! } : s)) }), id);
    return;
  }
  const put = (list?: Commit[] | null) => list?.map((c) => (c.sha === sha ? { ...c, files: swap(c.files) } : c));
  updateRepo((rr) => ({ commits: put(rr.commits)!, filteredCommits: rr.filteredCommits ? put(rr.filteredCommits) : rr.filteredCommits, historyCommits: rr.historyCommits ? put(rr.historyCommits) : rr.historyCommits }), id);
}

export async function ensureStashFiles(id: string, index: number) {
  const r = repoState(id);
  const st = r?.stashes.find((x) => x.index === index);
  if (!r || !st || st.files.length) return;
  const files = await guard('Load stash', () => client.stashFiles(pathOf(id), index));
  if (!files) return;
  updateRepo((rr) => ({ stashes: rr.stashes.map((x) => (x.index === index ? { ...x, files } : x)), selectedFile: rr.selectedStash === index && !rr.selectedFile ? files[0]?.path ?? null : rr.selectedFile }), id);
  const after = repoState(id);
  if (after?.selectedArea === 'stash' && after.selectedStash === index && after.selectedFile) void ensureCommitFileDiff(id, 'stash', after.selectedFile);
}

export async function ensureFileDiff(id: string, area: 'unstaged' | 'staged', path: string, force = false) {
  const r = repoState(id);
  const list = area === 'unstaged' ? r?.unstaged : r?.staged;
  const f = list?.find((x) => x.path === path);
  if (!r || !f) return;
  if (!force && (f.hunks || f.image || f.kind === 'binary' || f.kind === 'submodule' || (f.kind === 'large' && !r.loadedLarge[path]))) return;
  const d = await guard('Load diff', () => client.fileDiff(pathOf(id), path, area, force));
  if (!d) return;
  const merged: FileChange = { ...f, ...d, status: f.status === 'U' ? 'U' : d.status, path: f.path };
  if (f.status === 'U' && d.hunks) merged.conflict = conflictFromHunks(d);
  updateRepo((rr) => ({ [area]: (area === 'unstaged' ? rr.unstaged : rr.staged).map((x) => (x.path === path ? merged : x)) } as any), id);
}

// ---------- media (images, audio, video, other binaries) ----------

export interface MediaSide extends BlobSide {
  /** repository the side belongs to */
  repo: string;
  url: string;
}

/**
 * Where both sides of a change live, with URLs the engine serves them from. Commit and stash diffs pass the
 * commit / stash ref as `rev`. Throws when the repository is not backed by the engine.
 */
export async function mediaSides(area: 'unstaged' | 'staged' | 'commit' | 'stash', rev: string, file: FileChange, id = liveId()): Promise<{ before?: MediaSide; after?: MediaSide }> {
  if (!id || !engineOnline()) throw new Error('Previews need the git engine');
  const repo = pathOf(id);
  const sides = await client.mediaSides(repo, file.path, area === 'commit' || area === 'stash' ? rev : area, file.oldPath);
  const withUrl = (s?: BlobSide): MediaSide | undefined => (s ? { ...s, repo, url: client.blobUrl(repo, s.rev, s.file, s.version) } : undefined);
  return { before: withUrl(sides.before), after: withUrl(sides.after) };
}

/** Opens one side in the default app (committed versions are extracted to the engine's cache first). */
export async function openBlob(side: MediaSide) {
  await guard('Open file', async () => {
    const f = await client.blobFile(side.repo, side.rev, side.file);
    await client.systemOpen(f.path, '');
  });
}
export async function revealBlob(side: MediaSide) {
  await guard('Reveal', async () => {
    const f = await client.blobFile(side.repo, side.rev, side.file);
    await client.systemReveal(f.path);
  });
}

/** Pull ours/theirs/base out of conflict markers so the three-pane resolver can show them. */
function conflictFromHunks(d: FileChange) {
  const lines = (d.hunks ?? []).flatMap((h) => h.lines.filter((l) => l.kind !== 'del').map((l) => l.text));
  const ours: string[] = [];
  const theirs: string[] = [];
  const base: string[] = [];
  let mode: 'none' | 'ours' | 'base' | 'theirs' = 'none';
  for (const l of lines) {
    if (l.startsWith('<<<<<<<')) mode = 'ours';
    else if (l.startsWith('|||||||')) mode = 'base';
    else if (l.startsWith('=======')) mode = 'theirs';
    else if (l.startsWith('>>>>>>>')) mode = 'none';
    else if (mode === 'ours') ours.push(l);
    else if (mode === 'theirs') theirs.push(l);
    else if (mode === 'base') base.push(l);
  }
  return { ours, theirs, base };
}

// ---------- selection (lazy loads) ----------

export function selectCommit(sha: Sha) {
  const id = liveId()!;
  updateRepo((r) => {
    const c = findCommit(r, sha);
    return { section: 'commits', selectedCommit: sha, selectedStash: null, selectedArea: 'commit', selectedFile: c?.files?.[0]?.path ?? null };
  });
  void ensureCommitFiles(id, sha);
}

/**
 * How deep a branch click may read the history. The list is virtualized and the graph keeps at most a dozen
 * columns, so tens of thousands of rows stay cheap; past this the funnel (show only that branch) is the way.
 */
export const REVEAL_MAX = 60000;
/** commits read past the revealed one, so the list below it is not empty */
const REVEAL_AFTER = 200;
/**
 * A click on a branch: select its commit and scroll the history to it. When the commit is below what is loaded,
 * the engine finds its position in the (filtered) log and the missing part is read in one call.
 */
export async function revealCommit(sha: Sha) {
  const id = liveId();
  if (!id) return;
  if (repoState(id)?.historyPath) clearFileHistory();
  const r0 = repoState(id)!;
  const filtered = !!r0.filteredCommits;
  const list = () => {
    const r = repoState(id)!;
    return r.filteredCommits ?? r.commits;
  };
  if (!list().some((c) => c.sha === sha)) {
    const revs = filtered ? filterRevs(r0.graphFilter) ?? undefined : undefined;
    updateRepo({ loadingMore: true }, id);
    const have = list().length;
    // one streamed read from what is loaded down to the commit, plus a screenful past it
    const res = await guard('Load history', () => client.logUntil(pathOf(id), sha, have, REVEAL_AFTER, revs, REVEAL_MAX));
    const at = res ? res.index : null;
    const page = res && res.index >= 0 ? res.commits : null;
    updateRepo((rr) => {
      if (!page) return { loadingMore: false };
      const short = page.length < at! - have + 1 + REVEAL_AFTER;
      if (rr.filteredCommits) return { loadingMore: false, filteredCommits: appendNew(rr.filteredCommits, page), filterExhausted: rr.filterExhausted || short };
      return { loadingMore: false, commits: appendNew(rr.commits, page) };
    }, id);
    if (at == null) return;
    if (at < 0) {
      selectCommit(sha);
      toast(filtered ? 'Hidden by the branch filter' : 'Too deep in the history', 'info', filtered ? 'clear the filter to see this commit' : `more than ${REVEAL_MAX.toLocaleString()} commits down; the funnel shows only this branch`);
      return;
    }
  }
  selectCommit(sha);
  if (list().some((c) => c.sha === sha)) updateRepo({ reveal: { sha, nonce: nextRevealNonce() } }, id);
}
/** `page` added after `list`, skipping commits already there */
function appendNew(list: Commit[], page: Commit[]) {
  const have = new Set(list.map((c) => c.sha));
  const add = page.filter((c) => !have.has(c.sha));
  return add.length ? [...list, ...add] : list;
}
export function selectStash(index: number) {
  const id = liveId()!;
  updateRepo((r) => {
    const st = r.stashes.find((s) => s.index === index);
    return { section: 'commits', selectedStash: index, selectedCommit: st?.sha ?? null, selectedArea: 'stash', selectedFile: st?.files[0]?.path ?? null };
  });
  void ensureStashFiles(id, index);
}
export function selectFile(area: Area, path: string) {
  const id = liveId()!;
  updateRepo({ selectedArea: area, selectedFile: path });
  if (area === 'unstaged' || area === 'staged') void ensureFileDiff(id, area, path);
  else if (area === 'commit' || area === 'stash') void ensureCommitFileDiff(id, area, path);
}
export function setSection(section: Section) {
  const id = liveId()!;
  updateRepo((r) => {
    if (section === 'changes') {
      const first = r.unstaged[0] ?? r.staged[0];
      const area: Area = r.unstaged[0] ? 'unstaged' : 'staged';
      const keep = r.selectedArea === 'unstaged' || r.selectedArea === 'staged';
      return { section, selectedArea: keep ? r.selectedArea : area, selectedFile: keep ? r.selectedFile : first?.path ?? null };
    }
    const commit = findCommit(r, r.selectedCommit) ?? r.commits[0];
    return { section, selectedArea: 'commit', selectedCommit: commit?.sha ?? null, selectedStash: null, selectedFile: commit?.files?.[0]?.path ?? null };
  });
  const r = repoState(id);
  if (r?.section === 'changes' && r.selectedFile && (r.selectedArea === 'unstaged' || r.selectedArea === 'staged')) void ensureFileDiff(id, r.selectedArea, r.selectedFile);
  if (r?.section === 'commits' && r.selectedCommit) void ensureCommitFiles(id, r.selectedCommit);
}
export function loadLarge(path: string) {
  const id = liveId()!;
  updateRepo((r) => ({ loadedLarge: { ...r.loadedLarge, [path]: true } }));
  const r = repoState(id);
  if (r && (r.selectedArea === 'unstaged' || r.selectedArea === 'staged')) void ensureFileDiff(id, r.selectedArea, path, true);
  else if (r && (r.selectedArea === 'commit' || r.selectedArea === 'stash')) void ensureCommitFileDiff(id, r.selectedArea, path, true);
}

// ---------- staging ----------

/**
 * A git operation on the active repository, then a refresh. `after` (usually the success message) runs only when
 * the operation succeeded: a failed checkout used to show its error and then "Checked out …" in green.
 */
interface MutateOptions {
  /** a way out offered with the error (e.g. "Stash, switch and reapply") */
  failAction?: (message: string) => ErrorAction | undefined;
  /**
   * How it is undone: 'index' — staging, the index goes back to its state before; or from the result and HEAD
   * before / after, the entry (null: nothing to undo, e.g. a merge that stopped on conflicts)
   */
  undo?: 'index' | ((c: { result: any; before: HeadState; after: HeadState }) => Omit<UndoEntry, 'id' | 'at' | 'head'> | null);
  /** HEAD may move: the submodules whose recorded commit changed follow it (Preferences) */
  moves?: boolean;
}
interface HeadState {
  head: Sha;
  /** the current branch; null when detached */
  branch: string | null;
}
function headState(id: string): HeadState {
  const r = repoState(id);
  return { head: r?.head ?? '', branch: r?.refs.find((x) => x.kind === 'branch' && x.current)?.name ?? null };
}

async function mutate(label: string, fn: (path: string) => Promise<unknown>, after?: () => void, opts: MutateOptions = {}): Promise<boolean> {
  const id = liveId();
  if (!id) return false;
  const p = pathOf(id);
  const before = headState(id);
  const tree = opts.undo === 'index' ? await client.writeTree(p).catch(() => null) : null;
  let ok = true;
  let result: unknown;
  try {
    result = await fn(p);
  } catch (e: any) {
    ok = false;
    const message = String(e?.message ?? e);
    // taken out of the queue by the user
    if (message === 'Cancelled') toast(`${label}: cancelled`, 'info');
    else toast(`${label} failed`, 'error', message, opts.failAction?.(message));
  }
  await guard('Refresh', () => refresh(id));
  if (!ok) return false;
  after?.();
  const now = headState(id);
  if (opts.undo === 'index') {
    if (tree) pushUndo(id, { label, head: now.head, run: (q) => client.readTree(q, tree) });
  } else if (opts.undo) {
    const u = opts.undo({ result, before, after: now });
    if (u) pushUndo(id, { ...u, head: now.head });
  }
  if (opts.moves) void followSubmodules(id, before.head, now.head);
  return true;
}

// ---------- undo ----------

const UNDO_MAX = 30;
let undoSeq = 0;
function pushUndo(id: string, e: Omit<UndoEntry, 'id' | 'at'>) {
  setState((s) => ({ undo: { ...s.undo, [id]: [...(s.undo[id] ?? []), { ...e, id: ++undoSeq, at: Date.now() }].slice(-UNDO_MAX) } }));
}
function dropUndo(id: string, all = false) {
  setState((s) => ({ undo: { ...s.undo, [id]: all ? [] : (s.undo[id] ?? []).slice(0, -1) } }));
}
/** the branch went back where it was (merge, pull, rebase, cherry-pick, revert): `reset --keep` keeps local changes */
const moveBack = (label: string) => (c: { before: HeadState; after: HeadState }) =>
  c.before.head && c.after.head !== c.before.head && c.after.branch === c.before.branch && (repoState()?.opKind ?? 'none') === 'none'
    ? { label, moves: true, run: (q: string) => client.reset(q, c.before.head, 'keep') }
    : null;
/** back to the branch (or detached commit) it was on */
const switchBack = (label: string, dropBranch?: string) => (c: { before: HeadState; after: HeadState }) =>
  c.before.branch === c.after.branch && c.before.head === c.after.head
    ? null
    : {
        label,
        moves: true,
        run: async (q: string) => {
          if (c.before.branch) await client.checkout(q, c.before.branch);
          else await client.checkoutDetached(q, c.before.head);
          // a branch made by this checkout goes too: it still points where it was made (HEAD never moved)
          if (dropBranch) await client.deleteRefAt(q, `refs/heads/${dropBranch}`, c.after.head);
        },
      };

/**
 * Takes back the newest action of the repository (the toolbar's Undo, ⌘Z), when HEAD is still where that action
 * left it. Undo itself is not recorded.
 */
export function undoLast(id = liveId()) {
  if (!id) return;
  const entry = getState().undo[id]?.at(-1);
  if (!entry) return toast('Nothing to undo', 'info');
  if (getState().operation) return toast('Wait for the running operation to finish', 'info');
  const r = repoState(id);
  if (r && r.head !== entry.head) {
    // something moved HEAD since (a command in a terminal, an action Prong cannot undo): every older entry is stale too
    dropUndo(id, true);
    return toast(`Cannot undo “${entry.label}”`, 'info', 'The repository changed since then (another commit, checkout or a command in a terminal).');
  }
  const go = () => {
    dropUndo(id);
    void mutate(`Undo ${entry.label}`, entry.run, () => toast(`Undone: ${entry.label}`, 'success'), { moves: entry.moves });
  };
  const warn = entry.warn?.();
  if (warn) confirm(`Undo ${entry.label}?`, warn, go, 'Undo', true);
  else go();
}

/**
 * After HEAD moved (checkout, pull, merge, reset, an undo…): the submodules whose recorded commit changed follow
 * it — only those checked out and still at the commit recorded before, so a submodule the user moved or never
 * initialized is left alone. Off in Preferences → General.
 */
async function followSubmodules(id: string, from: Sha, to: Sha) {
  if (!from || !to || from === to || getState().serverSettings?.autoUpdateSubmodules === false) return;
  const info = liveInfo(id);
  if (!info) return;
  const list = await client.changedSubmodules(info.path, from, to).catch(() => []);
  const follow = list.filter((s) => s.inSync);
  const moved = list.filter((s) => s.initialized && !s.inSync);
  if (moved.length) toast(`${moved.length} submodule${moved.length === 1 ? '' : 's'} left where you put ${moved.length === 1 ? 'it' : 'them'}`, 'info', `${moved.map((s) => s.path).join(', ')}: checked out at another commit than the one recorded before, so not moved`);
  if (!follow.length) return;
  await guard('Update submodules', async () => track(await client.submoduleUpdate(info.path, follow.map((s) => s.path), true), `Updating ${follow.length} submodule${follow.length === 1 ? '' : 's'}: ${follow.map((s) => s.path).join(', ')}`));
}

export function stageFile(path: string) {
  void mutate(`Stage ${baseName(path)}`, (p) => client.stage(p, [path]), () => {
    const r = repoState();
    if (r?.selectedFile === path) updateRepo({ selectedArea: r.staged.some((f) => f.path === path) ? 'staged' : 'unstaged' });
  }, { undo: 'index' });
}
export function unstageFile(path: string) {
  void mutate(`Unstage ${baseName(path)}`, (p) => client.unstage(p, [path]), () => {
    const r = repoState();
    if (r?.selectedFile === path) updateRepo({ selectedArea: r.unstaged.some((f) => f.path === path) ? 'unstaged' : 'staged' });
  }, { undo: 'index' });
}
export function stageAll() {
  void mutate('Stage all', (p) => client.stageAll(p), () => updateRepo((r) => ({ selectedArea: 'staged', selectedFile: r.staged.some((f) => f.path === r.selectedFile) ? r.selectedFile : r.staged[0]?.path ?? null })), { undo: 'index' });
}
export function unstageAll() {
  void mutate('Unstage all', (p) => client.unstageAll(p), () => updateRepo((r) => ({ selectedArea: 'unstaged', selectedFile: r.unstaged.some((f) => f.path === r.selectedFile) ? r.selectedFile : r.unstaged[0]?.path ?? null })), { undo: 'index' });
}
/** a discard is undone from the copies the engine kept (none for a very large one: then it says so) */
const fromCopies = (label: string) => (c: { result: { undo: string | null } }) => {
  if (!c.result?.undo) {
    toast(`${label}: too large to keep a copy`, 'info', 'This discard cannot be undone.');
    return null;
  }
  const token = c.result.undo;
  return { label, run: (q: string) => client.undoDiscard(q, token) };
};
export function discardFile(path: string) {
  confirm('Discard changes?', `All changes in ${path} are dropped. Prong keeps a copy: Undo in the toolbar (⌘Z) brings them back.`, () => void mutate(`Discard ${baseName(path)}`, (p) => client.discard(p, [path]), undefined, { undo: fromCopies(`Discard ${baseName(path)}`) }), 'Discard', true);
}
export function discardAll() {
  confirm('Discard all changes?', 'All unstaged changes and untracked files are dropped. Prong keeps a copy: Undo in the toolbar (⌘Z) brings them back.', () => void mutate('Discard all', (p) => client.discardAll(p), undefined, { undo: fromCopies('Discard all') }), 'Discard all', true);
}
function fileAndHunk(area: 'unstaged' | 'staged', path: string, hunkId: string) {
  const r = repoState();
  const f = (area === 'unstaged' ? r?.unstaged : r?.staged)?.find((x) => x.path === path);
  const h = f?.hunks?.find((x) => x.id === hunkId);
  return f && h ? { f, h } : null;
}
export function stageHunk(path: string, hunkId: string) {
  const fh = fileAndHunk('unstaged', path, hunkId);
  if (fh) void mutate(`Stage hunk of ${baseName(path)}`, (p) => client.stageHunk(p, fh.f, fh.h), undefined, { undo: 'index' });
}
export function unstageHunk(path: string, hunkId: string) {
  const fh = fileAndHunk('staged', path, hunkId);
  if (fh) void mutate(`Unstage hunk of ${baseName(path)}`, (p) => client.unstageHunk(p, fh.f, fh.h), undefined, { undo: 'index' });
}
export function discardHunk(path: string, hunkId: string) {
  const fh = fileAndHunk('unstaged', path, hunkId);
  if (fh) confirm('Discard hunk?', 'The selected hunk is reverted in the working copy (Undo brings it back).', () => void mutate(`Discard hunk of ${baseName(path)}`, (p) => client.discardHunk(p, fh.f, fh.h), undefined, { undo: fromCopies(`Discard hunk of ${baseName(path)}`) }), 'Discard', true);
}
export function stageLines(path: string, hunkId: string, lines: number[]) {
  const fh = fileAndHunk('unstaged', path, hunkId);
  const part = fh && partialHunk(fh.h, lines, 'forward');
  if (fh && part) void mutate(`Stage ${lines.length} line${lines.length > 1 ? 's' : ''}`, (p) => client.stageHunk(p, fh.f, part), undefined, { undo: 'index' });
}
export function unstageLines(path: string, hunkId: string, lines: number[]) {
  const fh = fileAndHunk('staged', path, hunkId);
  const part = fh && partialHunk(fh.h, lines, 'reverse');
  if (fh && part) void mutate(`Unstage ${lines.length} line${lines.length > 1 ? 's' : ''}`, (p) => client.unstageHunk(p, fh.f, part), undefined, { undo: 'index' });
}
export function discardLines(path: string, hunkId: string, lines: number[]) {
  const fh = fileAndHunk('unstaged', path, hunkId);
  const part = fh && partialHunk(fh.h, lines, 'reverse');
  if (fh && part)
    confirm(`Discard ${lines.length} line${lines.length > 1 ? 's' : ''}?`, 'The picked lines are reverted in the working copy (Undo brings them back).', () => void mutate('Discard lines', (p) => client.discardHunk(p, fh.f, part), undefined, { undo: fromCopies(`Discard ${lines.length} line${lines.length > 1 ? 's' : ''}`) }), 'Discard', true);
}
export function resolveConflict(path: string, take: 'ours' | 'theirs' | 'both') {
  if (take === 'both') {
    toast('Taking both sides needs an editor; use ours/theirs or edit the file', 'error');
    return;
  }
  void mutate(`Resolve (${take})`, (p) => client.resolveConflict(p, path, take));
}

// ---------- commits & remote ----------

export function commit(andPush = false) {
  const r = repoState();
  if (!r) return;
  if (!r.commitMessage.trim()) return toast('Commit message is empty', 'error');
  if (r.staged.length === 0 && !r.amend) return toast('Nothing staged', 'error');
  const message = r.commitDescription.trim() ? `${r.commitMessage.trim()}\n\n${r.commitDescription.trim()}` : r.commitMessage.trim();
  const subject = r.commitMessage.trim();
  void mutate(r.amend ? 'Amend' : 'Commit', (p) => client.commit(p, message, r.amend), () => {
    updateRepo({ commitMessage: '', commitDescription: '', amend: false });
    toast(r.amend ? 'Amended last commit' : 'Committed', 'success');
    if (andPush) push({});
  }, {
    // the commit goes, its changes stay staged (an amend: the commit as it was before)
    undo: (c) =>
      c.before.head
        ? {
            label: `${r.amend ? 'Amend' : 'Commit'} “${subject.length > 48 ? subject.slice(0, 47) + '…' : subject}”`,
            run: (q) => client.reset(q, c.before.head, 'soft'),
            warn: () => {
              const now = repoState();
              const cur = now?.refs.find((x) => x.kind === 'branch' && x.current);
              const up = cur?.upstream ? now?.refs.find((x) => x.name === cur.upstream) : undefined;
              return up && up.sha === c.after.head ? `It is already on ${up.name}: undoing it here leaves it there, and the next push needs force.` : undefined;
            },
          }
        : null,
  });
}
/** Fetch: one remote or all, pruning and all tags as the dialog last had them unless given */
export function fetch(opts: FetchOptions = {}) {
  closeDialog();
  const id = liveId();
  if (!id) return;
  const prefs = getState().syncPrefs;
  const prune = opts.prune ?? prefs.fetchPrune;
  const tags = opts.tags ?? prefs.fetchTags;
  void guard('Fetch', async () => track(await client.fetch(pathOf(id), opts.remote, prune, tags), opts.remote ? `Fetching ${opts.remote}` : 'Fetching all remotes'));
}
/** the remote a branch's upstream lives on (remote names may hold a slash, so by prefix) */
export function upstreamRemote(r: { remotes: { name: string }[] }, upstream?: string) {
  if (!upstream) return undefined;
  return r.remotes.filter((x) => upstream.startsWith(x.name + '/')).sort((a, b) => b.name.length - a.name.length)[0]?.name;
}
/**
 * Completes a shallow clone: the history that `clone --depth` left out is fetched (`fetch --unshallow`), so blame,
 * file history and rebases onto old commits work again. `allBranches` also widens a single-branch clone, which is
 * what `--depth` leaves behind, so every branch of the remote comes along.
 */
export function unshallow(opts: { remote?: string; allBranches?: boolean } = {}) {
  closeDialog();
  const id = liveId();
  if (!id) return;
  const r = repoState(id);
  if (r && r.shallow === false) return toast('The history is already complete', 'info');
  void guard('Fetch full history', async () => track(await client.unshallow(pathOf(id), opts), 'Fetching the full history'));
}
/**
 * Widens a narrow clone: the remote follows every branch (`remote set-branches '*'`) and is fetched, so the branches a
 * `--single-branch` clone never asked for finally show up. Plain fetching cannot do it — git only asks for its list.
 */
export function followAllBranches(remote?: string) {
  closeDialog();
  const id = liveId();
  if (!id) return;
  const r = repoState(id);
  const rm = remote ?? r?.remotes.find((x) => x.narrow)?.name ?? r?.remotes[0]?.name;
  if (r && rm && r.remotes.some((x) => x.name === rm && !x.narrow)) return toast(`${rm} already follows every branch`, 'info');
  void guard('Fetch every branch', async () => track(await client.followAllBranches(pathOf(id), rm), `Fetching every branch${rm ? ` of ${rm}` : ''}`));
}
/**
 * Pull into the current branch: its upstream, or the branch of the remote the dialog picked; merge, rebase or
 * fast-forward only (the Preferences' pull mode unless given); local changes stashed around it when asked.
 */
export function pull(opts: PullOptions | 'merge' | 'rebase' | 'ff' = {}) {
  closeDialog();
  const o: PullOptions = typeof opts === 'string' ? { strategy: opts } : opts;
  const id = liveId();
  const r = repoState(id ?? undefined);
  if (!id || !r) return;
  const cur = r.refs.find((x) => x.kind === 'branch' && x.current);
  if (!cur) return toast('Nothing to pull into', 'info', 'HEAD is detached: check out a branch first.');
  const s = getState();
  const strategy = o.strategy ?? s.serverSettings?.pullMode ?? 'merge';
  const autostash = o.autostash ?? s.syncPrefs.pullAutostash;
  const from = o.remote && o.branch ? `${o.remote}/${o.branch}` : cur.upstream;
  if (!from) return toast(`${cur.name} tracks no remote branch`, 'info', 'Pick the branch to pull in the Pull dialog, or set an upstream.');
  const before = headState(id);
  void guard('Pull', async () =>
    track(await client.pull(pathOf(id), strategy, { remote: o.remote, branch: o.remote ? o.branch : undefined, autostash }), `Pulling ${from} into ${cur.name} (${strategy === 'ff' ? 'fast-forward' : strategy})`, async (ok) => {
      if (!ok) return;
      if (liveId() !== id) await refresh(id).catch(() => {});
      const after = headState(id);
      const u = moveBack(`Pull ${from}`)({ before, after });
      if (u) pushUndo(id, { ...u, head: after.head });
      void followSubmodules(id, before.head, after.head);
    }),
  );
}
/**
 * Push a local branch (the current one unless given) to a branch of a remote: by default the one it tracks, else
 * the same name on the first remote, which it then tracks.
 */
export function push(opts: PushOptions = {}) {
  closeDialog();
  const id = liveId();
  const r = repoState(id ?? undefined);
  if (!id || !r) return;
  const local = r.refs.find((x) => x.kind === 'branch' && (opts.branch ? x.name === opts.branch : x.current));
  if (!local) return toast('Nothing to push', 'info', opts.branch ? `There is no local branch ${opts.branch}.` : 'HEAD is detached: check out a branch first.');
  const upRemote = upstreamRemote(r, local.upstream);
  const remote = opts.remote ?? upRemote ?? r.remotes[0]?.name;
  if (!remote) return toast('No remote to push to', 'info', 'Add one under Remotes in the sidebar.');
  const remoteBranch = opts.remoteBranch ?? (local.upstream && upRemote === remote ? local.upstream.slice(remote.length + 1) : local.name);
  const tracks = local.upstream === `${remote}/${remoteBranch}`;
  const setUpstream = opts.setUpstream ?? !local.upstream;
  void guard('Push', async () =>
    track(await client.push(pathOf(id), { remote, branch: local.name, remoteBranch, force: !!opts.force, tags: !!opts.tags, setUpstream: setUpstream && !tracks }), `Pushing ${local.name} to ${remote}/${remoteBranch}${opts.force ? ' (force)' : ''}`),
  );
}

// ---------- branches / tags / integration ----------

/** git refusing to switch because local changes (tracked or untracked) would be overwritten */
const CHANGES_IN_THE_WAY = /would be overwritten by checkout|Please commit your changes or stash them|untracked working tree files would be (overwritten|removed)/i;

/**
 * Switching to a branch, as Fork does it (also a double click in the sidebar or the history). A remote branch means
 * its local branch: the one that tracks it, else the same-named one, else a new one that tracks it. When git refuses
 * because local changes are in the way, the error offers to stash them, switch, and put them back.
 */
export function checkout(name: string) {
  const r = repoState();
  const ref = r?.refs.find((x) => x.name === name);
  let target = !ref && name.startsWith('origin/') ? name.slice('origin/'.length) : name;
  let start: string | undefined;
  if (ref?.kind === 'remote' && r) {
    const short = name.slice(name.indexOf('/') + 1);
    const local = r.refs.find((x) => x.kind === 'branch' && x.upstream === name) ?? r.refs.find((x) => x.kind === 'branch' && x.name === short);
    if (local) target = local.name;
    else [target, start] = [short, name];
  }
  if (r?.refs.some((x) => x.kind === 'branch' && x.current && x.name === target)) return toast(`Already on ${target}`, 'info');
  const id = liveId();
  void mutate(
    `Checkout ${target}`,
    (p) => (start ? client.createBranch(p, target, start, true) : client.checkout(p, target)),
    () => toast(start ? `Checked out ${target} (tracks ${start})` : `Checked out ${target}`, 'success'),
    {
      failAction: (message) =>
        CHANGES_IN_THE_WAY.test(message)
          ? {
              label: 'Stash, switch and reapply',
              run: () => {
                if (liveId() !== id) return toast(`Switch back to ${liveInfo(id)?.name ?? 'that repository'} first`, 'info');
                void checkoutWithStash(target, start);
              },
            }
          : undefined,
      undo: (c) => switchBack(`Checkout ${target}`, start ? (c.result as { name?: string })?.name ?? target : undefined)(c),
      moves: true,
    },
  );
}
/** Fork's "stash and reapply": the local changes go to the stash, the branch is checked out, the changes come back */
export async function checkoutWithStash(target: string, start?: string) {
  let res: { stashed: boolean; reapplied: boolean; output: string } | undefined;
  const ok = await mutate(
    `Checkout ${target}`,
    async (p) => {
      res = await client.checkoutWithStash(p, target, start);
    },
    undefined,
    { undo: switchBack(`Checkout ${target}`), moves: true },
  );
  if (!ok || !res) return;
  if (!res.stashed || res.reapplied) toast(`Checked out ${target}${res.stashed ? '; local changes reapplied' : ''}`, 'success');
  else toast(`Checked out ${target}, but the local changes conflict with it`, 'error', `Resolve the conflicts in the working tree; the changes also stay in the stash until you drop it.\n\n${res.output}`);
}
export function createBranch(name: string, sha: Sha, doCheckout: boolean) {
  closeDialog();
  if (!name.trim()) return;
  let made = name;
  void mutate(
    `Create branch ${name}`,
    async (p) => {
      made = (await client.createBranch(p, name, sha || 'HEAD', doCheckout)).name ?? name;
    },
    // the name it got: on a case-insensitive disk an existing folder keeps its spelling
    () => toast(made === name ? `Created branch ${made}` : `Created branch ${made}`, 'success', made === name ? undefined : `“${name.split('/').slice(0, -1).join('/')}/” already exists as “${made.split('/').slice(0, -1).join('/')}/”: on this disk names differing only in case are one folder`),
    {
      undo: (c) => {
        if (doCheckout) return switchBack(`Create branch ${made}`, made)(c);
        const ref = repoState()?.refs.find((x) => x.kind === 'branch' && x.name === made);
        return ref ? { label: `Create branch ${made}`, run: (q: string) => client.deleteRefAt(q, `refs/heads/${made}`, ref.sha) } : null;
      },
      moves: doCheckout,
    },
  );
}
export function deleteBranch(name: string, remote = false) {
  const r = repoState();
  const ref = r?.refs.find((x) => x.name === name);
  if (!ref) return;
  if (ref.current) return toast('Cannot delete the current branch', 'error');
  const isRemote = ref.kind === 'remote';
  confirm(`Delete ${isRemote ? 'remote branch' : 'branch'} ${name}?`, remote ? 'The branch will also be deleted on origin.' : 'Unmerged commits become unreachable.', () => {
    if (isRemote) {
      // a remote branch: only `git push <remote> --delete`, there is no local branch to remove
      const [rm, ...rest] = name.split('/');
      void mutate(`Delete ${name}`, (p) => client.deleteRemoteBranch(p, rm, rest.join('/')), () => toast(`Deleted ${name}`, 'success'));
    } else
      void mutate(`Delete ${name}`, (p) => client.deleteBranch(p, name, true, remote ? (ref.upstream?.split('/')[0] ?? r?.remotes[0]?.name) : undefined), () => toast(`Deleted ${name}`, 'success'), {
        undo: () => ({
          label: `Delete branch ${name}${remote ? ' (the remote one stays deleted)' : ''}`,
          run: async (q: string) => {
            await client.restoreRef(q, `refs/heads/${name}`, ref.sha);
            if (ref.upstream && !remote) await client.setUpstream(q, name, ref.upstream).catch(() => {});
          },
        }),
      });
  }, 'Delete', true);
}
/**
 * Several branches at once (the sidebar's ⌘/Shift selection): local ones (optionally with their remote branches,
 * optionally even unmerged) and remote ones. One summary; whatever git refused goes to the error dialog with why.
 */
export async function deleteBranchesBatch(names: string[], opts: { force: boolean; withRemote: boolean }) {
  const id = liveId();
  const r = repoState(id ?? undefined);
  if (!id || !r) return;
  closeDialog();
  const kind = new Map(r.refs.map((x) => [x.name, x]));
  const locals = names.filter((n) => kind.get(n)?.kind === 'branch' && !kind.get(n)?.current);
  const remotes = names.filter((n) => kind.get(n)?.kind === 'remote');
  const total = locals.length + remotes.length;
  const done: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const take = (res?: { done: string[]; failed: { name: string; error: string }[] }) => {
    if (!res) return;
    done.push(...res.done);
    failed.push(...res.failed);
  };
  setState({ operation: { label: `Deleting ${total} branches`, progress: 0.3, log: [] } });
  try {
    if (locals.length) take(await guard('Delete branches', () => client.deleteBranches(pathOf(id), locals, opts.force, opts.withRemote)));
    if (remotes.length) take(await guard('Delete remote branches', () => client.deleteRemoteBranches(pathOf(id), remotes)));
  } finally {
    setState({ operation: null });
  }
  updateRepo({ refSelection: [], refAnchor: null }, id);
  await guard('Refresh', () => refresh(id));
  const list = (xs: string[]) => (xs.length > 6 ? `${xs.slice(0, 6).join(', ')} and ${xs.length - 6} more` : xs.join(', '));
  // a remote twin picked as well as its local branch is reported once
  done.splice(0, done.length, ...new Set(done));
  if (done.length) toast(`Deleted ${done.length} branch${done.length === 1 ? '' : 'es'}`, 'success', list(done));
  // the local ones come back where they were, with their upstreams (deleted remote branches stay deleted)
  const back = done.map((n) => kind.get(n)).filter((x): x is NonNullable<typeof x> => !!x && x.kind === 'branch');
  if (back.length)
    pushUndo(id, {
      label: `Delete ${back.length} branch${back.length === 1 ? '' : 'es'}${opts.withRemote || remotes.length ? ' (remote ones stay deleted)' : ''}`,
      head: repoState(id)?.head ?? '',
      run: async (q) => {
        for (const b of back) {
          await client.restoreRef(q, `refs/heads/${b.name}`, b.sha);
          if (b.upstream && !opts.withRemote) await client.setUpstream(q, b.name, b.upstream).catch(() => {});
        }
      },
    });
  // git's advice lines ("hint: If you are sure…") repeat for every branch: one reason per branch is enough
  const reason = (e: string) =>
    e
      .split('\n')
      .filter((l) => !/^hint:/.test(l.trim()))
      .join('\n  ')
      .replace(/^error: /, '');
  const unmerged = failed.filter((f) => /not fully merged/.test(f.error)).map((f) => f.name);
  if (failed.length)
    toast(
      `${failed.length} of ${total} branches not deleted`,
      'error',
      failed.map((f) => `${f.name}\n  ${reason(f.error)}`).join('\n\n'),
      // the unmerged ones are one click away from going too
      unmerged.length
        ? {
            label: `Delete ${unmerged.length} unmerged anyway`,
            run: () => {
              // only in the repository they belong to
              if (liveId() !== id) return toast(`Switch back to ${liveInfo(id)?.name ?? 'that repository'} first`, 'info');
              void deleteBranchesBatch(unmerged, { force: true, withRemote: opts.withRemote });
            },
          }
        : undefined,
    );
}
/** an action that waits in a repository's queue is dropped (a running one finishes) */
export function cancelQueued(id: number) {
  void guard('Cancel', () => client.cancelQueued(id));
}
/**
 * A lock file that another git process left behind (it crashed, or was killed): deleting it lets the waiting actions
 * run. Asked first; the engine refuses while the file still changes.
 */
export function removeStaleLock(repoPath: string, lock: string) {
  const name = lock.split('/').pop() ?? lock;
  confirm(`Delete ${name}?`, `It has not changed for a while, so the git process that created it has probably crashed. If git is still running in this repository (a terminal, an IDE, another client), wait for it instead.\n\n${lock}`, () => {
    void guard(`Delete ${name}`, async () => {
      const r = await client.removeLock(repoPath, name);
      toast(r.removed ? `Deleted ${name}` : `${name} is already gone`, 'success');
    });
  }, 'Delete', true);
}
/** the selected local branches to the first remote in one push; each gets it as its upstream */
export function pushBranchesBatch(names: string[]) {
  const id = liveId();
  const r = repoState(id ?? undefined);
  if (!id || !r) return;
  const locals = names.filter((n) => r.refs.some((x) => x.name === n && x.kind === 'branch'));
  if (!locals.length) return;
  const remote = r.remotes.find((x) => x.name === 'origin')?.name ?? r.remotes[0]?.name ?? 'origin';
  void guard('Push branches', async () => track(await client.pushBranches(pathOf(id), locals, remote), `Pushing ${locals.length} branches to ${remote}`));
}
export function renameBranch(oldName: string, newName: string) {
  void mutate('Rename branch', (p) => client.renameBranch(p, oldName, newName), undefined, { undo: (c) => ({ label: `Rename ${oldName} → ${c.result?.name ?? newName}`, run: (q: string) => client.renameBranch(q, c.result?.name ?? newName, oldName) }) });
}
export function createTag(name: string, sha: Sha, annotated: boolean, pushIt: boolean) {
  closeDialog();
  if (!name.trim()) return;
  void mutate(`Tag ${name}`, (p) => client.createTag(p, name, sha, annotated ? name : undefined), () => {
    toast(`Created tag ${name}`, 'success');
    if (pushIt) {
      const id = liveId()!;
      void guard('Push tag', async () => track(await client.push(pathOf(id), { tags: true }), `Pushing tag ${name}`));
    }
  });
}
export function deleteTag(name: string) {
  confirm(`Delete tag ${name}?`, 'The tag is removed locally only.', () => void mutate(`Delete tag ${name}`, (p) => client.deleteTag(p, name), undefined, { undo: (c) => (c.result?.sha ? { label: `Delete tag ${name}`, run: (q: string) => client.restoreRef(q, `refs/tags/${name}`, c.result.sha) } : null) }), 'Delete', true);
}
export function merge(source: string, opts: { noFf?: boolean; squash?: boolean } = {}) {
  closeDialog();
  void mutate(
    `Merge ${source}`,
    async (p) => {
      const r = await client.merge(p, source, opts);
      if (r.conflicts) toast('Merge stopped on conflicts', 'error', 'resolve files in Changes, then commit');
      else toast(`Merged ${source}`, 'success');
    },
    undefined,
    { undo: moveBack(`Merge ${source}`), moves: true },
  );
}
export function rebase(onto: string, todo?: RebaseTodo[]) {
  closeDialog();
  void mutate(
    `Rebase onto ${onto}`,
    async (p) => {
      const r = todo ? await client.rebaseInteractive(p, onto, todo.map((t) => ({ sha: t.sha, action: t.action, message: t.message })) as RebaseTodoItem[]) : await client.rebase(p, onto, { autostash: true });
      if (r.conflicts) toast('Rebase stopped on conflicts', 'error', 'resolve, stage, then Continue in the status bar');
      else toast(`Rebased onto ${onto}`, 'success');
    },
    undefined,
    { undo: moveBack(`Rebase onto ${onto}`), moves: true },
  );
}
export function rebaseContinue() {
  void mutate('Continue rebase', (p) => client.rebaseContinue(p));
}
export function rebaseAbort() {
  void mutate('Abort rebase', (p) => client.rebaseAbort(p));
}
export function mergeAbort() {
  void mutate('Abort merge', (p) => client.mergeAbort(p));
}
export function cherryPick(sha: Sha) {
  void mutate(
    'Cherry-pick',
    async (p) => {
      const r = await client.cherryPick(p, sha);
      toast(r.conflicts ? 'Cherry-pick stopped on conflicts' : `Cherry-picked ${sha.slice(0, 7)}`, r.conflicts ? 'error' : 'success');
    },
    undefined,
    { undo: moveBack(`Cherry-pick ${sha.slice(0, 7)}`), moves: true },
  );
}
export function revert(sha: Sha) {
  void mutate(
    'Revert',
    async (p) => {
      const r = await client.revert(p, sha);
      toast(r.conflicts ? 'Revert stopped on conflicts' : `Reverted ${sha.slice(0, 7)}`, r.conflicts ? 'error' : 'success');
    },
    undefined,
    { undo: moveBack(`Revert ${sha.slice(0, 7)}`), moves: true },
  );
}
export function reset(sha: Sha, mode: 'soft' | 'mixed' | 'hard') {
  closeDialog();
  void mutate(`Reset (${mode})`, (p) => client.reset(p, sha, mode), () => toast(`Reset (${mode}) to ${sha.slice(0, 7)}`, 'success'), {
    // back where it was: soft and mixed restore what they changed; after a hard reset the dropped local changes stay gone
    undo: (c) =>
      c.before.head && c.before.head !== c.after.head
        ? { label: `Reset (${mode}) to ${sha.slice(0, 7)}`, moves: true, run: (q: string) => client.reset(q, c.before.head, mode === 'hard' ? 'keep' : mode) }
        : null,
    moves: true,
  });
}
export function stash(message: string, keepStaged: boolean, includeUntracked: boolean) {
  closeDialog();
  void mutate('Stash', (p) => client.stashPush(p, message, keepStaged, includeUntracked), () => toast('Saved working directory to stash', 'success'), {
    undo: (c) => (c.result?.sha ? { label: `Stash${message ? ` “${message}”` : ''}`, run: (q: string) => client.stashPopCommit(q, c.result.sha) } : null),
  });
}
export function applyStash(index: number, pop: boolean) {
  void mutate(pop ? 'Pop stash' : 'Apply stash', (p) => client.stashApply(p, index, pop), () => updateRepo((r) => ({ section: 'changes', selectedArea: 'unstaged', selectedFile: r.unstaged[0]?.path ?? null, selectedStash: null })));
}
export function dropStash(index: number) {
  confirm('Drop stash?', 'The stash leaves the list (Undo puts it back).', () =>
    void mutate('Drop stash', (p) => client.stashDrop(p, index), () => updateRepo((r) => ({ selectedStash: null, selectedArea: 'commit', selectedCommit: r.head })), {
      undo: (c) => (c.result?.sha ? { label: `Drop stash${c.result.message ? ` “${c.result.message}”` : ''}`, run: (q: string) => client.stashStore(q, c.result.sha, c.result.message) } : null),
    }), 'Drop', true);
}

export { openRepo };

// =====================================================================================
// Engine-backed services beyond git: workspaces, settings, accounts, ssh, system, agent.
// =====================================================================================


export function engineOnline() {
  return getState().engine.online;
}

// ---------- ui preferences ----------

const UI_KEY = 'prong.ui';
let uiTimer: ReturnType<typeof setTimeout> | null = null;
let uiPatch: Partial<UiSettings> = {};
/** Remembers theme / scale / list-tree / diff mode / sidebar width: engine settings, mirrored in local storage. */
export function persistUi(patch: Partial<UiSettings>) {
  uiPatch = { ...uiPatch, ...patch };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(UI_KEY, JSON.stringify({ ...(readLocalUi() ?? {}), ...uiPatch }));
  } catch {
    /* storage unavailable */
  }
  if (uiTimer) clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    const p = uiPatch;
    uiPatch = {};
    uiTimer = null;
    if (!engineOnline()) return;
    void client.saveSettings({ ui: p } as Partial<ServerSettings>).then((next) => setState({ serverSettings: next })).catch(() => {});
  }, 300);
}
export function readLocalUi(): Partial<UiSettings> | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(UI_KEY);
    return raw ? (JSON.parse(raw) as Partial<UiSettings>) : null;
  } catch {
    return null;
  }
}
/** Before the engine answers: local mirror of the preferences (web dev without an engine keeps them too). */
export function applyLocalUi() {
  const ui = readLocalUi();
  if (ui) applyUiPrefs(ui);
}

/** Pull persisted workspaces, settings, accounts and keys from the engine (called from bootstrap). */
export async function syncServerState() {
  const [ws, settings, accounts, keys, agentCheck] = await Promise.all([client.workspaces(), client.settings(), client.accounts().catch(() => []), client.sshKeys().catch(() => []), client.agentCheck().catch(() => null)]);
  setState((s) => {
    const byId = new Map(s.workspaces.map((w) => [w.id, w]));
    const merged: Workspace[] = ws.map((w) => ({ ...(byId.get(w.id) ?? {}), id: w.id, name: w.name, rootPath: w.rootPath, scanDepth: w.scanDepth }));
    for (const w of s.workspaces) if (!merged.some((m) => m.id === w.id)) merged.push(w);
    const activeWorkspace = merged.some((w) => w.id === s.activeWorkspace) ? s.activeWorkspace : merged[0]?.id ?? 'work';
    return {
      workspaces: merged,
      activeWorkspace,
      serverSettings: settings,
      accounts: accounts.map(toAccount),
      sshKeys: keys.map(toKey),
      agentAvailable: agentCheck,
      agent: { ...s.agent, settings: { ...s.agent.settings, provider: settings.agent.provider, model: settings.agent.model || s.agent.settings.model, cliPath: settings.agent.cliPath || agentCheck?.path || '', sourcesPath: settings.agent.sourcesPath || s.agent.settings.sourcesPath, askBeforeApply: settings.agent.askBeforeApply, autoRollbackOnBuildError: settings.agent.autoRollbackOnBuildError, connected: !!agentCheck?.ok, cliVersion: agentCheck?.version?.replace(/\s*\(Claude Code\)/, '') ?? '' } },
    };
  });
  // the engine's copy of the UI preferences wins over the local mirror
  if (settings.ui) applyUiPrefs(settings.ui);
  void loadAppVersions();
  // workspaces with a root folder are rescanned on start
  for (const w of ws) if (w.rootPath) void scanWorkspace(w.id, false);
}

const toAccount = (a: { id: string; host: string; login: string; name: string; avatar?: string; orgs: string[] }): GitHubAccount => ({ id: a.id, host: a.host, login: a.login, name: a.name, orgs: a.orgs, avatarColor: '#e8b23b', avatar: a.avatar });
const toKey = (k: { name: string; type: string; fingerprint: string; publicKey: string; inAgent: boolean; hasPassphrase: boolean | null }): SshKey => ({ id: k.name, name: k.name, type: k.type, fingerprint: k.fingerprint, publicKey: k.publicKey, inAgent: k.inAgent, addedToGitHub: false, hasPassphrase: k.hasPassphrase });

// ---------- workspaces ----------

export async function persistWorkspaces() {
  if (!engineOnline()) return;
  const list = getState().workspaces.map((w) => ({ id: w.id, name: w.name, rootPath: w.rootPath, scanDepth: w.scanDepth }));
  await client.saveWorkspaces(list).catch((e) => toast('Could not save workspaces', 'error', String(e?.message ?? e)));
}

export async function setWorkspaceRoot(id: string, rootPath: string | undefined, scanDepth = 3) {
  setState((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, rootPath: rootPath || undefined, scanDepth } : w)) }));
  await persistWorkspaces();
  if (rootPath) await scanWorkspace(id, true);
}

/** Scans the workspace folder, registers new repositories with the engine and merges them into the list. */
export async function scanWorkspace(id: string, announce = true) {
  const ws = getState().workspaces.find((w) => w.id === id);
  if (!ws?.rootPath || !engineOnline()) return;
  setState({ scanning: id });
  try {
    const found = await client.scan(ws.rootPath, ws.scanDepth ?? 3, { workspace: id });
    const known = await client.listRepos();
    setState((s) => {
      const existing = new Map(s.repos.map((r) => [r.path, r]));
      const added: RepoInfo[] = [];
      const byPath = new Map(known.map((k) => [k.path, k]));
      for (const k of known) {
        if (existing.has(k.path)) continue;
        added.push({ id: `live:${k.path}`, name: k.name, workspace: k.workspace, workspaces: k.workspaces, path: k.path, currentBranch: '', changes: 0, lastOpened: k.lastOpened, live: true });
      }
      // entries the engine dropped (nested checkouts, folders gone) leave the list and their tabs;
      // workspace membership (own workspace + workspaces whose scans find it) follows the engine
      const kept = s.repos
        .filter((r) => !r.live || !r.path || byPath.has(r.path))
        .map((r) => {
          const k = r.live && r.path ? byPath.get(r.path) : undefined;
          return k ? { ...r, workspace: k.workspace, workspaces: k.workspaces } : r;
        });
      const keptIds = new Set(kept.map((r) => r.id));
      const tabs = s.tabs.filter((t) => keptIds.has(t));
      const activeTab = s.activeTab && keptIds.has(s.activeTab) ? s.activeTab : tabs[0] ?? null;
      return { repos: [...kept, ...added], tabs, activeTab, scanning: null };
    });
    if (announce) toast(`Scanned ${ws.rootPath}`, 'success', `${found.filter((f) => !f.nested).length} repositories`);
  } catch (e: any) {
    setState({ scanning: null });
    toast('Scan failed', 'error', String(e?.message ?? e));
  }
}

/** Choose the workspace root folder: native picker inside Prong.app, the workspace dialog elsewhere. */
export async function chooseWorkspaceRoot(wsId: string) {
  const { desktop, pickFolder } = await import('../desktop');
  const { openDialog } = await import('./store');
  if (!desktop()) {
    openDialog({ type: 'workspace', id: wsId });
    return;
  }
  const picked = await pickFolder('Choose a folder: its subfolders are scanned for git repositories', 'Scan');
  if (picked) await setWorkspaceRoot(wsId, picked, 3);
}

// ---------- settings ----------

export async function saveSettings(patch: Partial<ServerSettings>) {
  if (!engineOnline()) {
    setState((s) => ({ serverSettings: { ...(s.serverSettings as ServerSettings), ...patch } }));
    return;
  }
  const next = await client.saveSettings(patch).catch((e) => {
    toast('Could not save settings', 'error', String(e?.message ?? e));
    return null;
  });
  if (next) setState({ serverSettings: next });
}

export async function readGlobalIdentity(): Promise<{ name: string; email: string }> {
  const p = liveInfo()?.path ?? getState().repos.find((r) => r.live)?.path;
  if (!p || !engineOnline()) return { name: '', email: '' };
  const [name, email] = await Promise.all([client.globalConfig(p, 'user.name'), client.globalConfig(p, 'user.email')]);
  return { name: name ?? '', email: email ?? '' };
}
export async function writeGlobalIdentity(name: string, email: string) {
  const p = liveInfo()?.path ?? getState().repos.find((r) => r.live)?.path;
  if (!p || !engineOnline()) return;
  await guard('Save identity', async () => {
    await client.setGlobalConfig(p, 'user.name', name);
    await client.setGlobalConfig(p, 'user.email', email);
    toast('Git identity saved', 'success');
  });
}
export async function setSignCommits(on: boolean) {
  const p = liveInfo()?.path;
  if (p) await guard('commit.gpgsign', () => client.setConfig(p, 'commit.gpgsign', on ? 'true' : 'false'));
  await saveSettings({ signCommits: on });
}

// ---------- accounts & ssh ----------

export async function refreshAccounts() {
  const list = await client.accounts().catch(() => []);
  setState({ accounts: list.map(toAccount) });
}
export async function addAccount(host: string, token: string) {
  const a = await guard('GitHub sign-in', () => client.addAccount(host, token));
  if (!a) return false;
  await refreshAccounts();
  toast(`Signed in as ${a.login}`, 'success', `${a.host} · token stored in Keychain`);
  return true;
}
export async function removeAccount(id: string) {
  await guard('Remove account', () => client.removeAccount(id));
  await refreshAccounts();
}
export async function githubRepos(accountId: string): Promise<GhRepo[]> {
  return (await guard('GitHub repositories', () => client.githubRepos(accountId))) ?? [];
}
export async function refreshSshKeys() {
  const keys = await client.sshKeys().catch(() => []);
  setState((s) => ({ sshKeys: keys.map((k) => ({ ...toKey(k), addedToGitHub: s.sshKeys.find((x) => x.id === k.name)?.addedToGitHub ?? false })) }));
}
export async function generateKey(name: string, type: 'ed25519' | 'rsa' | 'ecdsa', passphrase: string) {
  const r = await guard('ssh-keygen', () => client.sshGenerate(name, type, passphrase, ''));
  if (r) {
    toast(`Generated ${r.file}`, 'success');
    await refreshSshKeys();
  }
}
export async function addKeyToAgent(name: string) {
  const ok = await guard('ssh-add', () => client.sshAgentAdd(name));
  if (ok !== undefined) {
    toast(`Added ${name} to ssh-agent`, 'success');
    await refreshSshKeys();
  }
}
export function testSsh(host = 'github.com') {
  void guard('ssh test', async () => track(await client.sshTest(host), `Testing ssh to ${host}`));
}
export async function uploadKeyToGitHub(accountId: string, key: SshKey) {
  const r = await guard('Upload key', () => client.githubAddKey(accountId, `Prong · ${key.name}`, key.publicKey));
  if (r) {
    setState((s) => ({ sshKeys: s.sshKeys.map((k) => (k.id === key.id ? { ...k, addedToGitHub: true } : k)) }));
    toast('Public key added to GitHub', 'success');
  }
}
export async function deviceFlow(clientId: string, host: string, onCode: (code: string, url: string) => void): Promise<boolean> {
  const start = await guard('Device flow', () => client.githubDeviceStart(clientId, host));
  if (!start) return false;
  onCode(start.user_code, start.verification_uri);
  // the code goes to the clipboard and the verification page opens by itself: paste, approve, done
  copyText(start.user_code);
  void openUrl(start.verification_uri).catch(() => {});
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, (start.interval + 1) * 1000));
    const p: { done: boolean; account?: { login: string }; error?: string } = await client.githubDevicePoll(clientId, start.device_code, host).catch(() => ({ done: false, error: 'network' }));
    if (p.done) {
      await refreshAccounts();
      toast(`Signed in as ${p.account?.login}`, 'success');
      return true;
    }
    if (p.error && p.error !== 'authorization_pending' && p.error !== 'slow_down') {
      toast('Device flow failed', 'error', p.error);
      return false;
    }
  }
  toast('Device code expired', 'error');
  return false;
}

// ---------- system ----------

function editorApp() {
  return getState().serverSettings?.editor || 'Visual Studio Code';
}
export function openInEditor(path: string) {
  void guard('Open in editor', () => client.systemOpen(path, editorApp()));
}
export function openInDiffTool(path: string) {
  const s = getState().serverSettings;
  void guard('Open in diff tool', () => client.systemOpen(path, s?.diffTool || editorApp()));
}
export function revealPath(path: string) {
  void guard('Reveal', () => client.systemReveal(path));
}
export function openTerminalAt(path: string) {
  void guard('Open terminal', () => client.systemTerminal(path, getState().serverSettings?.terminal));
}
/** absolute path of a file inside the active live repository */
export function absPath(rel: string) {
  const p = liveInfo()?.path;
  return p ? `${p}/${rel}` : rel;
}
/** Opens a URL in the default browser: the native shell inside Prong.app, a new tab on the web, the engine otherwise. */
export async function openUrl(url: string) {
  const { desktop, openExternal } = await import('../desktop');
  if (desktop()) {
    await openExternal(url);
    return;
  }
  if (typeof window !== 'undefined' && window.open) {
    const w = window.open(url, '_blank', 'noopener');
    if (w) return;
  }
  await guard('Open link', () => client.systemOpen(url, ''));
}
export function copyText(text: string) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable */
  }
  toast('Copied', 'info', text.length > 60 ? text.slice(0, 60) + '…' : text);
}
export function addToGitignore(pattern: string) {
  void mutate('Add to .gitignore', (p) => client.appendIgnore(p, pattern), () => toast(`Added ${pattern} to .gitignore`, 'success'));
}

// ---------- history, blame, paging ----------

export async function showFileHistory(file: string) {
  const id = liveId();
  if (!id) return;
  // from a commit's file list the history runs down from that commit (it may be on another branch)
  const r = repoState(id);
  const from = r?.selectedArea === 'commit' && r.selectedCommit ? r.selectedCommit : undefined;
  updateRepo({ historyPath: file, historyCommits: [], section: 'commits', selectedArea: 'commit' }, id);
  const commits = await guard('File history', () => client.logFile(pathOf(id), file, 300, from));
  if (commits) {
    updateRepo({ historyCommits: commits, selectedCommit: commits[0]?.sha ?? null, selectedFile: file }, id);
    if (commits[0]) await ensureCommitFiles(id, commits[0].sha);
  }
}
export function clearFileHistory() {
  updateRepo({ historyPath: null, historyCommits: [] });
}
export async function showBlame(file: string) {
  const id = liveId();
  if (!id) return;
  // from a commit's file list: the file as it is in that commit (it may not exist in the working copy)
  const r = repoState(id);
  const rev = r?.selectedArea === 'commit' && r.selectedCommit ? r.selectedCommit : undefined;
  updateRepo({ blame: { path: file, lines: [] } }, id);
  const lines = await guard('Blame', () => client.blame(pathOf(id), file, rev));
  // a failed blame says so (guard) and closes the panel instead of leaving "loading…" over the diff
  updateRepo({ blame: lines ? { path: file, lines } : null }, id);
}
export function closeBlame() {
  updateRepo({ blame: null });
}
export async function loadMoreCommits() {
  const id = liveId();
  const r = repoState(id ?? undefined);
  if (!id || !r || r.loadingMore || r.historyPath) return;
  if (r.filteredCommits) {
    // the branch-filtered history pages too
    const revs = filterRevs(r.graphFilter);
    if (r.filterExhausted || !revs?.length) return;
    updateRepo({ loadingMore: true }, id);
    const page = await guard('Load more', () => client.logPage(pathOf(id), r.filteredCommits!.length, 300, revs));
    updateRepo((rr) => ({ loadingMore: false, filterExhausted: !page || page.length < 300, filteredCommits: page && rr.filteredCommits ? appendNew(rr.filteredCommits, page) : rr.filteredCommits }), id);
    return;
  }
  if (r.logExhausted) return;
  updateRepo({ loadingMore: true }, id);
  const page = await guard('Load more', () => client.logPage(pathOf(id), r.commits.length, 300));
  updateRepo((rr) => ({ loadingMore: false, logExhausted: !page || page.length === 0, commits: page ? appendNew(rr.commits, page) : rr.commits }), id);
}

/** Branch filter for live repos: ask git for the reachable set instead of filtering the loaded page. */
export async function applyGraphFilter(id?: string) {
  const rid = id ?? liveId();
  const r = repoState(rid ?? undefined);
  if (!rid || !r) return;
  const revs = filterRevs(r.graphFilter);
  if (!revs) {
    updateRepo({ filteredCommits: null, filterExhausted: false }, rid);
    return;
  }
  if (revs.length === 0) {
    updateRepo({ filteredCommits: [], filterExhausted: true }, rid);
    return;
  }
  const commits = await guard('Filter history', () => client.logPage(pathOf(rid), 0, 300, revs));
  if (commits) updateRepo({ filteredCommits: commits, filterExhausted: commits.length < 300 }, rid);
}

// ---------- submodules ----------

export async function loadSubmodules(id?: string) {
  const rid = id ?? liveId();
  if (!rid) return;
  const subs = await client.submodules(pathOf(rid)).catch(() => null);
  if (subs) updateRepo({ submodules: subs }, rid);
}
export function updateSubmodules(paths?: string[], recursive = false) {
  const id = liveId();
  if (!id) return;
  void guard('Submodule update', async () => track(await client.submoduleUpdate(pathOf(id), paths, recursive), paths?.length === 1 ? `Updating ${paths[0]}` : 'Updating submodules', () => void loadSubmodules(id)));
}
export function syncSubmodules() {
  void mutate('Submodule sync', (p) => client.submoduleSync(p), () => void loadSubmodules());
}
export function openSubmodule(sub: Submodule) {
  const base = liveInfo()?.path;
  if (base) void openPath(`${base}/${sub.path}`);
}
/**
 * From a submodule change (a commit's file list, Changes): open the submodule's tab and select `sha` in its history,
 * read down to it when it is deep. If the submodule's clone does not have the commit yet, the tab opens and the
 * error dialog says what to do.
 */
export async function openSubmoduleAt(subPath: string, sha?: Sha) {
  const parent = liveInfo();
  if (!parent) return;
  const present = sha ? !!(await client.submoduleCommits(parent.path, subPath, [sha]).catch(() => null))?.[sha] : true;
  await openPath(`${parent.path}/${subPath}`);
  if (liveInfo()?.path === parent.path) return; // the submodule did not open (the error is shown)
  if (!sha) {
    // no commit named (a change in the working copy): what the submodule has checked out
    const head = repoState(liveId() ?? undefined)?.head;
    if (head) await revealCommit(head);
    return;
  }
  if (!present) {
    toast(`${sha.slice(0, 7)} is not in the submodule clone`, 'error', `${subPath} does not have commit ${sha} yet.\nFetch in the submodule, or run "Update to index" in ${parent.name}.`);
    return;
  }
  await revealCommit(sha);
}
/** the submodule's commits between two pointers (see the engine's submoduleRange) */
export async function submoduleRange(sub: string, before: string, after: string) {
  const id = liveId();
  if (!id) return null;
  return client.submoduleRange(pathOf(id), sub, before, after, 100).catch(() => null);
}
// ---------- connection (SSH key / account) per repository ----------

export async function connectionInfo() {
  const id = liveId();
  if (!id) return null;
  return guard('Connection settings', () => client.authInfo(pathOf(id)));
}
/** save this repository's connection (null: none of its own; a submodule then uses its parent's) */
export async function setConnection(auth: RepoAuth | null, describe: string) {
  const id = liveId();
  if (!id) return false;
  const ok = await guard('Save connection', () => client.setAuth(pathOf(id), auth));
  if (ok === undefined) return false;
  toast(`${liveInfo(id)?.name}: ${describe}`, 'success', 'fetch, pull and push use it, and so do its submodules unless they have their own');
  return true;
}
export async function testConnection(remote: string, auth?: RepoAuth | null) {
  const id = liveId();
  if (!id) return null;
  return client.testAuth(pathOf(id), remote, auth).catch((e) => ({ ok: false, output: String(e?.message ?? e), describe: '' }));
}

export async function submoduleSubjects(sub: string, shas: string[]) {
  const id = liveId();
  if (!id) return {};
  return (await client.submoduleCommits(pathOf(id), sub, shas).catch(() => ({}))) as Record<string, string>;
}

// ---------- remotes, tags, upstream, detached ----------

export function addRemote(name: string, url: string) {
  closeDialog();
  void mutate(`Add remote ${name}`, (p) => client.addRemote(p, name, url));
}
export function setRemoteUrl(name: string, url: string) {
  closeDialog();
  void mutate(`Edit remote ${name}`, (p) => client.setRemoteUrl(p, name, url));
}
export function removeRemote(name: string) {
  confirm(`Remove remote ${name}?`, 'Remote-tracking branches of this remote are deleted locally.', () => void mutate(`Remove remote ${name}`, (p) => client.removeRemote(p, name)), 'Remove', true);
}
export function pruneRemote(name: string) {
  void mutate(`Prune ${name}`, async (p) => {
    const r = await client.pruneRemote(p, name);
    toast(`Pruned ${name}`, 'success', r.output.split('\n').filter(Boolean).slice(-2).join(' ') || 'nothing to prune');
  });
}
export function pushTag(tag: string) {
  const id = liveId();
  if (!id) return;
  void guard('Push tag', async () => track(await client.pushTag(pathOf(id), tag), `Pushing tag ${tag}`));
}
export function checkoutDetached(sha: string) {
  void mutate(`Checkout ${sha.slice(0, 7)}`, (p) => client.checkoutDetached(p, sha), () => toast(`Detached HEAD at ${sha.slice(0, 7)}`, 'info'), { undo: switchBack(`Checkout ${sha.slice(0, 7)}`), moves: true });
}
export function setUpstream(branch: string, upstream: string) {
  closeDialog();
  void mutate('Set upstream', (p) => client.setUpstream(p, branch, upstream));
}
export function renameBranchTo(oldName: string, newName: string) {
  closeDialog();
  void mutate('Rename branch', (p) => client.renameBranch(p, oldName, newName), () => toast(`Renamed ${oldName} → ${newName}`, 'success'), {
    undo: (c) => ({ label: `Rename ${oldName} → ${c.result?.name ?? newName}`, run: (q: string) => client.renameBranch(q, c.result?.name ?? newName, oldName) }),
  });
}

// ---------- real agent (Claude Code through the engine) ----------

export function agentReady() {
  const s = getState();
  return engineOnline() && !!s.agentAvailable?.ok && s.agent.settings.provider === 'anthropic-claude-code';
}

let agentMsgId = 0;
let agentOp: { opId: string; msgId: number; mode: 'repo' | 'app'; prompt: string; cwd: string; retargetable: boolean; before?: Record<string, string> } | null = null;
/** the interface rebuild after an app change; its success arrives as the engine's `ui-updated` broadcast */
let rebuildOp: { opId: string; msgId: number | null; versionSha: string | null; cwd: string } | null = null;

function pushAgentMessage(m: Omit<AgentMessage, 'id' | 'time'>) {
  const id = ++agentMsgId + 100000;
  updateAgent((a) => ({ messages: [...a.messages, { ...m, id, time: Date.now() }] }));
  return id;
}
function patchAgentMessage(id: number, fn: (m: AgentMessage) => AgentMessage) {
  updateAgent((a) => ({ messages: a.messages.map((m) => (m.id === id ? fn(m) : m)) }));
}

export async function agentSend(text: string) {
  const s = getState();
  const clean = text.trim();
  if (!clean || s.agent.busy) return;
  const auto = s.agent.target === 'auto';
  const last = s.agent.session;
  // a reply ("да, сделай", "почему?") goes on where the conversation is: same target, same repository
  const reply = auto && !!last && !mentionsTarget(clean);
  const mode: 'repo' | 'app' = s.agent.target === 'app' ? 'app' : s.agent.target === 'repo' ? 'repo' : reply ? last!.mode : classifyAgentTarget(clean);
  pushAgentMessage({ role: 'user', text: clean, target: mode });
  // a message in the chat continues the conversation (Claude Code remembers it) when it runs in the same place
  await startAgentRun(clean, mode, auto && !reply, '', reply && mode === 'repo' ? last!.cwd : undefined, true);
}

/**
 * Starts a Claude Code run; `retargetable` lets the agent bounce an AUTO request to the other target once.
 * `hint` is appended to the prompt the agent sees (not to the recorded version message).
 */
async function startAgentRun(clean: string, mode: 'repo' | 'app', retargetable: boolean, hint = '', repoPath?: string, followUp = false) {
  const s = getState();
  const cwd = mode === 'repo' ? repoPath ?? liveInfo()?.path : s.agent.settings.sourcesPath;
  // the chat's last session, when it ran in the same place: Claude Code remembers what was said and done
  const last = s.agent.session;
  const resume = followUp && last && last.mode === mode && last.cwd === cwd ? last.id : undefined;
  if (!cwd) {
    // nothing to run in: say so where the user is looking (the bar's notice, or the chat)
    const id = pushAgentMessage({ role: 'agent', text: mode === 'repo' ? 'Откройте репозиторий: команда выполняется в его рабочей папке.' : 'Укажите папку исходников приложения в Settings → App sources: туда агент вносит изменения.', target: mode });
    finishAgentRun(id, { ok: false, error: mode === 'repo' ? 'No repository open' : 'No app sources folder' });
    return;
  }
  updateAgent((a) => ({ busy: true, status: 'Starting Claude Code…', startedAt: a.startedAt ?? Date.now() }));
  const msgId = pushAgentMessage({ role: 'agent', text: '', actions: [], target: mode });
  // app sources: remember what was already changed so the version holds only the agent's edits
  let before: Record<string, string> | undefined;
  if (mode === 'app') {
    const prep = await client.appPrepare(cwd).catch((e) => String(e?.message ?? e));
    if (typeof prep === 'string') {
      patchAgentMessage(msgId, (m) => ({ ...m, text: `⚠ ${prep}` }));
      finishAgentRun(msgId, { ok: false, error: prep });
      return;
    }
    before = prep.before;
  }
  const op = await guard('Agent', () => client.agentRun(clean + hint, cwd, mode, !s.agent.settings.askBeforeApply, resume));
  if (!op) {
    patchAgentMessage(msgId, (m) => ({ ...m, text: 'Не удалось запустить Claude Code. Проверьте путь к бинарю в Settings.' }));
    finishAgentRun(msgId, { ok: false, error: 'Claude Code did not start' });
    return;
  }
  agentOp = { opId: op.opId, msgId, mode, prompt: clean, cwd, retargetable, before };
  setState({ operation: { label: 'Agent working', progress: 0, log: [] } });
}

/** what an error window hands to the agent */
export interface Problem {
  title: string;
  /** git's output, a stack */
  detail?: string;
  /** the repository it happened in (path); the active one when not given */
  repo?: string;
  /** Prong itself failed (a crash): looked into in the app's sources, as a change to the app */
  app?: boolean;
  /** more of what was going on (the remote and the connection that was tried…) */
  context?: string;
}

/** lines of the output the chat shows with the question */
const SHOWN_LINES = 12;
const FENCE = '```';
/** the agent sees the start and the end of a long output (where git puts the cause) */
function clip(text: string, max = 8000) {
  return text.length > max ? `${text.slice(0, 3000)}\n…\n${text.slice(-(max - 3000))}` : text;
}

/**
 * "Ask AI" in an error window: the problem goes to Claude Code with what it needs — what failed, the output or the
 * stack, the repository and its branch — and the chat opens on the run. A git failure is looked into in its
 * repository (the agent runs git and reads there); a crash of Prong in Prong's sources, as a change to the app.
 */
export function askAgentAbout(p: Problem) {
  const s = getState();
  if (!agentReady()) return toast('Claude Code is not available', 'info', 'Install Claude Code, or set the path to it in Settings → Agent.');
  if (s.agent.busy) {
    toggleAgent(true);
    return toast('The agent is busy with another request', 'info', 'Wait for it to finish, or stop it in the chat.');
  }
  const info = p.app ? null : (p.repo ? s.repos.find((r) => r.live && r.path === p.repo) : liveInfo()) ?? null;
  const repo = p.app ? undefined : info?.path ?? p.repo;
  const branch = info ? s.repoStates[info.id]?.refs.find((r) => r.kind === 'branch' && r.current)?.name : undefined;
  const output = (p.detail ?? '').trim();
  const lines = output ? output.split('\n') : [];
  // the chat shows the start of the output; the agent gets all of it (the start and the end of a long one)
  const more = lines.length > SHOWN_LINES ? `\n… ${lines.length - SHOWN_LINES} more lines` : '';
  const shown = lines.slice(0, SHOWN_LINES).join('\n').replace(/`{3,}/g, '´´´');
  const where = [info ? `\`${info.name}\`` : repo ? `\`${repo}\`` : '', branch ? `ветка \`${branch}\`` : ''].filter(Boolean).join(' · ');
  const ask = [
    p.app ? 'Prong сломался — найди причину в исходниках и исправь.' : 'Разберись с ошибкой и исправь, если это безопасно.',
    `**${p.title}**${where ? `\n${where}` : ''}`,
    shown ? `${FENCE}text\n${shown}${more}\n${FENCE}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const facts = [repo && `Репозиторий: ${repo}${branch ? `, текущая ветка ${branch}` : ''}.`, p.context, more && `Полный вывод:\n${FENCE}\n${clip(output)}\n${FENCE}`].filter(Boolean).join('\n\n');
  const rules = p.app
    ? 'Исправь код так, чтобы это не повторялось, и проверь сборку (npx tsc --noEmit).'
    : 'Сначала выясни причину (git status, git config, git log, git ls-remote и т.п.). Исправь сам, если это безопасно: без потери коммитов и локальных изменений, без force-push и переписывания опубликованной истории. Если исправление рискованное или нужно моё решение — ничего не меняй, а предложи команды.';
  const answer = `Ответ: первой строкой жирным — итог; затем «### Причина» и «### Что сделано» короткими пунктами; если от меня что-то нужно — «### Что сделать вам» с командами в блоке ${FENCE}sh.`;
  toggleAgent(true);
  pushAgentMessage({ role: 'user', text: ask, target: p.app ? 'app' : 'repo' });
  void startAgentRun(ask, p.app ? 'app' : 'repo', false, `\n\n${[facts, rules, answer].filter(Boolean).join('\n\n')}`, repo);
}

/** Stops the running agent (the engine kills Claude Code and the tools it started). */
export async function agentStop() {
  if (!agentOp) return;
  updateAgent({ status: 'Stopping…' });
  await client.cancelOp(agentOp.opId).catch(() => {});
}

/** Called from the SSE handler for events that belong to the running agent op. Returns true when consumed. */
export function handleAgentEvent(e: OpEvent): boolean {
  if (!agentOp || e.opId !== agentOp.opId) return false;
  const { msgId, mode, prompt, cwd, retargetable, before } = agentOp;
  if (e.line) {
    const i = e.line.indexOf(':');
    const kind = e.line.slice(0, i);
    const payload = e.line.slice(i + 1);
    const status = statusFromEvent(kind, payload);
    if (status) updateAgent({ status });
    if (kind === 'text') patchAgentMessage(msgId, (m) => ({ ...m, text: m.text ? `${m.text}\n${payload}` : payload }));
    else if (kind === 'tool') patchAgentMessage(msgId, (m) => ({ ...m, actions: [...(m.actions ?? []), payload].slice(-30) }));
    else if (kind === 'status') patchAgentMessage(msgId, (m) => ({ ...m, actions: [...(m.actions ?? []), `· ${payload}`] }));
    else if (kind === 'result') {
      try {
        const r = JSON.parse(payload) as { text: string; costUsd?: number; sessionId?: string };
        patchAgentMessage(msgId, (m) => ({ ...m, text: r.text || m.text, actions: [...(m.actions ?? []), r.costUsd !== undefined ? `cost $${r.costUsd.toFixed(3)}` : 'done'] }));
        if (r.sessionId) updateAgent({ session: { id: r.sessionId, mode, cwd } });
      } catch {
        /* ignore */
      }
    }
  }
  if (e.done) {
    agentOp = null;
    setState({ operation: null });
    // the agent recognised a request for the other target: run it there (once, AUTO mode only)
    // the agent may answer with a target marker instead of doing the work
    const marker = !e.error ? (RETARGET_MARKER.exec(getState().agent.messages.find((m) => m.id === msgId)?.text ?? '')?.[1] as 'repo' | 'app' | undefined) : undefined;
    if (marker && retargetable) {
      if (marker === mode) {
        // it named the target it is already in: ask once more, plainly
        patchAgentMessage(msgId, (m) => ({ ...m, text: 'Агент сослался на текущую цель, повторяю запрос…' }));
        updateAgent({ status: 'Asking again…' });
        void startAgentRun(prompt, mode, false, mode === 'app' ? "\n\n(You are already working in Prong's own sources: make this change here.)" : "\n\n(This is the user's repository: do this here.)");
      } else {
        patchAgentMessage(msgId, (m) => ({ ...m, text: marker === 'app' ? 'Это задача про интерфейс Prong, запускаю в исходниках приложения…' : 'Это задача про репозиторий, запускаю в его рабочей папке…', target: marker }));
        updateAgent({ status: marker === 'app' ? 'Switching to the app sources…' : 'Switching to the repository…' });
        void startAgentRun(prompt, marker, false);
      }
      return true;
    }
    if (marker) {
      // second time, or a target the user pinned: nothing was done, say so instead of reporting success
      patchAgentMessage(msgId, (m) => ({ ...m, text: marker === mode ? 'Агент не выполнил запрос.' : `Агент считает, что это задача для цели «${marker}». Переключите цель и повторите.` }));
      finishAgentRun(msgId, { ok: false, error: 'The agent did not act' });
      return true;
    }
    if (e.error) {
      patchAgentMessage(msgId, (m) => ({ ...m, text: (m.text ? m.text + '\n' : '') + `⚠ ${e.error}` }));
      finishAgentRun(msgId, { ok: false, error: e.error });
    } else if (mode === 'app') void applyAppChange(msgId, prompt, cwd, before ?? {});
    else {
      const id = liveId();
      if (id) void refresh(id).catch(() => {});
      finishAgentRun(msgId, { ok: true });
    }
  }
  return true;
}

/**
 * After an app-mode run: the agent's edits become a version (a commit in the sources' log), then the desktop
 * app rebuilds its interface and every window reloads into it. Behind a dev server Metro reloads by itself.
 */
async function applyAppChange(msgId: number, prompt: string, cwd: string, before: Record<string, string>) {
  updateAgent({ status: 'Recording the version…' });
  let v: { sha: string; files: string[] } | null;
  try {
    v = await client.appRecord(cwd, prompt, before);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    patchAgentMessage(msgId, (m) => ({ ...m, actions: [...(m.actions ?? []), `⚠ version not recorded: ${msg}`] }));
    finishAgentRun(msgId, { ok: false, error: `Could not record the version: ${msg}` });
    return;
  }
  if (!v) {
    patchAgentMessage(msgId, (m) => ({ ...m, actions: [...(m.actions ?? []), 'no source changes'] }));
    finishAgentRun(msgId, { ok: true, noChanges: true });
    return;
  }
  await loadAppVersions();
  const version = getState().agent.versions.find((x) => x.sha === v!.sha);
  patchAgentMessage(msgId, (m) => ({ ...m, versionId: version?.id, actions: [...(m.actions ?? []), `version v${version?.n ?? '?'} · ${v!.files.join(', ')}`] }));
  if (getState().engine.ui !== 'static') {
    finishAgentRun(msgId, { ok: true });
    return;
  }
  await startRebuild(msgId, v.sha, cwd);
}

async function startRebuild(msgId: number | null, versionSha: string | null, cwd: string) {
  updateAgent((a) => (msgId ? { status: 'Rebuilding the interface…' } : a));
  const op = await client.appRebuild(cwd).catch((e) => ({ opId: null as string | null, skipped: undefined as string | undefined, error: String(e?.message ?? e) }));
  if (!op.opId) {
    const error = 'error' in op ? op.error : undefined;
    if (msgId) finishAgentRun(msgId, error ? { ok: false, error: `Interface build failed: ${error}` } : { ok: true });
    else if (error) toast('Interface build failed', 'error', error);
    return;
  }
  rebuildOp = { opId: op.opId, msgId, versionSha, cwd };
  if (!msgId) setState({ operation: { label: 'Rebuilding the interface', progress: 0, log: [] } });
}

/** Rebuilds the interface from the current sources (after reverting or re-applying versions). */
export async function rebuildInterface() {
  const src = getState().agent.settings.sourcesPath;
  if (!src || !engineOnline() || getState().engine.ui !== 'static') return;
  await startRebuild(null, null, src);
}

/** Progress and failure of the rebuild; success comes as `ui-updated`. */
function onRebuildEvent(e: OpEvent) {
  const ro = rebuildOp!;
  if (!e.done) return;
  rebuildOp = null;
  setState({ operation: null });
  if (!e.error) return;
  void (async () => {
    let text = `⚠ Interface build failed: ${e.error}`;
    // a change that does not build is taken back so the next build works again
    if (getState().agent.settings.autoRollbackOnBuildError && ro.versionSha) {
      const back = await client.appRevert(ro.cwd, ro.versionSha).catch(() => null);
      await loadAppVersions();
      if (back) text += ' · the change was rolled back';
    }
    if (ro.msgId) {
      patchAgentMessage(ro.msgId, (m) => ({ ...m, actions: [...(m.actions ?? []), text] }));
      finishAgentRun(ro.msgId, { ok: false, error: 'Interface build failed' });
    } else toast('Interface build failed', 'error', String(e.error));
  })();
}

/** The engine serves a new interface build: finish the run that caused it, keep the session, reload. */
function onUiUpdated() {
  if (rebuildOp?.msgId) finishAgentRun(rebuildOp.msgId, { ok: true });
  rebuildOp = null;
  persistSession();
  if (Platform.OS === 'web' && typeof location !== 'undefined') setTimeout(() => location.reload(), 150);
}

/** Agent versions come from the sources' log in the engine (they survive reloads and restarts). */
export async function loadAppVersions() {
  const src = getState().agent.settings.sourcesPath;
  if (!src || !engineOnline()) return;
  const list = await client.appVersions(src).catch(() => null);
  if (!list) return;
  updateAgent({
    versions: list.map((v) => ({
      id: parseInt(v.sha.slice(0, 10), 16),
      n: v.n,
      title: v.title,
      prompt: v.prompt,
      time: v.time,
      files: v.files.map((f) => f.path),
      diff: v.files.map((f) => `${f.status} ${f.path}  +${f.additions} −${f.deletions}`).join('\n'),
      patch: {},
      status: v.status,
      build: 'ok',
      sha: v.sha,
      revertSha: v.revertSha,
      sourcesPath: src,
    })),
  });
}

/** Revert = git revert of the version, re-apply = revert of that revert; then the interface is rebuilt. */
export async function setRealVersionStatus(v: AppVersion, status: AppVersion['status'], rebuild = true): Promise<boolean> {
  if (!v.sha || !v.sourcesPath) return false;
  const target = status === 'reverted' ? v.sha : v.revertSha;
  if (!target) return false;
  const r = await guard(status === 'reverted' ? 'Revert version' : 'Re-apply version', () => client.appRevert(v.sourcesPath!, target));
  if (!r) return false;
  await loadAppVersions();
  if (rebuild) await rebuildInterface();
  return true;
}

// ---------- session: across interface reloads and across launches ----------

const SESSION_KEY = 'prong.session';
/** the agent chat comes back only right after an interface reload */
const SESSION_FRESH_MS = 60_000;
/** tabs and branch filters of the last launch, from the engine (`session.json`) */
let savedSession: SavedSession | null = null;

/** Before an interface reload: the agent chat (local) and the durable session (engine), at once. */
export function persistSession() {
  try {
    const s = getState();
    const data = {
      at: Date.now(),
      agent: { messages: s.agent.messages.slice(-200), notices: s.agent.notices, target: s.agent.target, open: s.agent.open, session: s.agent.session },
    };
    if (typeof localStorage !== 'undefined') localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable */
  }
  void saveSessionNow();
}
function readSession(): any | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SESSION_KEY) : null;
    const data = raw ? JSON.parse(raw) : null;
    return data && Date.now() - data.at < SESSION_FRESH_MS ? data : null;
  } catch {
    return null;
  }
}
/** At startup, before the engine answers: the agent chat and its notices come back right away. */
export function restoreAgentSession() {
  const data = readSession();
  if (!data?.agent) return;
  const messages: AgentMessage[] = data.agent.messages ?? [];
  agentMsgId = Math.max(agentMsgId, ...messages.map((m) => m.id - 100000).filter((n) => n > 0));
  updateAgent({ messages, notices: data.agent.notices ?? [], target: data.agent.target ?? 'auto', open: !!data.agent.open, session: data.agent.session ?? null });
}
let tabsRestored = false;
/**
 * Once the repositories are known: the workspace, its tabs (and those of the other workspaces) and the active
 * repository come back as they were at the last launch. Tabs of repositories that are gone are dropped; the other
 * tabs load when first shown, each with its saved branch filter.
 */
export async function restoreTabs() {
  if (tabsRestored) return;
  tabsRestored = true;
  if (typeof localStorage !== 'undefined') localStorage.removeItem(SESSION_KEY);
  const data = savedSession;
  if (!data) return;
  const known = new Set(getState().repos.map((r) => r.id));
  const keep = (ids?: string[]) => (ids ?? []).filter((id) => known.has(id));
  const tabs = keep(data.tabs);
  const workspaceTabs: Record<string, { tabs: string[]; activeTab: string | null }> = {};
  for (const [ws, t] of Object.entries(data.workspaceTabs ?? {})) {
    const list = keep(t.tabs);
    workspaceTabs[ws] = { tabs: list, activeTab: t.activeTab && list.includes(t.activeTab) ? t.activeTab : list[0] ?? null };
  }
  setState((s) => {
    const ws = data.activeWorkspace && s.workspaces.some((w) => w.id === data.activeWorkspace) ? data.activeWorkspace : s.activeWorkspace;
    delete workspaceTabs[ws];
    return { activeWorkspace: ws, workspaceTabs, tabs, activeTab: data.activeTab && tabs.includes(data.activeTab) ? data.activeTab : null };
  });
  if (data.screen === 'repo' && data.activeTab && tabs.includes(data.activeTab)) await openLive(data.activeTab);
}

/**
 * A saved filter meets the repository as it is now: branches deleted since are dropped (git would refuse them),
 * and a filter left with nothing shows everything again. Then the filtered history is read.
 */
async function reapplySavedFilter(id: string) {
  const r = repoState(id);
  if (!r) return;
  const f = r.graphFilter;
  if (f.mode === 'selected') {
    const names = new Set(r.refs.map((x) => x.name));
    const refs = f.refs.filter((n) => names.has(n));
    if (refs.length !== f.refs.length) updateRepo({ graphFilter: refs.length ? { ...f, refs } : { ...f, mode: 'all', refs: [] } }, id);
  }
  if (filterRevs(repoState(id)!.graphFilter)) await applyGraphFilter(id);
}

/** what goes into session.json now */
export function sessionOf(s = getState()): SavedSession {
  const filters = { ...(savedSession?.filters ?? {}) };
  for (const [id, r] of Object.entries(s.repoStates)) {
    if (!r.live) continue;
    const f = r.graphFilter;
    if (f.mode === 'all' && !f.hideRemotes) delete filters[id];
    else filters[id] = { mode: f.mode, refs: f.refs, hideRemotes: f.hideRemotes };
  }
  return { activeWorkspace: s.activeWorkspace, screen: s.screen === 'repo' ? 'repo' : 'welcome', tabs: s.tabs, activeTab: s.activeTab, workspaceTabs: s.workspaceTabs, filters };
}
let sessionTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSig = '';
let sessionWatch: (() => void) | null = null;
async function saveSessionNow() {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = null;
  if (!savedSession || !engineOnline()) return;
  const data = sessionOf();
  const sig = JSON.stringify(data);
  if (sig === sessionSig) return;
  sessionSig = sig;
  savedSession = data;
  await client.saveSession(data).catch(() => {});
}
/** after the restore: every change of tabs, workspace or a branch filter is saved half a second later */
function startSessionSaving() {
  if (sessionWatch) return;
  sessionSig = JSON.stringify(sessionOf());
  let last: unknown[] = [];
  sessionWatch = subscribe(() => {
    const s = getState();
    // cheap check first: the same objects mean nothing that is saved has changed
    const now = [s.activeWorkspace, s.screen, s.tabs, s.activeTab, s.workspaceTabs, ...Object.values(s.repoStates).map((r) => r.graphFilter)];
    if (now.length === last.length && now.every((v, i) => v === last[i])) return;
    last = now;
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => void saveSessionNow(), 500);
  });
}
export const startSessionSavingForTest = () => startSessionSaving();
/** tests: forget what the last launch saved */
export function resetSessionForTest(s: SavedSession | null = null) {
  savedSession = s;
  tabsRestored = false;
  sessionWatch?.();
  sessionWatch = null;
  sessionSig = '';
}

export function workspaceOfPath(p: string) {
  return getState().repos.find((r) => r.path === p)?.workspace;
}

export function asCommits(list: Commit[]) {
  return list;
}
