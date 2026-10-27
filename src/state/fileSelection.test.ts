import { beforeEach, describe, expect, it } from 'vitest';
import { clickFileSelection, clickFolderSelection, getState, openRepo, pickedFiles, selectFile, setFileSelection, setState, updateRepo } from './store';

const f = (path: string) => ({ path, status: 'M' as const, kind: 'text' as const, additions: 1, deletions: 0 });

/** Picking several Changes files: ⌘ toggles, Shift runs in the order shown, the other list starts over. */
describe('store: picked Changes files', () => {
  const order = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
  const repo = () => getState().repoStates[getState().activeTab!];
  beforeEach(() => {
    setState({ engine: { online: false, git: '', version: '' }, repos: [{ id: 'm', name: 'm', workspace: 'work', path: '/tmp/m', currentBranch: 'main', changes: 0, lastOpened: 0 }], tabs: [], activeTab: null, activeWorkspace: 'work' });
    openRepo('m');
    updateRepo({ unstaged: order.map(f), staged: [f('s1.txt'), f('s2.txt')], section: 'changes', selectedArea: 'unstaged', selectedFile: 'a.txt', fileSelection: [], fileAnchor: 'a.txt' });
  });

  it('⌘ adds and removes; the diff follows the clicked file; one left is a plain selection', () => {
    clickFileSelection('unstaged', 'c.txt', { meta: true, shift: false }, order);
    expect(repo().fileSelection).toEqual(['a.txt', 'c.txt']);
    expect(repo().selectedFile).toBe('c.txt');
    expect(pickedFiles(repo(), 'unstaged')).toEqual(['a.txt', 'c.txt']);
    clickFileSelection('unstaged', 'a.txt', { meta: true, shift: false }, order);
    expect(repo().fileSelection).toEqual([]);
    expect(pickedFiles(repo(), 'unstaged')).toEqual(['c.txt']);
  });

  it('Shift picks the run from the last clicked one, in the order shown; ⌘A-like set of all', () => {
    clickFileSelection('unstaged', 'b.txt', { meta: false, shift: true }, order);
    expect(repo().fileSelection).toEqual(['a.txt', 'b.txt']);
    clickFileSelection('unstaged', 'd.txt', { meta: false, shift: true }, order);
    expect(repo().fileSelection).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    setFileSelection('unstaged', order, 'b.txt');
    expect(pickedFiles(repo(), 'unstaged')).toEqual(order);
    expect(repo().selectedFile).toBe('b.txt');
  });

  it('a pick in the other list starts over there; a plain click drops the pick', () => {
    clickFileSelection('unstaged', 'b.txt', { meta: true, shift: false }, order);
    expect(repo().fileSelection).toHaveLength(2);
    clickFileSelection('staged', 's2.txt', { meta: true, shift: false }, ['s1.txt', 's2.txt']);
    expect(repo().selectedArea).toBe('staged');
    expect(pickedFiles(repo(), 'staged')).toEqual(['s2.txt']);
    expect(pickedFiles(repo(), 'unstaged')).toEqual([]);
    clickFileSelection('staged', 's1.txt', { meta: true, shift: false }, ['s1.txt', 's2.txt']);
    expect(pickedFiles(repo(), 'staged')).toEqual(['s2.txt', 's1.txt']);
    selectFile('staged', 's1.txt');
    expect(repo().fileSelection).toEqual([]);
  });

  it('a folder is picked as a file is: plain alone, ⌘ in and out, Shift up to it and all of it', () => {
    // a/ b.txt … : the tree order; the folder "d" holds c.txt and d.txt here
    const inside = ['c.txt', 'd.txt'];
    clickFolderSelection('unstaged', inside, { meta: false, shift: false }, order);
    expect(pickedFiles(repo(), 'unstaged')).toEqual(inside);
    expect(repo().selectedFile).toBe('c.txt');
    // ⌘ on a file adds it; ⌘ on the folder again takes its files out, the file stays
    clickFileSelection('unstaged', 'a.txt', { meta: true, shift: false }, order);
    expect(pickedFiles(repo(), 'unstaged')).toEqual(['c.txt', 'd.txt', 'a.txt']);
    clickFolderSelection('unstaged', inside, { meta: true, shift: false }, order);
    expect(pickedFiles(repo(), 'unstaged')).toEqual(['a.txt']);
    // ⌘ on it puts them back
    clickFolderSelection('unstaged', inside, { meta: true, shift: false }, order);
    expect(pickedFiles(repo(), 'unstaged')).toEqual(['a.txt', 'c.txt', 'd.txt']);
    // Shift from a file before it: the run to its near end, and the rest of it
    selectFile('unstaged', 'a.txt');
    clickFolderSelection('unstaged', inside, { meta: false, shift: true }, order);
    expect(pickedFiles(repo(), 'unstaged')).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    // from a file after it (a folder that holds a.txt and b.txt): the same, backwards
    selectFile('unstaged', 'd.txt');
    clickFolderSelection('unstaged', ['a.txt', 'b.txt'], { meta: false, shift: true }, order);
    expect([...pickedFiles(repo(), 'unstaged')].sort()).toEqual(order);
  });

  it('a folder in the other list starts over there', () => {
    clickFileSelection('unstaged', 'b.txt', { meta: true, shift: false }, order);
    clickFolderSelection('staged', ['s1.txt', 's2.txt'], { meta: true, shift: false }, ['s1.txt', 's2.txt']);
    expect(repo().selectedArea).toBe('staged');
    expect(pickedFiles(repo(), 'staged')).toEqual(['s1.txt', 's2.txt']);
    expect(pickedFiles(repo(), 'unstaged')).toEqual([]);
  });
});
