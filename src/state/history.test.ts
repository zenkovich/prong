import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit, FileChange } from '../git/types';
import { client, createTag, expandContext, openLive, rebase, refresh, revealCommit, searchCommits, searchCommitsSoon, selectCommit, selectFile, showFileHistory } from './live';
import { EMPTY_REPO, getState, setMergeCollapsed, setState } from './store';
import { coversWholeFile } from '../git/diffContext';
import { refNameProblem } from '../components/refName';

/** the history view's logic: loading, paging, search, file history, blame, merges, tags, rebase onto a commit */
const ID = 'live:/r';
const sha = (i: number) => i.toString(16).padStart(40, '0');
const c = (i: number, extra: Partial<Commit> = {}): Commit => ({ sha: sha(i), parents: [sha(i + 1)], subject: `c${i}`, body: '', author: 'a', email: 'a@x', date: 0, ...extra });
const page = (from: number, n: number) => Array.from({ length: n }, (_, k) => c(from + k));
const repo = () => getState().repoStates[ID];
const refs = [{ name: 'main', kind: 'branch' as const, sha: sha(0), current: true }];
const snap = (commits: Commit[]) => ({ commits, refs, remotes: [{ name: 'origin', url: '/o' }], stashes: [], unstaged: [], staged: [], head: sha(0), op: { kind: 'none' as const }, shallow: false });
const text = (path: string, lines: FileChange['hunks']): FileChange => ({ path, status: 'M', kind: 'text', additions: 1, deletions: 1, hunks: lines });

describe('history: state', () => {
  beforeEach(() => {
    setState({
      engine: { online: true, git: 'git', version: '1' },
      repos: [{ id: ID, name: 'r', workspace: 'work', path: '/r', currentBranch: 'main', changes: 0, lastOpened: 0, live: true }],
      tabs: [ID],
      activeTab: ID,
      repoStates: { [ID]: { ...EMPTY_REPO, id: ID, path: '/r', live: true, head: sha(0), refs, remotes: [{ name: 'origin', url: '/o' }], commits: page(0, 300) } },
      toasts: [],
    });
    vi.spyOn(client, 'commitFiles').mockResolvedValue([]);
    vi.spyOn(client, 'submodules').mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('← on a plain commit folds nothing; on a merge it folds, → unfolds', () => {
    const merge = c(5, { parents: [sha(6), sha(400)] });
    setState({ repoStates: { [ID]: { ...repo(), commits: [c(4), merge, ...page(6, 10)] } } });
    setMergeCollapsed(sha(4), true);
    expect(repo().collapsedMerges).toEqual({});
    setMergeCollapsed(sha(5), true);
    expect(repo().collapsedMerges).toEqual({ [sha(5)]: true });
    setMergeCollapsed(sha(5), false);
    expect(repo().collapsedMerges).toEqual({});
  });

  it('a read that fails leaves the repository "not loading" (the list would say loading for ever)', async () => {
    setState({ repoStates: {} });
    vi.spyOn(client, 'snapshotCached').mockResolvedValue(null);
    vi.spyOn(client, 'snapshot').mockRejectedValue(new Error('not a git repository'));
    await openLive(ID);
    expect(repo().loading).toBe(false);
    expect(getState().toasts.at(-1)?.text).toBe('Open repository failed');
  });

  it('whether more history is unread follows each read: a short log has no more, a "no more" from before goes after a pull', async () => {
    vi.spyOn(client, 'snapshot').mockResolvedValueOnce(snap(page(0, 12))).mockResolvedValueOnce(snap(page(0, 300)));
    setState({ repoStates: { [ID]: { ...repo(), commits: page(0, 12) } } });
    await refresh(ID);
    expect(repo().logExhausted).toBe(true);
    await refresh(ID);
    expect(repo().logExhausted).toBe(false);
  });

  it('a file history is "loading" until it comes; a failed one goes back to the history', async () => {
    let answer!: (v: Commit[]) => void;
    vi.spyOn(client, 'logFile').mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const p = showFileHistory('a.txt');
    expect(repo().historyPath).toBe('a.txt');
    expect(repo().historyCommits).toBeUndefined();
    answer([c(3, { fileName: 'a.txt' })]);
    await p;
    expect(repo().historyCommits).toHaveLength(1);
    vi.spyOn(client, 'logFile').mockRejectedValueOnce(new Error('bad path'));
    await showFileHistory('b.txt');
    expect(repo().historyPath).toBeNull();
  });

  it('in a file history each commit shows that file, under the name it had there', async () => {
    const files = [text('README.md', []), text('old/name.txt', [])];
    setState({ repoStates: { [ID]: { ...repo(), historyPath: 'new/name.txt', historyCommits: [c(1, { fileName: 'new/name.txt' }), c(7, { fileName: 'old/name.txt', files })] } } });
    selectCommit(sha(7));
    expect(repo().selectedFile).toBe('old/name.txt');
    // files that come after the click
    vi.spyOn(client, 'commitFiles').mockResolvedValue([text('README.md', []), text('new/name.txt', [])]);
    selectCommit(sha(1));
    await vi.waitFor(() => expect(repo().selectedFile).toBe('new/name.txt'));
  });

  it('another commit or file picked closes the blame', () => {
    setState({ repoStates: { [ID]: { ...repo(), blame: { path: 'a', lines: [] } } } });
    selectCommit(sha(2));
    expect(repo().blame).toBeNull();
    setState({ repoStates: { [ID]: { ...repo(), blame: { path: 'a', lines: [] } } } });
    selectFile('commit', 'b');
    expect(repo().blame).toBeNull();
  });

  it('the search asks the engine once the typing stops, within the branch filter; a stale answer is dropped', async () => {
    vi.useFakeTimers();
    const search = vi.spyOn(client, 'searchLog').mockImplementation(async (_p, q) => ({ commits: [c(900, { subject: `found ${q}` })], scanned: 1000, more: false }));
    setState({ repoStates: { [ID]: { ...repo(), search: 'fo', graphFilter: { mode: 'selected', refs: ['main'], hideRemotes: false } } } });
    searchCommitsSoon(ID);
    setState({ repoStates: { [ID]: { ...repo(), search: 'found' } } });
    searchCommitsSoon(ID);
    expect(repo().searchResults).toEqual({ q: 'found', commits: null, more: false });
    await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('/r', 'found', ['main'], 300);
    expect(repo().searchResults?.commits?.map((x) => x.subject)).toEqual(['found found']);
    // typed on meanwhile: the answer for the old text is not shown
    setState({ repoStates: { [ID]: { ...repo(), search: 'other' } } });
    const p = searchCommits(ID);
    setState({ repoStates: { [ID]: { ...repo(), search: 'other2' } } });
    await p;
    expect(repo().searchResults?.q).toBe('found');
  });

  it('a commit picked among the search results stays selected when the search is cleared, read down to when deep', async () => {
    setState({ repoStates: { [ID]: { ...repo(), search: 'x', searchResults: { q: 'x', commits: [c(900)], more: false }, selectedCommit: sha(900), selectedArea: 'commit' } } });
    const u = vi.spyOn(client, 'logUntil').mockImplementation(async (_p, _sha, skip) => ({ index: 900, commits: page(skip, 900 - skip + 201) }));
    setState({ repoStates: { [ID]: { ...repo(), search: '' } } });
    searchCommitsSoon(ID);
    await vi.waitFor(() => expect(repo().searchResults).toBeNull());
    expect(u).toHaveBeenCalledTimes(1);
    expect(repo().selectedCommit).toBe(sha(900));
    expect(repo().reveal?.sha).toBe(sha(900));
  });

  it('revealing a commit the search hides clears the search', async () => {
    setState({ repoStates: { [ID]: { ...repo(), search: 'zzz', searchResults: { q: 'zzz', commits: [], more: false } } } });
    await revealCommit(sha(10));
    expect(repo().search).toBe('');
    expect(repo().selectedCommit).toBe(sha(10));
  });

  it('a tag keeps the message typed, and "push" sends that tag alone to the remote', async () => {
    const create = vi.spyOn(client, 'createTag').mockResolvedValue();
    const pushTag = vi.spyOn(client, 'pushTag').mockResolvedValue({ opId: 'p1' });
    const push = vi.spyOn(client, 'push');
    vi.spyOn(client, 'snapshot').mockResolvedValue(snap(page(0, 300)));
    createTag('v2', sha(3), true, true, 'Release notes', 'origin');
    await vi.waitFor(() => expect(pushTag).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith('/r', 'v2', sha(3), 'Release notes');
    expect(pushTag).toHaveBeenCalledWith('/r', 'v2', 'origin');
    expect(push).not.toHaveBeenCalled();
    createTag('v3', sha(3), true, false, '   ');
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith('/r', 'v3', sha(3), 'v3'));
  });

  it('a rebase onto a commit goes onto its id, named short', async () => {
    const rb = vi.spyOn(client, 'rebase').mockResolvedValue({ conflicts: false });
    vi.spyOn(client, 'snapshot').mockResolvedValue(snap(page(0, 300)));
    rebase(sha(42));
    await vi.waitFor(() => expect(getState().toasts.some((t) => t.text === `Rebased onto ${sha(42).slice(0, 7)}`)).toBe(true));
    expect(rb).toHaveBeenCalledWith('/r', sha(42), { autostash: true });
  });

  it('Expand context reads the file again with ten more lines around each change; once nothing new comes, it stops', async () => {
    const h = (from: number, n: number) => [{ id: 'h', header: '@@', lines: Array.from({ length: n }, (_, k) => ({ kind: 'ctx' as const, oldNo: from + k, newNo: from + k, text: `l${from + k}` })) }];
    setState({ repoStates: { [ID]: { ...repo(), selectedCommit: sha(1), selectedArea: 'commit', commits: [c(1, { files: [text('f.txt', h(10, 7))] })] } } });
    const d = vi.spyOn(client, 'commitFileDiff').mockResolvedValueOnce(text('f.txt', h(1, 27))).mockResolvedValueOnce(text('f.txt', h(1, 27)));
    await expandContext('f.txt');
    expect(d).toHaveBeenCalledWith('/r', sha(1), 'f.txt', undefined, false, 13);
    let f = repo().commits[0].files![0];
    expect([f.context, f.contextAll, f.hunks![0].lines.length]).toEqual([13, false, 27]);
    await expandContext('f.txt');
    expect(d).toHaveBeenLastCalledWith('/r', sha(1), 'f.txt', undefined, false, 23);
    f = repo().commits[0].files![0];
    expect([f.context, f.contextAll]).toEqual([23, true]);
  });
});

describe('history: pure helpers', () => {
  const lines = (spec: string, startOld = 1) => {
    let o = startOld;
    let n = startOld;
    return spec.split('').map((k) => (k === '+' ? { kind: 'add' as const, newNo: n++, text: '' } : k === '-' ? { kind: 'del' as const, oldNo: o++, text: '' } : { kind: 'ctx' as const, oldNo: o++, newNo: n++, text: '' }));
  };
  const file = (...hunks: ReturnType<typeof lines>[]): FileChange => ({ path: 'f', status: 'M', kind: 'text', additions: 0, deletions: 0, hunks: hunks.map((l, i) => ({ id: `h${i}`, header: '@@', lines: l })) });

  it('coversWholeFile: one hunk from the top that ends before the context asked for', () => {
    expect(coversWholeFile(file(lines('..-+.')), 3)).toBe(true);
    expect(coversWholeFile(file(lines('...-+...')), 3)).toBe(false);
    expect(coversWholeFile(file(lines('...-+.', 4)), 3)).toBe(false);
    expect(coversWholeFile(file(lines('.-'), lines('+.')), 3)).toBe(false);
    expect(coversWholeFile(file(), 3)).toBe(true);
    expect(coversWholeFile(file(lines('+++')), 3)).toBe(true);
  });

  it('refNameProblem: what git refuses as a branch or tag name', () => {
    for (const ok of ['v1.0', 'feature/login', 'release-2026.10', 'ünïcode', 'a@b']) expect(refNameProblem(ok)).toBeNull();
    for (const bad of ['bad tag', 'a..b', '-x', 'x/', '/x', 'a//b', 'x.lock', '.hidden', 'x.', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', '@', 'a@{1}', 'tab\there']) expect(refNameProblem(bad)).not.toBeNull();
    expect(refNameProblem('')).toBeNull();
  });
});
