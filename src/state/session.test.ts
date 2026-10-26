import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit, SavedSession } from '../git/types';
import { client, openLive, resetSessionForTest, restoreTabs, sessionOf } from './live';
import { getState, setState, toggleBranchFilter } from './store';

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
});
