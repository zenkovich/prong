import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSend, agentStop, client, handleAgentEvent, handleEventForTest, persistUi, scanWorkspace } from './live';
import { agentSend as sendFromUi, clearAgentChat, dismissAgentNotice, finishAgentRun, getState, inWorkspace, setState } from './store';

const known = (path: string, workspace: string, workspaces: string[] = [workspace], lastOpened = 0) => ({ path, name: path.split('/').pop()!, workspace, workspaces, lastOpened });
const liveInfo = (path: string, workspace = 'work') => ({ id: `live:${path}`, name: path.split('/').pop()!, workspace, path, currentBranch: '', changes: 0, lastOpened: 0, live: true });

describe('live: workspace scan merge', () => {
  beforeEach(() => {
    setState({
      engine: { online: true, git: 'git version 2', version: '1' },
      workspaces: [{ id: 'work', name: 'work', rootPath: '/w', scanDepth: 3 }, { id: 'home', name: 'home', rootPath: '/w', scanDepth: 3 }],
      activeWorkspace: 'home',
      repos: [liveInfo('/w/a'), liveInfo('/w/b'), liveInfo('/w/a/sub')],
      tabs: ['live:/w/a/sub'],
      activeTab: 'live:/w/a/sub',
      repoStates: {},
      toasts: [],
      scanning: null,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('adds new repositories, follows workspace membership and drops entries the engine forgot (with their tabs)', async () => {
    vi.spyOn(client, 'scan').mockResolvedValue([{ path: '/w/a', name: 'a', nested: false }, { path: '/w/b', name: 'b', nested: false }, { path: '/w/c', name: 'c', nested: false }]);
    // both workspaces scan /w: a and b are now members of work and home, c is new, the nested a/sub was dropped
    vi.spyOn(client, 'listRepos').mockResolvedValue([known('/w/a', 'work', ['work', 'home']), known('/w/b', 'work', ['work', 'home']), known('/w/c', 'home', ['home'])]);
    await scanWorkspace('home');
    const s = getState();
    expect(client.scan).toHaveBeenCalledWith('/w', 3, { workspace: 'home' });
    expect(s.repos.map((r) => [r.path, r.workspace, r.workspaces]).sort()).toEqual([['/w/a', 'work', ['work', 'home']], ['/w/b', 'work', ['work', 'home']], ['/w/c', 'home', ['home']]]);
    expect(s.repos.filter((r) => inWorkspace(r, 'home')).map((r) => r.path)).toEqual(['/w/a', '/w/b', '/w/c']);
    expect(s.repos.filter((r) => inWorkspace(r, 'work')).map((r) => r.path)).toEqual(['/w/a', '/w/b']);
    expect(s.tabs).toEqual([]);
    expect(s.activeTab).toBeNull();
    expect(s.scanning).toBeNull();
    expect(s.toasts.at(-1)?.text).toContain('Scanned /w');
    expect(s.toasts.at(-1)?.detail).toBe('3 repositories');
  });

  it('does nothing for a workspace without a root folder or when the engine is offline', async () => {
    const scan = vi.spyOn(client, 'scan');
    setState({ workspaces: [{ id: 'home', name: 'home' }] });
    await scanWorkspace('home');
    expect(scan).not.toHaveBeenCalled();
    setState({ workspaces: [{ id: 'home', name: 'home', rootPath: '/w' }], engine: { online: false, git: '', version: '' } });
    await scanWorkspace('home');
    expect(scan).not.toHaveBeenCalled();
  });

  it('reports a failed scan instead of throwing', async () => {
    vi.spyOn(client, 'scan').mockRejectedValue(new Error('EACCES'));
    await scanWorkspace('home');
    expect(getState().scanning).toBeNull();
    expect(getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Scan failed', detail: 'EACCES' });
  });
});

describe('live: UI preference persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setState({ engine: { online: true, git: 'git', version: '1' } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('debounces and merges patches into one settings write', async () => {
    const save = vi.spyOn(client, 'saveSettings').mockResolvedValue({ ui: { fileView: 'list', uiScale: 1.25 } } as any);
    persistUi({ fileView: 'list' });
    persistUi({ uiScale: 1.25 });
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ ui: { fileView: 'list', uiScale: 1.25 } });
  });
});

describe('live: agent routing', () => {
  beforeEach(() => {
    setState({
      engine: { online: true, git: 'git', version: '1' },
      repos: [liveInfo('/w/a')],
      tabs: ['live:/w/a'],
      activeTab: 'live:/w/a',
      operation: null,
    });
    setState((s) => ({ agent: { ...s.agent, busy: false, open: false, status: null, startedAt: null, notices: [], messages: [], session: null, target: 'auto', settings: { ...s.agent.settings, sourcesPath: '/src/prong', askBeforeApply: false } } }));
    // the refresh after a repository run must not reach a real engine
    vi.spyOn(client, 'snapshot').mockRejectedValue(new Error('offline'));
    vi.spyOn(client, 'snapshotCached').mockResolvedValue(null);
    vi.spyOn(client, 'status').mockRejectedValue(new Error('offline'));
    vi.spyOn(client, 'appPrepare').mockResolvedValue({ before: {} });
    vi.spyOn(client, 'appRecord').mockResolvedValue(null);
    vi.spyOn(client, 'appVersions').mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends UI requests to the app sources and git requests to the repository', async () => {
    const run = vi.spyOn(client, 'agentRun').mockResolvedValue({ opId: 'op1' });
    await agentSend('сделай сайдбар шире');
    expect(run).toHaveBeenLastCalledWith('сделай сайдбар шире', '/src/prong', 'app', true, undefined);
    handleAgentEvent({ opId: 'op1', done: true } as any);
    // an app run is finished only once its version is recorded
    await vi.waitFor(() => expect(getState().agent.busy).toBe(false));
    await agentSend('создай ветку feature/x');
    expect(run).toHaveBeenLastCalledWith('создай ветку feature/x', '/w/a', 'repo', true, undefined);
  });

  it('a reply continues the conversation where it was; a new task elsewhere or a cleared chat starts afresh', async () => {
    const run = vi.spyOn(client, 'agentRun').mockResolvedValueOnce({ opId: 's1' }).mockResolvedValueOnce({ opId: 's2' }).mockResolvedValueOnce({ opId: 's3' }).mockResolvedValueOnce({ opId: 's4' });
    await agentSend('почему не работает fetch?');
    handleAgentEvent({ opId: 's1', line: `result:${JSON.stringify({ text: '**Причина:** …', sessionId: 'sess-1234abcd' })}` } as any);
    handleAgentEvent({ opId: 's1', done: true } as any);
    await vi.waitFor(() => expect(getState().agent.busy).toBe(false));
    expect(getState().agent.session).toEqual({ id: 'sess-1234abcd', mode: 'repo', cwd: '/w/a' });
    // "да, сделай": no words of either kind — the same conversation, in the same repository, even from another tab
    setState({ repos: [liveInfo('/w/a'), liveInfo('/w/b')], tabs: ['live:/w/a', 'live:/w/b'], activeTab: 'live:/w/b' });
    await agentSend('да, сделай');
    expect(run).toHaveBeenLastCalledWith('да, сделай', '/w/a', 'repo', true, 'sess-1234abcd');
    handleAgentEvent({ opId: 's2', done: true } as any);
    await vi.waitFor(() => expect(getState().agent.busy).toBe(false));
    // a UI request is another place: a new conversation there
    await agentSend('сделай сайдбар шире');
    expect(run).toHaveBeenLastCalledWith('сделай сайдбар шире', '/src/prong', 'app', true, undefined);
    handleAgentEvent({ opId: 's3', done: true } as any);
    await vi.waitFor(() => expect(getState().agent.busy).toBe(false));
    clearAgentChat();
    expect(getState().agent.session).toBeNull();
  });

  it('re-runs an AUTO request in the other target when the agent answers with the marker', async () => {
    const run = vi.spyOn(client, 'agentRun').mockResolvedValue({ opId: 'op2' });
    await agentSend('покажи историю файла README в панели'); // ambiguous: both vocabularies
    const first = run.mock.calls[0][2];
    const other = first === 'app' ? 'repo' : 'app';
    handleAgentEvent({ opId: 'op2', line: `text:PRONG_TARGET: ${other}` } as any);
    handleAgentEvent({ opId: 'op2', done: true } as any);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][2]).toBe(other);
    expect(getState().agent.messages.at(-1)?.target).toBe(other);
  });

  it('shows what the agent is doing, then leaves a notice that stays until dismissed', async () => {
    vi.spyOn(client, 'agentRun').mockResolvedValue({ opId: 'op4' });
    await agentSend('создай ветку feature/y');
    expect(getState().agent.busy).toBe(true);
    expect(getState().agent.status).toBe('Starting Claude Code…');
    handleAgentEvent({ opId: 'op4', line: 'status:session 1234abcd · claude' } as any);
    expect(getState().agent.status).toBe('Thinking…');
    handleAgentEvent({ opId: 'op4', line: 'tool:Read /w/a/src/main.ts' } as any);
    expect(getState().agent.status).toBe('Reading main.ts');
    handleAgentEvent({ opId: 'op4', line: 'tool:Bash git switch -c feature/y' } as any);
    handleAgentEvent({ opId: 'op4', line: 'result:' + JSON.stringify({ text: 'Created feature/y.', costUsd: 0.05 }) } as any);
    handleAgentEvent({ opId: 'op4', done: true } as any);
    await vi.waitFor(() => expect(getState().agent.busy).toBe(false));
    const a = getState().agent;
    expect(a.status).toBeNull();
    expect(a.notices[0]).toMatchObject({ ok: true, title: 'Done', text: 'Created feature/y.', target: 'repo', cost: '$0.050' });
    expect(a.notices[0].actions).toEqual(['Read /w/a/src/main.ts', 'Bash git switch -c feature/y']);
    dismissAgentNotice(a.notices[0].id);
    expect(getState().agent.notices).toHaveLength(0);
  });

  it('stop cancels the engine op and the notice says Stopped; an open chat panel gets no notice', async () => {
    vi.spyOn(client, 'agentRun').mockResolvedValue({ opId: 'op5' });
    const cancel = vi.spyOn(client, 'cancelOp').mockResolvedValue();
    await agentSend('создай ветку feature/z');
    await agentStop();
    expect(cancel).toHaveBeenCalledWith('op5');
    expect(getState().agent.status).toBe('Stopping…');
    handleAgentEvent({ opId: 'op5', done: true, error: 'Stopped' } as any);
    expect(getState().agent.notices[0]).toMatchObject({ ok: false, title: 'Stopped' });
    setState((s) => ({ agent: { ...s.agent, notices: [], open: true } }));
    await agentSend('создай ветку feature/w');
    handleAgentEvent({ opId: 'op5', done: true } as any);
    await vi.waitFor(() => expect(getState().agent.busy).toBe(false));
    expect(getState().agent.notices).toHaveLength(0);
  });

  it('without a repository the request ends at once with a notice', async () => {
    const run = vi.spyOn(client, 'agentRun');
    setState({ tabs: [], activeTab: null });
    await agentSend('создай ветку nowhere');
    expect(run).not.toHaveBeenCalled();
    expect(getState().agent.busy).toBe(false);
    expect(getState().agent.notices[0]).toMatchObject({ ok: false, title: 'No repository open' });
  });

  it('an app change becomes a version, the interface is rebuilt, and the run ends when the new build is served', async () => {
    setState((s) => ({ engine: { ...s.engine, ui: 'static' } }));
    vi.spyOn(client, 'agentRun').mockResolvedValue({ opId: 'app1' });
    const prepare = vi.spyOn(client, 'appPrepare').mockResolvedValue({ before: { 'src/Other.tsx': 'abc' } });
    const record = vi.spyOn(client, 'appRecord').mockResolvedValue({ sha: 'a'.repeat(40), files: ['src/components/Toolbar.tsx'] });
    vi.spyOn(client, 'appVersions').mockResolvedValue([{ sha: 'a'.repeat(40), n: 1, title: 'убери иконку темы', prompt: 'убери иконку темы', time: 1, files: [{ path: 'src/components/Toolbar.tsx', status: 'M', additions: 0, deletions: 7 }], status: 'applied' }]);
    const rebuild = vi.spyOn(client, 'appRebuild').mockResolvedValue({ opId: 'rb1' });
    await agentSend('убери иконку темы с главного экрана');
    expect(prepare).toHaveBeenCalledWith('/src/prong');
    handleAgentEvent({ opId: 'app1', line: 'tool:Edit /src/prong/src/components/Toolbar.tsx' } as any);
    handleAgentEvent({ opId: 'app1', done: true } as any);
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledWith('/src/prong'));
    expect(record).toHaveBeenCalledWith('/src/prong', 'убери иконку темы с главного экрана', { 'src/Other.tsx': 'abc' });
    expect(getState().agent.status).toBe('Rebuilding the interface…');
    expect(getState().agent.versions[0]).toMatchObject({ n: 1, sha: 'a'.repeat(40), status: 'applied', files: ['src/components/Toolbar.tsx'] });
    const msg = getState().agent.messages.at(-1)!;
    expect(msg.versionId).toBe(getState().agent.versions[0].id);
    expect(msg.actions?.at(-1)).toBe('version v1 · src/components/Toolbar.tsx');
    // the engine announces the new build: the run finishes with a notice (the window then reloads)
    handleEventForTest({ opId: 'ui', label: 'Interface rebuilt', event: 'ui-updated', done: true });
    expect(getState().agent.busy).toBe(false);
    expect(getState().agent.notices[0]).toMatchObject({ ok: true, title: 'Interface updated', target: 'app' });
  });

  it('a build that fails rolls the change back and says so', async () => {
    setState((s) => ({ engine: { ...s.engine, ui: 'static' }, agent: { ...s.agent, settings: { ...s.agent.settings, autoRollbackOnBuildError: true } } }));
    vi.spyOn(client, 'agentRun').mockResolvedValue({ opId: 'app2' });
    vi.spyOn(client, 'appRecord').mockResolvedValue({ sha: 'b'.repeat(40), files: ['src/x.tsx'] });
    vi.spyOn(client, 'appRebuild').mockResolvedValue({ opId: 'rb2' });
    const revert = vi.spyOn(client, 'appRevert').mockResolvedValue({ sha: 'c'.repeat(40) });
    await agentSend('сделай тулбар компактнее');
    handleAgentEvent({ opId: 'app2', done: true } as any);
    await vi.waitFor(() => expect(getState().agent.status).toBe('Rebuilding the interface…'));
    handleEventForTest({ opId: 'rb2', label: 'Rebuilding the interface', done: true, error: 'SyntaxError in src/x.tsx' });
    await vi.waitFor(() => expect(getState().agent.busy).toBe(false));
    expect(revert).toHaveBeenCalledWith('/src/prong', 'b'.repeat(40));
    expect(getState().agent.notices[0]).toMatchObject({ ok: false, title: 'Interface build failed' });
    expect(getState().agent.messages.at(-1)!.actions?.at(-1)).toMatch(/Interface build failed: SyntaxError.*rolled back/);
  });

  it('nothing changed: no version, no rebuild, a "No changes" notice', async () => {
    vi.spyOn(client, 'agentRun').mockResolvedValue({ opId: 'app3' });
    const rebuild = vi.spyOn(client, 'appRebuild');
    await agentSend('сделай тулбар компактнее');
    handleAgentEvent({ opId: 'app3', done: true } as any);
    await vi.waitFor(() => expect(getState().agent.busy).toBe(false));
    expect(rebuild).not.toHaveBeenCalled();
    expect(getState().agent.notices[0]).toMatchObject({ title: 'No changes' });
  });

  it('behind a dev server the change is recorded but not rebuilt (Metro reloads by itself)', async () => {
    setState((s) => ({ engine: { ...s.engine, ui: 'dev' } }));
    vi.spyOn(client, 'agentRun').mockResolvedValue({ opId: 'app4' });
    vi.spyOn(client, 'appRecord').mockResolvedValue({ sha: 'd'.repeat(40), files: ['src/y.tsx'] });
    const rebuild = vi.spyOn(client, 'appRebuild');
    await agentSend('сделай тулбар компактнее');
    handleAgentEvent({ opId: 'app4', done: true } as any);
    await vi.waitFor(() => expect(getState().agent.busy).toBe(false));
    expect(rebuild).not.toHaveBeenCalled();
    expect(getState().agent.notices[0]).toMatchObject({ ok: true, title: 'Interface updated' });
  });

  it('when the agent names the target it is already in, the request is asked once more, then given up', async () => {
    const run = vi.spyOn(client, 'agentRun').mockResolvedValueOnce({ opId: 'm1' }).mockResolvedValueOnce({ opId: 'm2' });
    await agentSend('убери иконку темы с главного экрана');
    handleAgentEvent({ opId: 'm1', line: 'text:PRONG_TARGET: app' } as any);
    handleAgentEvent({ opId: 'm1', done: true } as any);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0)); // the second run is registered after agentRun resolves
    expect(run.mock.calls[1][0]).toMatch(/^убери иконку темы с главного экрана\n\n\(You are already working in Prong's own sources/);
    expect(run.mock.calls[1][2]).toBe('app');
    handleAgentEvent({ opId: 'm2', line: 'text:PRONG_TARGET: app' } as any);
    handleAgentEvent({ opId: 'm2', done: true } as any);
    expect(getState().agent.notices[0]).toMatchObject({ ok: false, title: 'Failed' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not bounce when the user pinned the target', async () => {
    const run = vi.spyOn(client, 'agentRun').mockResolvedValue({ opId: 'op3' });
    setState((s) => ({ agent: { ...s.agent, target: 'repo' } }));
    await agentSend('сделай сайдбар шире');
    expect(run).toHaveBeenLastCalledWith('сделай сайдбар шире', '/w/a', 'repo', true, undefined);
    handleAgentEvent({ opId: 'op3', line: 'text:PRONG_TARGET: app' } as any);
    handleAgentEvent({ opId: 'op3', done: true } as any);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    // nothing was done: the user is told, not shown a success
    expect(getState().agent.notices[0]).toMatchObject({ ok: false, title: 'Failed' });
    expect(getState().agent.messages.at(-1)?.text).toMatch(/цели «app»/);
  });
});

describe('store: agent requests without Claude Code, cards, clearing', () => {
  beforeEach(() => {
    setState({ engine: { online: true, git: 'git', version: '1' }, repos: [liveInfo('/w/a')], tabs: ['live:/w/a'], activeTab: 'live:/w/a', operation: null });
    setState((s) => ({ agentAvailable: { ok: false, path: null, version: '' }, agent: { ...s.agent, busy: false, open: false, tab: 'chat', status: null, startedAt: null, notices: [], messages: [], session: null, target: 'auto', settings: { ...s.agent.settings, provider: 'anthropic-claude-code' } } }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('with the engine up but no Claude Code, a request says so and nothing runs (the demo agent ran its git in the repository)', () => {
    const run = vi.spyOn(client, 'agentRun');
    sendFromUi('создай ветку from-a-demo');
    const a = getState().agent;
    expect(run).not.toHaveBeenCalled();
    expect(a.busy).toBe(false);
    expect(a.messages.at(-1)).toMatchObject({ role: 'agent' });
    expect(a.messages.at(-1)!.text).toMatch(/Claude Code не найден/);
    expect(a.notices[0]).toMatchObject({ ok: false, title: 'No Claude Code' });
    setState((s) => ({ agent: { ...s.agent, settings: { ...s.agent.settings, provider: 'anthropic-api' } } }));
    sendFromUi('создай ветку from-another-provider');
    expect(getState().agent.notices[0]).toMatchObject({ ok: false, title: 'No agent for this provider' });
  });

  it('cards that came back after an interface reload keep their own ids: a new card never shares one', () => {
    setState((s) => ({ agent: { ...s.agent, notices: [{ id: 7, msgId: 1, ok: true, title: 'Interface updated', text: 'v1', actions: [], time: 1 }], messages: [{ id: 50, role: 'agent', text: 'a', time: 1 }, { id: 51, role: 'agent', text: 'b', time: 2 }] } }));
    finishAgentRun(50, { ok: true });
    finishAgentRun(51, { ok: true });
    const ids = getState().agent.notices.map((n) => n.id);
    expect(new Set(ids).size).toBe(3);
    dismissAgentNotice(7);
    expect(getState().agent.notices.map((n) => n.text)).toEqual(['b', 'a']);
  });

  it('a run that ends while the panel shows Changes or Settings still leaves a card; on the Chat tab it does not', () => {
    setState((s) => ({ agent: { ...s.agent, open: true, tab: 'settings', messages: [{ id: 60, role: 'agent', text: 'done', time: 1 }] } }));
    finishAgentRun(60, { ok: true });
    expect(getState().agent.notices).toHaveLength(1);
    setState((s) => ({ agent: { ...s.agent, tab: 'chat', notices: [] } }));
    finishAgentRun(60, { ok: true });
    expect(getState().agent.notices).toHaveLength(0);
  });

  it('the chat is not cleared while a run goes on (its answer had nowhere to go)', () => {
    setState((s) => ({ agent: { ...s.agent, busy: true, messages: [{ id: 1, role: 'system', text: 'intro', time: 0 }, { id: 70, role: 'user', text: 'q', time: 1 }] } }));
    clearAgentChat();
    expect(getState().agent.messages).toHaveLength(2);
    setState((s) => ({ agent: { ...s.agent, busy: false } }));
    clearAgentChat();
    expect(getState().agent.messages).toHaveLength(1);
  });
});
