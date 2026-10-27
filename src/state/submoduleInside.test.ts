import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client, discardFiles, fillAmendMessage, refresh, revealCommit, stageAll, stageFile, stageFiles } from './live';
import { EMPTY_REPO, getState, setState, toggleAmend } from './store';
import type { FileChange } from '../git/types';

const ID = 'live:/w/proj';
const info = { id: ID, name: 'proj', workspace: 'work', path: '/w/proj', currentBranch: 'main', changes: 0, lastOpened: 0, live: true };
const file = (path: string, extra: Partial<FileChange> = {}): FileChange => ({ path, status: 'M', kind: 'text', additions: 1, deletions: 0, ...extra });
/** a submodule at its recorded commit with an edited file of its own */
const insideOnly = (path: string) => file(path, { kind: 'submodule', additions: 0, inside: { modified: 1, untracked: 0, files: [{ path: 'core.txt', status: 'M' }], only: true } });

function open(unstaged: FileChange[], extra: object = {}) {
  setState({
    engine: { online: true, git: 'git', version: '1' },
    repos: [info],
    tabs: [ID],
    activeTab: ID,
    toasts: [],
    repoStates: { [ID]: { ...EMPTY_REPO, unstaged, ...extra } },
  });
}

/**
 * A submodule listed for the changes in its own files alone has nothing to stage or discard in the project: they
 * are committed in the submodule. Staging it ran `git add` that did nothing, and the row stayed.
 */
describe('submodules listed for their own files', () => {
  beforeEach(() => {
    vi.spyOn(client, 'snapshot').mockRejectedValue(new Error('offline'));
    vi.spyOn(client, 'submoduleChanges').mockResolvedValue([]);
    vi.spyOn(client, 'writeTree').mockResolvedValue('tree');
  });
  afterEach(() => vi.restoreAllMocks());

  it('Stage on one says why nothing is staged, and git is not asked', () => {
    open([insideOnly('libs/core'), file('a.txt')]);
    const stage = vi.spyOn(client, 'stage').mockResolvedValue(undefined as any);
    stageFile('libs/core');
    expect(stage).not.toHaveBeenCalled();
    expect(getState().toasts.at(-1)).toMatchObject({ text: 'Nothing to stage in libs/core' });
    expect(getState().toasts.at(-1)?.detail).toContain('commit them there');
  });

  it('a group stages the rest without it; a group of only such submodules says so', async () => {
    open([insideOnly('libs/core'), insideOnly('libs/ui'), file('a.txt'), file('b.txt')]);
    const stage = vi.spyOn(client, 'stage').mockResolvedValue(undefined as any);
    stageFiles(['libs/core', 'a.txt', 'b.txt']);
    await vi.waitFor(() => expect(stage).toHaveBeenCalledWith('/w/proj', ['a.txt', 'b.txt']));
    stage.mockClear();
    stageFiles(['libs/core', 'libs/ui']);
    expect(stage).not.toHaveBeenCalled();
    expect(getState().toasts.at(-1)).toMatchObject({ text: 'Nothing to stage in 2 submodules' });
  });

  it('Discard of a group leaves them out (no confirm for them alone); Stage all with only them says so', () => {
    open([insideOnly('libs/core')]);
    const discard = vi.spyOn(client, 'discard');
    discardFiles(['libs/core']);
    expect(discard).not.toHaveBeenCalled();
    expect(getState().toasts.at(-1)).toMatchObject({ text: 'Nothing to discard in libs/core' });
    expect(getState().dialog).toBeFalsy();
    const all = vi.spyOn(client, 'stageAll');
    stageAll();
    expect(all).not.toHaveBeenCalled();
    expect(getState().toasts.at(-1)).toMatchObject({ text: 'Nothing to stage in libs/core' });
  });
});

/** Amend ticked before the history was read (a big repository, a tab just opened) used to leave the box empty. */
describe('Amend before the history is read', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the last commit and fills the empty box', async () => {
    open([], { head: 'abc', commits: [], amend: false, commitMessage: '', commitDescription: '' });
    const log = vi.spyOn(client, 'logPage').mockResolvedValue([{ sha: 'abc', parents: [], author: 'A', email: 'a@x', date: 0, subject: 'Second commit', body: 'Its description', refs: [] } as any]);
    toggleAmend();
    await vi.waitFor(() => expect(getState().repoStates[ID].commitMessage).toBe('Second commit'));
    expect(getState().repoStates[ID].commitDescription).toBe('Its description');
    expect(log).toHaveBeenCalledWith('/w/proj', 0, 1, ['HEAD']);
  });

  it('leaves typed text alone, and does not read when the history has the commit', async () => {
    open([], { head: 'abc', commits: [], amend: true, commitMessage: 'my words', commitDescription: '' });
    const log = vi.spyOn(client, 'logPage');
    await fillAmendMessage();
    expect(log).not.toHaveBeenCalled();
    open([], { head: 'abc', commits: [{ sha: 'abc', parents: [], author: 'A', email: 'a@x', date: 0, subject: 'Loaded', body: '', refs: [] }], amend: false, commitMessage: '', commitDescription: '' });
    toggleAmend();
    expect(getState().repoStates[ID].commitMessage).toBe('Loaded');
    expect(log).not.toHaveBeenCalled();
  });
});

/**
 * A big submodule (township's vso-engine: 3 s) is read after the list: the engine answers the list with what it read
 * before (nothing, on the first read), and the client reads again once the fresh read says otherwise.
 */
describe('submodule changes read after the list', () => {
  afterEach(() => vi.restoreAllMocks());
  const snap = (unstaged: FileChange[]) => ({ commits: [], refs: [], remotes: [], stashes: [], unstaged, staged: [], head: 'abc', op: { kind: 'none' }, shallow: false, unborn: undefined, timings: {} }) as any;

  it('the list without them, then the fresh read adds them: one more read, and no third', async () => {
    open([], { selectedFile: null, selectedArea: 'unstaged' });
    const snapshot = vi.spyOn(client, 'snapshot').mockResolvedValueOnce(snap([file('a.txt')])).mockResolvedValue(snap([insideOnly('libs/core'), file('a.txt')]));
    const changes = vi.spyOn(client, 'submoduleChanges').mockResolvedValue([{ path: 'libs/core', modified: 1, untracked: 0, files: [{ path: 'core.txt', status: 'M' }] }]);
    await refresh(ID);
    await vi.waitFor(() => expect(getState().repoStates[ID].unstaged.map((f) => f.path)).toEqual(['libs/core', 'a.txt']));
    expect(snapshot).toHaveBeenCalledTimes(2);
    // the read it made does not ask again (it would loop when the two never agree)
    await new Promise((r) => setTimeout(r, 20));
    expect(changes).toHaveBeenCalledTimes(1);
    // the next read finds the list and the fresh read the same: nothing more
    await refresh(ID);
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshot).toHaveBeenCalledTimes(3);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('gone from the fresh read (committed in the submodule): read again, the row goes', async () => {
    open([], { selectedFile: null, selectedArea: 'unstaged' });
    const snapshot = vi.spyOn(client, 'snapshot').mockResolvedValueOnce(snap([insideOnly('libs/core')])).mockResolvedValue(snap([]));
    vi.spyOn(client, 'submoduleChanges').mockResolvedValue([]);
    await refresh(ID);
    await vi.waitFor(() => expect(getState().repoStates[ID].unstaged).toEqual([]));
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
});

/**
 * A commit revealed in a tab (a submodule's arrow, a branch click) is read from the history first; a tab switch
 * meanwhile used to pick it — and the history section — in the tab the user went to.
 */
describe('a reveal that ends after a tab switch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('picks the commit in its own repository and leaves the shown one as it is', async () => {
    const SUB = 'live:/w/proj/libs/core';
    setState({
      engine: { online: true, git: 'git', version: '1' },
      repos: [info, { ...info, id: SUB, name: 'core', path: '/w/proj/libs/core' }],
      tabs: [ID, SUB],
      activeTab: SUB,
      toasts: [],
      repoStates: { [ID]: { ...EMPTY_REPO, section: 'changes' }, [SUB]: { ...EMPTY_REPO, section: 'changes', commits: [] } },
    });
    let answer: (v: any) => void = () => {};
    vi.spyOn(client, 'logUntil').mockReturnValue(new Promise((r) => (answer = r)) as any);
    vi.spyOn(client, 'commitFiles').mockResolvedValue([] as any);
    const deep = { sha: 'c0ffee', parents: [], author: 'A', email: 'a@x', date: 0, subject: 'core: three', body: '', refs: [] };
    const done = revealCommit('c0ffee');
    // the user goes to the project's tab while the submodule's history is read
    setState({ activeTab: ID });
    answer({ index: 0, commits: [deep] });
    await done;
    expect(getState().repoStates[ID]).toMatchObject({ section: 'changes', selectedCommit: null });
    expect(getState().repoStates[SUB]).toMatchObject({ section: 'commits', selectedCommit: 'c0ffee' });
  });
});
