import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit, FileChange } from '../git/types';
import { checkout, client, ensureCommitFiles, refresh, REVEAL_MAX, revealCommit, selectFile } from './live';
import { EMPTY_REPO, getState, setState } from './store';

/** big repositories: a branch click deep in history, refresh after it, commits with very many files */
const ID = 'live:/r';
const sha = (i: number) => i.toString(16).padStart(40, '0');
const c = (i: number): Commit => ({ sha: sha(i), parents: [sha(i + 1)], subject: `c${i}`, body: '', author: 'a', email: 'a@x', date: 0 });
const page = (from: number, n: number) => Array.from({ length: n }, (_, k) => c(from + k));
const repo = () => getState().repoStates[ID];
const refs = [{ name: 'main', kind: 'branch' as const, sha: sha(0), current: true }];

describe('live: deep history', () => {
  beforeEach(() => {
    setState({
      engine: { online: true, git: 'git', version: '1' },
      repos: [{ id: ID, name: 'r', workspace: 'work', path: '/r', currentBranch: 'main', changes: 0, lastOpened: 0, live: true }],
      tabs: [ID],
      activeTab: ID,
      repoStates: { [ID]: { ...EMPTY_REPO, id: ID, path: '/r', live: true, head: sha(0), refs, commits: page(0, 300), graphFilter: { mode: 'all', refs: [], hideRemotes: false } } },
      toasts: [],
    });
    vi.spyOn(client, 'commitFiles').mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  /** the engine's answer: commits from `skip` down to the target and 200 past it */
  const until = (target: number) => vi.spyOn(client, 'logUntil').mockImplementation(async (_p, _sha, skip, after) => ({ index: target, commits: page(skip, target - skip + 1 + after) }));

  it('a branch 8000 commits deep: one streamed read, selected and scrolled to', async () => {
    const u = until(8000);
    const lp = vi.spyOn(client, 'logPage');
    await revealCommit(sha(8000));
    expect(u).toHaveBeenCalledTimes(1);
    expect(u).toHaveBeenCalledWith('/r', sha(8000), 300, 200, undefined, REVEAL_MAX);
    expect(lp).not.toHaveBeenCalled();
    expect(repo().commits).toHaveLength(8201);
    expect(repo().selectedCommit).toBe(sha(8000));
    expect(repo().reveal?.sha).toBe(sha(8000));
    expect(repo().loadingMore).toBe(false);
  });

  it('a commit already listed is selected without asking the engine', async () => {
    const u = vi.spyOn(client, 'logUntil');
    await revealCommit(sha(42));
    expect(u).not.toHaveBeenCalled();
    expect(repo().reveal?.sha).toBe(sha(42));
  });

  it('beyond the reach: a notice, nothing read, the list stays as it was', async () => {
    vi.spyOn(client, 'logUntil').mockResolvedValue({ index: -1, commits: [] });
    await revealCommit(sha(150000));
    expect(repo().commits).toHaveLength(300);
    expect(repo().loadingMore).toBe(false);
    expect(getState().toasts.at(-1)?.text).toBe('Too deep in the history');
  });

  it('under a branch filter the position is looked up in the filtered log', async () => {
    setState({ repoStates: { [ID]: { ...repo(), graphFilter: { mode: 'selected', refs: ['main'], hideRemotes: false }, filteredCommits: page(0, 300) } } });
    const u = vi.spyOn(client, 'logUntil').mockResolvedValue({ index: -1, commits: [] });
    await revealCommit(sha(9000));
    expect(u).toHaveBeenCalledWith('/r', sha(9000), 300, 200, ['main'], REVEAL_MAX);
    expect(getState().toasts.at(-1)?.text).toBe('Hidden by the branch filter');
  });

  it('refresh keeps the history read beyond the first page while the refs stay', async () => {
    until(5000);
    await revealCommit(sha(5000));
    const n = repo().commits.length;
    vi.spyOn(client, 'snapshot').mockResolvedValue({ commits: page(0, 300), refs, remotes: [], stashes: [], unstaged: [], staged: [], head: sha(0), op: { kind: null } } as any);
    await refresh(ID);
    expect(repo().commits).toHaveLength(n);
    expect(repo().selectedCommit).toBe(sha(5000));
  });

  it('refresh re-reads the same depth in one call when the refs moved', async () => {
    until(5000);
    const lp = vi.spyOn(client, 'logPage').mockImplementation(async (_p, skip, limit) => page(skip, limit));
    await revealCommit(sha(5000));
    const n = repo().commits.length;
    const moved = [{ ...refs[0], sha: sha(1) }];
    vi.spyOn(client, 'snapshot').mockResolvedValue({ commits: page(1, 300), refs: moved, remotes: [], stashes: [], unstaged: [], staged: [], head: sha(1), op: { kind: null } } as any);
    lp.mockClear();
    await refresh(ID);
    expect(lp).toHaveBeenCalledWith('/r', 0, n);
    expect(repo().commits).toHaveLength(n);
    expect(repo().selectedCommit).toBe(sha(5000));
  });

  it('a failed operation shows its error in full and no success message', async () => {
    setState({ errors: [], errorOpen: null, toasts: [] });
    vi.spyOn(client, 'checkout').mockRejectedValue(new Error('git checkout old failed (1): error: Your local changes to the following files would be overwritten by checkout:\n\timg/pixel.png\nAborting'));
    vi.spyOn(client, 'snapshot').mockResolvedValue({ commits: page(0, 300), refs, remotes: [], stashes: [], unstaged: [], staged: [], head: sha(0), op: { kind: null } } as any);
    checkout('old');
    await vi.waitFor(() => expect(getState().errors).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(getState().errors[0].title).toBe('Checkout old failed');
    expect(getState().errors[0].detail).toContain('img/pixel.png');
    expect(getState().errorOpen).toBe(getState().errors[0].id);
    expect(getState().toasts.map((t) => t.text)).not.toContain('Checked out old');
  });

  it('a commit with very many files comes as a list; the selected file loads its diff on its own', async () => {
    const files: FileChange[] = Array.from({ length: 500 }, (_, i) => ({ path: `dir/f${i}.txt`, status: 'M', kind: 'text', additions: 0, deletions: 0, lazy: true }));
    vi.spyOn(client, 'commitFiles').mockResolvedValue(files);
    const one = vi.spyOn(client, 'commitFileDiff').mockImplementation(async (_p, _rev, file) => ({ path: file, status: 'M', kind: 'text', additions: 1, deletions: 0, hunks: [{ id: 'h', header: '@@', lines: [{ kind: 'add', newNo: 1, text: 'x' }] }] }));
    setState({ repoStates: { [ID]: { ...repo(), selectedCommit: sha(3), selectedArea: 'commit', selectedFile: null } } });
    await ensureCommitFiles(ID, sha(3));
    await vi.waitFor(() => expect(one).toHaveBeenCalledWith('/r', sha(3), 'dir/f0.txt', undefined, false));
    await vi.waitFor(() => expect(repo().commits.find((x) => x.sha === sha(3))?.files?.[0].hunks).toHaveLength(1));
    selectFile('commit', 'dir/f7.txt');
    await vi.waitFor(() => expect(one).toHaveBeenCalledWith('/r', sha(3), 'dir/f7.txt', undefined, false));
    const f7 = repo().commits.find((x) => x.sha === sha(3))?.files?.find((f) => f.path === 'dir/f7.txt');
    await vi.waitFor(() => expect(repo().commits.find((x) => x.sha === sha(3))?.files?.find((f) => f.path === 'dir/f7.txt')?.lazy).toBe(false));
    expect(f7).toBeDefined();
    expect(one).toHaveBeenCalledTimes(2); // the other 498 stay lists
  });
});
