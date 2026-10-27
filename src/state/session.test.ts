import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit, SavedSession } from '../git/types';
import { client, openLive, resetSessionForTest, restoreTabs, sessionOf } from './live';
import { getState, setState, toggleBranchFilter, toggleGroup, updateRepo } from './store';

/** tabs and branch filters come back on the next launch */
const info = (path: string, workspace = 'work') => ({ id: `live:${path}`, name: path.split('/').pop()!, workspace, workspaces: ['work', 'home'], path, currentBranch: '', changes: 0, lastOpened: 0, live: true });
const c = (sha: string): Commit => ({ sha, parents: [], subject: sha, body: '', author: 'a', email: 'a@x', date: 0 });
const snap = (refs: string[]) => ({ commits: [c('a1')], refs: refs.map((name, i) => ({ name, kind: 'branch', sha: `a${i + 1}`, current: i === 0 })), remotes: [], stashes: [], unstaged: [], staged: [], head: 'a1', op: { kind: null } }) as any;

describe('live: session across launches', () => {
  beforeEach(() => {
    setState({
      engine: { online: true, git: 'git', version: '1' },
      workspaces: [{ id: 'work', name: 'work' }, { id: 'home', name: 'home' }],
      activeWorkspace: 'work',
      repos: [info('/r/a'), info('/r/b'), info('/r/h', 'home')],
      tabs: [],
      activeTab: null,
      workspaceTabs: {},
      repoStates: {},
      screen: 'welcome',
      toasts: [],
      errors: [],
      errorOpen: null,
    });
    vi.spyOn(client, 'snapshotCached').mockResolvedValue(null);
    vi.spyOn(client, 'commitFiles').mockResolvedValue([]);
    vi.spyOn(client, 'submodules').mockResolvedValue([]);
    // opening tells the engine when it was opened
    vi.spyOn(client, 'openRepo').mockResolvedValue({} as any);
  });
  afterEach(() => {
    resetSessionForTest(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('restores the workspace, its tabs and the other workspaces’ tabs; repositories that are gone are dropped', async () => {
    vi.spyOn(client, 'snapshot').mockResolvedValue(snap(['main']));
    const saved: SavedSession = { activeWorkspace: 'home', screen: 'repo', tabs: ['live:/r/h', 'live:/gone'], activeTab: 'live:/r/h', workspaceTabs: { work: { tabs: ['live:/r/a', 'live:/r/b', 'live:/gone2'], activeTab: 'live:/gone2' } } };
    resetSessionForTest(saved);
    await restoreTabs();
    const s = getState();
    expect(s.activeWorkspace).toBe('home');
    expect(s.tabs).toEqual(['live:/r/h']);
    expect(s.activeTab).toBe('live:/r/h');
    expect(s.screen).toBe('repo');
    expect(s.repoStates['live:/r/h']).toBeDefined(); // the active one is opened
    expect(s.repoStates['live:/r/a']).toBeUndefined(); // the others load when shown
    expect(s.workspaceTabs.work).toEqual({ tabs: ['live:/r/a', 'live:/r/b'], activeTab: 'live:/r/a' });
  });

  it('a repository the user opened before the session came back stays open and shown, after the saved tabs', async () => {
    vi.spyOn(client, 'snapshot').mockResolvedValue(snap(['main']));
    await openLive('live:/r/b'); // a click on the start screen while the engine was still being asked
    resetSessionForTest({ activeWorkspace: 'work', screen: 'repo', tabs: ['live:/r/a'], activeTab: 'live:/r/a' });
    await restoreTabs();
    const s = getState();
    expect(s.tabs).toEqual(['live:/r/a', 'live:/r/b']);
    expect(s.activeTab).toBe('live:/r/b');
    expect(s.screen).toBe('repo');
    expect(s.repoStates['live:/r/a']).toBeUndefined(); // not opened over the user's choice
  });

  it('a folder that is no repository any more: the tab says so (no endless loading), and a read that works again clears it', async () => {
    const sn = vi.spyOn(client, 'snapshot').mockRejectedValue(new Error('Not a git repository: /r/a'));
    await openLive('live:/r/a');
    let r = getState().repoStates['live:/r/a'];
    expect(r.missing).toBe('/r/a');
    expect(r.loading).toBe(false);
    expect(getState().errors).toEqual([]); // the tab explains it; no error dialog on top
    sn.mockResolvedValue(snap(['main']));
    await openLive('live:/r/a');
    r = getState().repoStates['live:/r/a'];
    expect(r.missing).toBeUndefined();
    expect(r.commits).toHaveLength(1);
  });

  it('a repository with no commit yet names its branch and stays where the user is (its history says there is none)', async () => {
    vi.spyOn(client, 'snapshot').mockResolvedValue({ commits: [], refs: [], remotes: [], stashes: [], unstaged: [{ path: 'a.txt', status: '?', additions: 1, deletions: 0, kind: 'text' }], staged: [], head: '', unborn: 'trunk', op: { kind: 'none' } } as any);
    vi.spyOn(client, 'fileDiff').mockResolvedValue({ path: 'a.txt', status: '?', additions: 1, deletions: 0, kind: 'text', hunks: [] } as any);
    await openLive('live:/r/a');
    const r = getState().repoStates['live:/r/a'];
    expect(r.section).toBe('commits');
    expect(r.selectedCommit).toBeFalsy();
    expect(r.unborn).toBe('trunk');
    expect(getState().repos.find((x) => x.id === 'live:/r/a')?.currentBranch).toBe('trunk');
  });

  it('a repository opens with its saved branch filter; branches deleted since are dropped before git is asked', async () => {
    vi.spyOn(client, 'snapshot').mockResolvedValue(snap(['main', 'feature/x']));
    const lp = vi.spyOn(client, 'logPage').mockResolvedValue([c('a1')]);
    resetSessionForTest({ filters: { 'live:/r/a': { mode: 'selected', refs: ['feature/x', 'deleted/branch'], hideRemotes: false } } });
    await openLive('live:/r/a');
    const r = getState().repoStates['live:/r/a'];
    expect(r.graphFilter).toMatchObject({ mode: 'selected', refs: ['feature/x'] });
    expect(lp).toHaveBeenCalledWith('/r/a', 0, 300, ['feature/x']);
    expect(r.filteredCommits).toHaveLength(1);
  });

  it('a saved filter whose branches are all gone shows everything again, without asking git', async () => {
    vi.spyOn(client, 'snapshot').mockResolvedValue(snap(['main']));
    const lp = vi.spyOn(client, 'logPage');
    resetSessionForTest({ filters: { 'live:/r/a': { mode: 'selected', refs: ['deleted/branch'], hideRemotes: false } } });
    await openLive('live:/r/a');
    expect(getState().repoStates['live:/r/a'].graphFilter.mode).toBe('all');
    expect(lp).not.toHaveBeenCalled();
    expect(getState().errors).toEqual([]);
  });

  it('changes of tabs and filters are saved half a second later, once', async () => {
    vi.spyOn(client, 'snapshot').mockResolvedValue(snap(['main', 'dev']));
    vi.spyOn(client, 'logPage').mockResolvedValue([c('a1')]);
    const save = vi.spyOn(client, 'saveSession').mockResolvedValue({});
    vi.spyOn(client, 'listRepos').mockResolvedValue([]);
    resetSessionForTest({});
    await restoreTabs();
    // bootstrap starts the watcher after the restore; here it is started the same way
    const { startSessionSavingForTest } = await import('./live');
    startSessionSavingForTest();
    vi.useFakeTimers();
    await openLive('live:/r/a');
    toggleBranchFilter('dev');
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    const data = save.mock.calls[0][0] as SavedSession;
    expect(data.tabs).toEqual(['live:/r/a']);
    expect(data.activeTab).toBe('live:/r/a');
    expect(data.filters?.['live:/r/a']).toMatchObject({ mode: 'selected', refs: ['dev'] });
    expect(sessionOf().filters?.['live:/r/a']?.refs).toEqual(['dev']);
  });

  it('the sidebar’s folds come back with the repository; only what differs from the start is saved', async () => {
    vi.spyOn(client, 'snapshot').mockResolvedValue(snap(['main', 'hs/tmp/x']));
    const save = vi.spyOn(client, 'saveSession').mockResolvedValue({});
    vi.spyOn(client, 'listRepos').mockResolvedValue([]);
    resetSessionForTest({ folds: { 'live:/r/a': { remotes: false, 'branch:hs': true } } });
    await openLive('live:/r/a');
    const groups = () => getState().repoStates['live:/r/a'].collapsedGroups;
    // Remotes unfolded and hs folded as left; Tags and Stashes folded as they start
    expect(groups()).toMatchObject({ remotes: false, 'branch:hs': true, tags: true, stashes: true });
    expect(sessionOf().folds?.['live:/r/a']).toEqual({ remotes: false, 'branch:hs': true });
    const { startSessionSavingForTest } = await import('./live');
    startSessionSavingForTest();
    vi.useFakeTimers();
    toggleGroup('tags');
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0][0] as SavedSession).folds?.['live:/r/a']).toEqual({ remotes: false, 'branch:hs': true, tags: false });
    // back to how it starts: nothing saved for it
    toggleGroup('tags');
    toggleGroup('remotes');
    updateRepo((r) => ({ collapsedGroups: { ...r.collapsedGroups, 'branch:hs': false } }));
    const left = sessionOf().folds?.['live:/r/a'];
    expect(left).toEqual({ 'branch:hs': false });
  });
});
