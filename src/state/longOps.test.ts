import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSend, client, engineLostForTest, fetch, handleEventForTest, pull, stopRunning, undoLast } from './live';
import { EMPTY_REPO, getState, setState } from './store';

/** Fetch, pull, push and the like: what the status panel shows and stops, what is refreshed and undone after. */
const A = 'live:/w/a';
const B = 'live:/w/b';
const info = (path: string) => ({ id: `live:${path}`, name: path.split('/').pop()!, workspace: 'work', path, currentBranch: 'main', changes: 0, lastOpened: 0, live: true });
const sha = (c: string) => c.repeat(40);
const refsAt = (head: string) => [
  { name: 'main', kind: 'branch' as const, sha: head, current: true, upstream: 'origin/main' },
  { name: 'origin/main', kind: 'remote' as const, sha: sha('b') },
];
const repoAt = (id: string, path: string, head: string) => ({ ...EMPTY_REPO, id, path, live: true, head, refs: refsAt(head), remotes: [{ name: 'origin', url: '/o.git' }] });
const snap = (head: string) => ({ commits: [], refs: refsAt(head), remotes: [{ name: 'origin', url: '/o.git' }], stashes: [], unstaged: [], staged: [], head, op: { kind: 'none' }, shallow: false });

describe('live: long operations', () => {
  beforeEach(() => {
    setState({
      engine: { online: true, git: 'git', version: '1' },
      repos: [info('/w/a'), info('/w/b')],
      tabs: [A, B],
      activeTab: A,
      screen: 'repo',
      repoStates: { [A]: repoAt(A, '/w/a', sha('a')), [B]: repoAt(B, '/w/b', sha('a')) },
      operation: null,
      toasts: [],
      errors: [],
      errorOpen: null,
      undo: {},
    });
    setState((s) => ({ agent: { ...s.agent, busy: false, open: false, notices: [], messages: [], session: null, target: 'auto' } }));
    vi.spyOn(client, 'snapshotCached').mockResolvedValue(null);
    vi.spyOn(client, 'submodules').mockResolvedValue([]);
    vi.spyOn(client, 'commitFiles').mockResolvedValue([]);
    vi.spyOn(client, 'changedSubmodules').mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('when it ends, the repository it ran in is read again, even with another tab on screen', async () => {
    vi.spyOn(client, 'fetch').mockResolvedValue({ opId: 'f1' });
    const read = vi.spyOn(client, 'snapshot').mockResolvedValue(snap(sha('a')) as any);
    fetch({});
    await vi.waitFor(() => expect(getState().operation?.label).toBe('Fetching all remotes'));
    setState({ activeTab: B });
    handleEventForTest({ opId: 'f1', label: 'Fetching all remotes', done: true });
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    // it used to read the tab on screen (b), and a's new remote branches stayed hidden until a refresh
    expect(read.mock.calls.map((c) => c[0])).toEqual(['/w/a']);
    expect(getState().toasts.at(-1)).toMatchObject({ kind: 'success', text: 'Fetching all remotes: done' });
  });

  it('Stop stops what the panel shows: the fetch while it is on screen, the agent once the fetch is over', async () => {
    vi.spyOn(client, 'snapshot').mockResolvedValue(snap(sha('a')) as any);
    vi.spyOn(client, 'agentRun').mockResolvedValue({ opId: 'ag1' });
    const cancel = vi.spyOn(client, 'cancelOp').mockResolvedValue();
    await agentSend('создай ветку feature/z');
    expect(getState().operation?.label).toBe('Agent working');
    vi.spyOn(client, 'fetch').mockResolvedValue({ opId: 'f2' });
    fetch({ remote: 'origin' });
    await vi.waitFor(() => expect(getState().operation?.label).toBe('Fetching origin'));
    stopRunning();
    // the fetch's stop button used to stop the agent, and the fetch went on
    expect(cancel).toHaveBeenLastCalledWith('f2');
    handleEventForTest({ opId: 'f2', label: 'Fetching origin', done: true, error: 'Stopped' });
    expect(getState().toasts.at(-1)).toMatchObject({ kind: 'info', text: 'Fetching origin: stopped' });
    // the agent still works: the panel goes back to it, and Stop now stops it
    expect(getState().operation?.label).toBe('Agent working');
    stopRunning();
    expect(cancel).toHaveBeenLastCalledWith('ag1');
    handleEventForTest({ opId: 'ag1', label: 'Agent', done: true, error: 'Stopped' });
    expect(getState().operation).toBeNull();
  });

  it('git’s progress, redrawn thousands of times, stays one line per phase in the output', async () => {
    vi.spyOn(client, 'fetch').mockResolvedValue({ opId: 'f9' });
    fetch({});
    await vi.waitFor(() => expect(getState().operation).not.toBeNull());
    handleEventForTest({ opId: 'f9', label: 'Fetching all remotes', line: 'From /srv/game' });
    for (let i = 0; i <= 3000; i++) handleEventForTest({ opId: 'f9', label: 'Fetching all remotes', line: `Receiving objects: ${Math.floor(i / 30)}% (${i}/3000)`, progress: i / 3000 });
    for (let i = 0; i <= 100; i++) handleEventForTest({ opId: 'f9', label: 'Fetching all remotes', line: `Resolving deltas: ${i}% (${i}/100)` });
    handleEventForTest({ opId: 'f9', label: 'Fetching all remotes', line: ' * [new branch]      x -> origin/x' });
    expect(getState().operation?.log).toEqual(['From /srv/game', 'Receiving objects: 100% (3000/3000)', 'Resolving deltas: 100% (100/100)', ' * [new branch]      x -> origin/x']);
    vi.spyOn(client, 'snapshot').mockResolvedValue(snap(sha('a')) as any);
    handleEventForTest({ opId: 'f9', label: 'Fetching all remotes', done: true });
    // the result names what git said last, not a progress line
    expect(getState().toasts.at(-1)).toMatchObject({ text: 'Fetching all remotes: done', detail: ' * [new branch]      x -> origin/x' });
  });

  it('the engine going away ends the spinner of what it ran, says so, and the panel says offline', async () => {
    vi.spyOn(client, 'push').mockResolvedValue({ opId: 'p1' });
    const { push } = await import('./live');
    push({});
    await vi.waitFor(() => expect(getState().operation?.label).toBe('Pushing main to origin/main'));
    engineLostForTest();
    expect(getState().engine.online).toBe(false);
    expect(getState().operation).toBeNull();
    expect(getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Pushing main to origin/main: the engine stopped' });
    // a late event of that operation does not bring a stale spinner back as "done"
    engineLostForTest();
    expect(getState().toasts.filter((t) => /engine stopped/.test(t.text))).toHaveLength(1);
  });

  it('⌘Z right after a pull ends undoes the pull, not the action before it', async () => {
    // an older entry (a commit) that HEAD still matches until the pull's refresh lands
    const older = vi.fn().mockResolvedValue(undefined);
    setState({ undo: { [A]: [{ id: 1, label: 'Commit “x”', at: 0, head: sha('a'), run: older }] } });
    vi.spyOn(client, 'pull').mockResolvedValue({ opId: 'pl1' });
    let head = sha('a');
    vi.spyOn(client, 'snapshot').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return snap(head) as any;
    });
    const reset = vi.spyOn(client, 'reset').mockResolvedValue();
    pull({});
    await vi.waitFor(() => expect(getState().operation).not.toBeNull());
    head = sha('c');
    handleEventForTest({ opId: 'pl1', label: 'Pulling (merge)', done: true });
    await undoLast();
    expect(older).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(reset).toHaveBeenCalledWith('/w/a', sha('a'), 'keep'));
  });
});
