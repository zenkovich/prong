import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as live from './live';
import {
  applyUiPrefs,
  clearBranchFilter,
  clearErrors,
  closeErrors,
  closeTab,
  COMMIT_BOX_MIN,
  createWorkspace,
  deleteWorkspace,
  dismissToast,
  findCommit,
  getState,
  inWorkspace,
  moveRepoToWorkspace,
  openRepo,
  removeRepo,
  reportError,
  revealCommit,
  setDiffMode,
  setFileView,
  setLayout,
  setState,
  setTheme,
  setUiScale,
  showErrors,
  sortRepos,
  switchWorkspace,
  toast,
  toggleBranchFilter,
  setCommitMessage,
  toggleAmend,
  toggleCommitDesc,
  toggleDetailsDesc,
  togglePin,
  toggleTheme,
} from './store';
import type { Commit } from '../git/types';

const info = (id: string, workspace = 'work') => ({ id, name: id, workspace, path: `/tmp/${id}`, currentBranch: 'main', changes: 0, lastOpened: 0 });

describe('store: workspaces and tabs', () => {
  beforeEach(() => {
    setState({ workspaces: [{ id: 'work', name: 'work' }, { id: 'home', name: 'home' }], activeWorkspace: 'work', workspaceTabs: {}, tabs: [], activeTab: null, repoStates: {}, repos: [info('a'), info('b'), info('h', 'home')], screen: 'welcome', toasts: [], engine: { online: false, git: '', version: '' } });
  });

  it('keeps a separate tab set per workspace and restores it on switch', () => {
    openRepo('a');
    openRepo('b');
    expect(getState().tabs).toEqual(['a', 'b']);
    expect(getState().screen).toBe('repo');
    switchWorkspace('home');
    expect(getState().activeWorkspace).toBe('home');
    expect(getState().tabs).toEqual([]);
    expect(getState().screen).toBe('welcome');
    openRepo('h');
    expect(getState().tabs).toEqual(['h']);
    switchWorkspace('work');
    expect(getState().tabs).toEqual(['a', 'b']);
    expect(getState().activeTab).toBe('b');
    expect(getState().workspaceTabs.home.tabs).toEqual(['h']);
  });

  it('switches to the repository workspace when a repository from another workspace is opened', () => {
    openRepo('h');
    expect(getState().activeWorkspace).toBe('home');
    expect(getState().activeTab).toBe('h');
  });

  it('creates, deletes and moves repositories between workspaces', () => {
    createWorkspace('  lab  ');
    const lab = getState().workspaces.find((w) => w.name === 'lab')!;
    expect(lab).toBeTruthy();
    expect(getState().activeWorkspace).toBe(lab.id);
    moveRepoToWorkspace('a', lab.id);
    expect(getState().repos.find((r) => r.id === 'a')?.workspace).toBe(lab.id);
    deleteWorkspace(lab.id);
    expect(getState().dialog?.type).toBe('confirm'); // destructive: asks first
    (getState().dialog as any).onConfirm();
    expect(getState().workspaces.some((w) => w.id === lab.id)).toBe(false);
    expect(getState().repos.find((r) => r.id === 'a')?.workspace).not.toBe(lab.id); // repos never vanish with a workspace
    expect(getState().workspaces.map((w) => w.id)).toContain(getState().activeWorkspace);
  });

  it('lists a repository in its own workspace and in every workspace whose scan found it', () => {
    setState({ repos: [{ ...info('s', 'work'), workspaces: ['work', 'home'] }, info('m', 'home')] });
    expect(getState().repos.filter((r) => inWorkspace(r, 'work')).map((r) => r.id)).toEqual(['s']);
    expect(getState().repos.filter((r) => inWorkspace(r, 'home')).map((r) => r.id)).toEqual(['s', 'm']);
    switchWorkspace('home');
    openRepo('s'); // a member of the active workspace: no switch back to its owner
    expect(getState().activeWorkspace).toBe('home');
  });

  it('closing and removing repositories keeps tabs consistent', () => {
    openRepo('a');
    openRepo('b');
    closeTab('b');
    expect(getState().tabs).toEqual(['a']);
    expect(getState().activeTab).toBe('a');
    removeRepo('a');
    expect(getState().tabs).toEqual([]);
    expect(getState().repos.some((r) => r.id === 'a')).toBe(false);
  });
});

describe('store: UI preferences', () => {
  beforeEach(() => {
    vi.spyOn(live, 'persistUi').mockImplementation(() => {});
    setState({ workspaces: [{ id: 'work', name: 'work' }], activeWorkspace: 'work', tabs: [], activeTab: null, repoStates: {}, repos: [info('a'), info('b')], fileView: 'tree', diffMode: 'unified', theme: 'amber', uiScale: 1, layout: { sidebar: 230, details: 0.46, files: 300, commitBox: 170, detailsHeader: 130 }, engine: { online: false, git: '', version: '' } });
  });
  afterEach(() => vi.restoreAllMocks());

  it('opens repositories in tree view by default', () => {
    openRepo('a');
    expect(getState().repoStates.a.fileView).toBe('tree');
  });

  it('remembers list/tree globally: every open repository and new ones follow, and the choice is persisted', () => {
    openRepo('a');
    setFileView('list');
    expect(live.persistUi).toHaveBeenCalledWith({ fileView: 'list' });
    expect(getState().repoStates.a.fileView).toBe('list');
    openRepo('b');
    expect(getState().repoStates.b.fileView).toBe('list');
    setDiffMode('split');
    expect(getState().repoStates.a.diffMode).toBe('split');
    expect(getState().repoStates.b.diffMode).toBe('split');
  });

  it('persists theme and scale changes', () => {
    setTheme('ice');
    expect(getState().theme).toBe('ice');
    expect(live.persistUi).toHaveBeenCalledWith({ theme: 'ice' });
    setUiScale(1.254);
    expect(getState().uiScale).toBe(1.25);
    setUiScale(9);
    expect(getState().uiScale).toBe(2);
  });

  it('applies stored preferences with validation and without writing them back', () => {
    openRepo('a');
    applyUiPrefs({ theme: 'not-a-theme', uiScale: 0.1, fileView: 'list', diffMode: 'split', sidebarWidth: 9999 });
    expect(getState().theme).toBe('amber'); // unknown theme ignored
    expect(getState().uiScale).toBe(0.6); // clamped
    expect(getState().fileView).toBe('list');
    expect(getState().repoStates.a.fileView).toBe('list');
    expect(getState().repoStates.a.diffMode).toBe('split');
    expect(getState().layout.sidebar).toBe(420);
    expect(live.persistUi).not.toHaveBeenCalled();
  });
});

describe('store: repository list order (start page and the + popup)', () => {
  it('pinned first, then the most recently opened; the filter matches name or path', () => {
    const r = (id: string, lastOpened: number, pinned = false) => ({ ...info(id), path: `/w/${id}`, lastOpened, pinned });
    const list = [r('old', 1), r('new', 9), r('pin', 0, true), r('mid', 5)];
    expect(sortRepos(list).map((x) => x.id)).toEqual(['pin', 'new', 'mid', 'old']);
    expect(sortRepos(list, 'NE').map((x) => x.id)).toEqual(['new']);
    expect(sortRepos(list, '/w/o').map((x) => x.id)).toEqual(['old']);
    expect(list.map((x) => x.id)).toEqual(['old', 'new', 'pin', 'mid']); // not sorted in place
  });
});

describe('store: resizable commit box and description', () => {
  beforeEach(() => {
    vi.spyOn(live, 'persistUi').mockImplementation(() => {});
    setState({ commitDescOpen: true, detailsDescOpen: true, layout: { sidebar: 230, details: 0.46, files: 300, commitBox: 170, detailsHeader: 130 } });
  });
  afterEach(() => vi.restoreAllMocks());

  it('remembers the commit box and description heights', () => {
    setLayout({ commitBox: 320 });
    expect(getState().layout.commitBox).toBe(320);
    expect(live.persistUi).toHaveBeenCalledWith({ commitBoxHeight: 320 });
    setLayout({ detailsHeader: 200 });
    expect(live.persistUi).toHaveBeenCalledWith({ detailsHeaderHeight: 200 });
  });

  it('folds and unfolds both descriptions and persists the choice', () => {
    toggleCommitDesc();
    expect(getState().commitDescOpen).toBe(false);
    expect(live.persistUi).toHaveBeenCalledWith({ commitDescOpen: false });
    toggleCommitDesc();
    expect(getState().commitDescOpen).toBe(true);
    toggleDetailsDesc();
    expect(getState().detailsDescOpen).toBe(false);
    expect(live.persistUi).toHaveBeenCalledWith({ detailsDescOpen: false });
  });

  it('clamps stored heights and applies stored folds without writing them back', () => {
    applyUiPrefs({ commitBoxHeight: 10, detailsHeaderHeight: 99999, commitDescOpen: false, detailsDescOpen: false });
    expect(getState().layout.commitBox).toBe(COMMIT_BOX_MIN);
    expect(getState().layout.detailsHeader).toBe(480);
    expect(getState().commitDescOpen).toBe(false);
    expect(getState().detailsDescOpen).toBe(false);
    expect(live.persistUi).not.toHaveBeenCalled();
  });
});

describe('store: branch click and branch filter', () => {
  const c = (sha: string, parents: string[] = []): Commit => ({ sha, parents, subject: sha, body: '', author: 'A', email: 'a@x', date: 0 }) as unknown as Commit;
  beforeEach(() => {
    setState({ workspaces: [{ id: 'work', name: 'work' }], activeWorkspace: 'work', tabs: [], activeTab: null, repoStates: {}, repos: [info('a')], engine: { online: false, git: '', version: '' } });
    openRepo('a');
    const r = getState().repoStates.a;
    setState({ repoStates: { a: { ...r, commits: [c('c3', ['c2']), c('c2', ['c1'])], filteredCommits: [c('f1')], historyCommits: [c('h1')], graphFilter: { mode: 'all', refs: [], hideRemotes: false } } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it('finds a commit in the main log, the filtered log or a file history', () => {
    const r = getState().repoStates.a;
    expect(findCommit(r, 'c2')?.sha).toBe('c2');
    expect(findCommit(r, 'f1')?.sha).toBe('f1');
    expect(findCommit(r, 'h1')?.sha).toBe('h1');
    expect(findCommit(r, 'nope')).toBeUndefined();
    expect(findCommit(r, null)).toBeUndefined();
  });

  it('a branch click selects its commit and asks the list to scroll, every click again', () => {
    revealCommit('c2');
    const first = getState().repoStates.a.reveal!;
    expect(getState().repoStates.a.selectedCommit).toBe('c2');
    expect(first.sha).toBe('c2');
    revealCommit('c2');
    expect(getState().repoStates.a.reveal!.nonce).toBeGreaterThan(first.nonce); // a second click scrolls again
  });

  it('the funnel adds and removes branches; the last one out, or Clear, shows everything', () => {
    toggleBranchFilter('main');
    expect(getState().repoStates.a.graphFilter).toMatchObject({ mode: 'selected', refs: ['main'] });
    toggleBranchFilter('dev');
    expect(getState().repoStates.a.graphFilter.refs).toEqual(['main', 'dev']);
    toggleBranchFilter('main');
    toggleBranchFilter('dev');
    expect(getState().repoStates.a.graphFilter).toMatchObject({ mode: 'all', refs: [] });
    toggleBranchFilter('dev');
    clearBranchFilter();
    expect(getState().repoStates.a.graphFilter).toMatchObject({ mode: 'all', refs: [] });
  });

  it('with the engine, the funnel asks git for the filtered history and a click goes through the pager', () => {
    vi.spyOn(live, 'isLiveActive').mockReturnValue(true);
    const apply = vi.spyOn(live, 'applyGraphFilter').mockResolvedValue(undefined);
    const reveal = vi.spyOn(live, 'revealCommit').mockResolvedValue(undefined);
    toggleBranchFilter('main');
    expect(apply).toHaveBeenCalled();
    revealCommit('c3');
    expect(reveal).toHaveBeenCalledWith('c3');
  });
});

describe('store: error log and dialog', () => {
  beforeEach(() => setState({ errors: [], errorOpen: null, toasts: [] }));

  it('an error toast keeps the whole message in the log and opens the dialog; the status line shows the first line', () => {
    toast('Checkout failed', 'error', 'error: Your local changes would be overwritten:\n\timg/pixel.png\nAborting');
    const [e] = getState().errors;
    expect(e).toMatchObject({ title: 'Checkout failed', count: 1 });
    expect(e.detail).toContain('img/pixel.png');
    expect(getState().errorOpen).toBe(e.id);
    expect(getState().toasts.at(-1)).toMatchObject({ detail: 'error: Your local changes would be overwritten:', errorId: e.id });
  });

  it('the same error again within a minute counts up instead of piling up', () => {
    reportError('Fetch failed', 'Could not resolve host');
    closeErrors();
    reportError('Fetch failed', 'Could not resolve host');
    expect(getState().errors).toHaveLength(1);
    expect(getState().errors[0].count).toBe(2);
    expect(getState().errorOpen).toBe(getState().errors[0].id); // shown again
    reportError('Push failed', 'rejected');
    expect(getState().errors.map((e) => e.title)).toEqual(['Push failed', 'Fetch failed']);
  });

  it('an error can offer a way out, kept when the same error comes again', () => {
    const run = vi.fn();
    toast('3 of 5 branches not deleted', 'error', 'a: not fully merged', { label: 'Delete 3 unmerged anyway', run });
    expect(getState().errors[0].action?.label).toBe('Delete 3 unmerged anyway');
    reportError('3 of 5 branches not deleted', 'a: not fully merged');
    expect(getState().errors[0].count).toBe(2);
    getState().errors[0].action!.run();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('info and success never open the dialog; the log keeps 50, newest first; clear empties it', () => {
    toast('Copied', 'info');
    toast('Pushed', 'success');
    expect(getState().errors).toHaveLength(0);
    expect(getState().errorOpen).toBeNull();
    for (let i = 0; i < 60; i++) reportError(`e${i}`);
    expect(getState().errors).toHaveLength(50);
    expect(getState().errors[0].title).toBe('e59');
    showErrors(getState().errors[10].id);
    expect(getState().errorOpen).toBe(getState().errors[10].id);
    clearErrors();
    expect(getState().errors).toEqual([]);
    expect(getState().errorOpen).toBeNull();
  });
});

describe('store: notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setState({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('queues notifications, keeps errors longer and lets the user dismiss them', () => {
    toast('Saved', 'success');
    toast('Boom', 'error', 'details');
    expect(getState().toasts.map((t) => t.text)).toEqual(['Saved', 'Boom']);
    vi.advanceTimersByTime(3600);
    expect(getState().toasts.map((t) => t.text)).toEqual(['Boom']); // the error is still shown
    const id = getState().toasts[0].id;
    dismissToast(id);
    expect(getState().toasts).toEqual([]);
    toast('Later', 'error');
    vi.advanceTimersByTime(7100);
    expect(getState().toasts).toEqual([]);
  });
});

describe('store: the commit box Amend checkbox', () => {
  const head = { sha: 'h1', parents: [], subject: 'Last commit', body: 'Its body', author: 'A', email: 'a@x', date: 0 } as unknown as Commit;
  const box = () => {
    const r = getState().repoStates.a;
    return { amend: r.amend, summary: r.commitMessage, description: r.commitDescription };
  };
  beforeEach(() => {
    setState({ workspaces: [{ id: 'work', name: 'work' }], activeWorkspace: 'work', tabs: [], activeTab: null, repoStates: {}, repos: [info('a')], engine: { online: false, git: '', version: '' } });
    openRepo('a');
    const r = getState().repoStates.a;
    setState({ repoStates: { a: { ...r, commits: [head], head: 'h1', commitMessage: '', commitDescription: '', amend: false } } });
  });

  it('an empty box gets the last message; unticking takes it away again', () => {
    toggleAmend();
    expect(box()).toEqual({ amend: true, summary: 'Last commit', description: 'Its body' });
    toggleAmend();
    expect(box()).toEqual({ amend: false, summary: '', description: '' });
  });
  it('what the user typed stays, ticked and unticked (unticking wiped it)', () => {
    setCommitMessage('my words');
    toggleAmend();
    expect(box()).toEqual({ amend: true, summary: 'my words', description: '' });
    toggleAmend();
    expect(box()).toEqual({ amend: false, summary: 'my words', description: '' });
  });
  it('the loaded message, once edited, is the user’s: unticking keeps it', () => {
    toggleAmend();
    setCommitMessage('Last commit, reworded');
    toggleAmend();
    expect(box().summary).toBe('Last commit, reworded');
  });
});

describe('store: tabs, workspaces and the start screen (shell audit)', () => {
  const liveInfo = (id: string, workspace = 'work', workspaces?: string[]) => ({ ...info(id, workspace), live: true, workspaces });
  beforeEach(() => {
    vi.spyOn(live, 'persistUi').mockImplementation(() => {});
    vi.spyOn(live, 'openLive').mockImplementation(async (id: string) => void setState((s) => ({ activeTab: id, screen: 'repo', repoStates: { ...s.repoStates, [id]: { ...(s.repoStates.a ?? ({} as any)), id } } })));
    vi.spyOn(live.client, 'moveRepo').mockResolvedValue(undefined);
    vi.spyOn(live.client, 'pinRepo').mockResolvedValue(undefined);
    setState({ workspaces: [{ id: 'work', name: 'work' }, { id: 'home', name: 'home' }], activeWorkspace: 'work', workspaceTabs: {}, tabs: [], activeTab: null, repoStates: {}, repos: [info('a'), info('b'), info('c'), info('h', 'home')], screen: 'welcome', toasts: [], dialog: null, engine: { online: false, git: '', version: '' } });
  });
  afterEach(() => vi.restoreAllMocks());

  it('closing the active tab shows its neighbour (the next one, else the one before)', () => {
    openRepo('a');
    openRepo('b');
    openRepo('c');
    setState({ activeTab: 'b' });
    closeTab('b');
    expect(getState().activeTab).toBe('c');
    closeTab('c');
    expect(getState().activeTab).toBe('a');
    expect(getState().screen).toBe('repo');
    closeTab('a');
    expect(getState().activeTab).toBeNull();
    expect(getState().screen).toBe('welcome');
  });

  it('closing a tab from the start screen keeps the start screen; closing another tab keeps the shown one', () => {
    openRepo('a');
    openRepo('b');
    setState({ screen: 'welcome' });
    closeTab('b');
    expect(getState().screen).toBe('welcome');
    expect(getState().tabs).toEqual(['a']);
    openRepo('b');
    openRepo('c');
    closeTab('a');
    expect(getState().activeTab).toBe('c');
    expect(getState().screen).toBe('repo');
  });

  it('the neighbour that was never read (a tab of the last session) is read when it is shown', () => {
    setState({ repos: [liveInfo('x'), liveInfo('y')], tabs: ['x', 'y'], activeTab: 'x', screen: 'repo', repoStates: { x: { id: 'x' } as any } });
    closeTab('x');
    expect(live.openLive).toHaveBeenCalledWith('y');
    expect(getState().activeTab).toBe('y');
  });

  it('a workspace picked on the start screen keeps the start screen; from a repository it shows its last tab', () => {
    openRepo('a');
    switchWorkspace('home');
    expect(getState().screen).toBe('welcome');
    openRepo('h');
    setState({ screen: 'welcome' });
    switchWorkspace('work', true);
    expect(getState().screen).toBe('welcome');
    expect(getState().tabs).toEqual(['a']);
    switchWorkspace('home');
    expect(getState().screen).toBe('repo');
    expect(getState().activeTab).toBe('h');
  });

  it('moving a repository out of the workspace whose scan lists it takes it out of that list, and tells the engine where from', () => {
    setState({ repos: [liveInfo('s', 'work', ['work', 'home'])] });
    moveRepoToWorkspace('s', 'home');
    const s = getState().repos.find((r) => r.id === 's')!;
    expect(inWorkspace(s, 'work')).toBe(false);
    expect(inWorkspace(s, 'home')).toBe(true);
    expect(live.client.moveRepo).toHaveBeenCalledWith('/tmp/s', 'home', 'work');
  });

  it('a pin is kept by the engine; the palette’s next scheme is remembered', () => {
    setState({ repos: [liveInfo('p')] });
    togglePin('p');
    expect(live.client.pinRepo).toHaveBeenCalledWith('/tmp/p', true);
    expect(getState().repos[0].pinned).toBe(true);
    setState({ theme: 'amber' });
    toggleTheme();
    expect(live.persistUi).toHaveBeenCalledWith({ theme: 'phosphor' });
  });

  it('deleting a workspace moves the repositories it owned in the engine too (or it came back on the next launch)', () => {
    setState({ workspaces: [{ id: 'work', name: 'work' }, { id: 'gone', name: 'gone' }], repos: [liveInfo('g', 'gone'), liveInfo('w', 'work')] });
    deleteWorkspace('gone');
    (getState().dialog as any).onConfirm();
    expect(live.client.moveRepo).toHaveBeenCalledWith('/tmp/g', 'work');
    expect(live.client.moveRepo).toHaveBeenCalledTimes(1);
  });

  it('the history / details split is remembered', () => {
    setLayout({ details: 0.3 });
    expect(live.persistUi).toHaveBeenCalledWith({ detailsRatio: 0.3 });
    applyUiPrefs({ detailsRatio: 0.95 });
    expect(getState().layout.details).toBe(0.8);
  });

  it('removing the shown repository from the list closes its tab and points nowhere else', () => {
    openRepo('a');
    openRepo('b');
    removeRepo('b');
    expect(getState().tabs).toEqual(['a']);
    expect(getState().activeTab).toBe('a');
    setState({ screen: 'welcome' });
    removeRepo('a');
    expect(getState().activeTab).toBeNull();
  });
});
