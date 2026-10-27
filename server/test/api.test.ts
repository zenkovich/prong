import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { makeFixtureRepo } from './fixture.js';

describe('HTTP API', () => {
  let root: string;
  let base: string;
  let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
  let close: () => void;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-api-'));
    process.env.PRONG_STATE_DIR = path.join(root, 'state');
    // an engine for tests: secrets in its state folder, never the user's Keychain (the accounts check reads them)
    process.env.PRONG_TEST_MODE = '1';
    fx = await makeFixtureRepo(root);
    const { server } = createApi();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => {
    close();
    rmSync(root, { recursive: true, force: true });
  });

  const post = async (p: string, body: unknown) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  it('a repository’s connection: set, inherited by what is inside it, tested, cleared', async () => {
    const ssh = path.join(root, 'ssh');
    mkdirSync(ssh, { recursive: true });
    writeFileSync(path.join(ssh, 'work_key'), 'x\n');
    process.env.PRONG_SSH_DIR = ssh;
    try {
      // the fixture repository and a repository inside its folder (as a submodule would be)
      const inner = path.join(fx.dir, 'libs/inner');
      mkdirSync(inner, { recursive: true });
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['init', '-q', inner]);
      expect((await post('/api/repo/setAuth', { path: fx.dir, auth: { kind: 'ssh', key: 'work_key' } })).status).toBe(200);
      const own = (await post('/api/repo/authInfo', { path: fx.dir })).body;
      expect(own.own).toEqual({ kind: 'ssh', key: 'work_key' });
      expect(own.describe).toBe('SSH key work_key');
      const sub = (await post('/api/repo/authInfo', { path: inner })).body;
      expect(sub.own).toBeNull();
      expect(sub.inherited).toMatchObject({ auth: { kind: 'ssh', key: 'work_key' }, from: fx.dir });
      // unknown keys and accounts, keys outside the SSH folder: refused
      expect((await post('/api/repo/setAuth', { path: fx.dir, auth: { kind: 'ssh', key: '../../etc/passwd' } })).status).toBe(400);
      expect((await post('/api/repo/setAuth', { path: fx.dir, auth: { kind: 'account', account: 'github.com:nobody' } })).status).toBe(400);
      // the fixture's remote is a local folder: the test reaches it whatever the credentials
      const test = (await post('/api/repo/testAuth', { path: fx.dir, remote: 'origin', auth: null })).body;
      expect(test).toMatchObject({ ok: true, describe: 'system default' });
      expect((await post('/api/repo/testAuth', { path: fx.dir, remote: '--upload-pack=x' })).status).toBe(400);
      // cleared: nothing to inherit any more
      expect((await post('/api/repo/setAuth', { path: fx.dir, auth: null })).status).toBe(200);
      expect((await post('/api/repo/authInfo', { path: inner })).body.inherited).toBeNull();
    } finally {
      delete process.env.PRONG_SSH_DIR;
      rmSync(path.join(fx.dir, 'libs'), { recursive: true, force: true });
    }
  });

  it('keeps the session (tabs, branch filters) for the next launch', async () => {
    const put = (body: unknown) => fetch(base + '/api/session', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(await (await fetch(base + '/api/session')).json()).toEqual({});
    const session = { activeWorkspace: 'work', screen: 'repo', tabs: ['live:/r/a'], activeTab: 'live:/r/a', workspaceTabs: {}, filters: { 'live:/r/a': { mode: 'selected', refs: ['main'], hideRemotes: false } } };
    expect((await put(session)).status).toBe(200);
    expect(await (await fetch(base + '/api/session')).json()).toEqual(session);
    expect((await put([1, 2])).status).toBe(400);
    expect((await put({ big: 'x'.repeat(600 * 1024) })).status).toBe(400);
  });

  it('reports health', async () => {
    const r = await fetch(base + '/api/health').then((x) => x.json());
    expect(r.ok).toBe(true);
    expect(r.git).toMatch(/^git version/);
  });

  it('registers repositories and rejects non-repositories', async () => {
    const bad = await post('/api/repos/open', { path: root });
    expect(bad.status).toBe(400);
    const ok = await post('/api/repos/open', { path: fx.dir, workspace: 'home' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: 'work', workspace: 'home' });
    const list = await fetch(base + '/api/repos').then((x) => x.json());
    expect(list[0].path).toBe(fx.dir);
  });

  it('scans a folder, registers top-level repositories and drops auto-registered entries it no longer finds', async () => {
    const scanRoot = path.join(root, 'scan');
    for (const d of ['top', 'top/vendor-lib']) {
      mkdirSync(path.join(scanRoot, d), { recursive: true });
      await fx.repo.git(['init', '-q', path.join(scanRoot, d)]);
    }
    // an entry a previous scan registered while nested checkouts were still reported
    const stateFile = path.join(process.env.PRONG_STATE_DIR!, 'repos.json');
    const before = await fetch(base + '/api/repos').then((x) => x.json());
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify([
      ...before,
      { path: path.join(scanRoot, 'top/vendor-lib'), name: 'vendor-lib', workspace: 'work', lastOpened: 0 }, // nested checkout
      { path: path.join(scanRoot, 'gone'), name: 'gone', workspace: 'work', lastOpened: 0 }, // folder deleted since
      { path: path.join(scanRoot, 'top/opened'), name: 'opened', workspace: 'work', lastOpened: 5 }, // opened by the user: kept
    ]));
    const r = await post('/api/scan', { path: scanRoot, depth: 3, register: true, workspace: 'work' });
    expect(r.body.map((x: any) => x.name)).toEqual(['top']);
    const list: any[] = await fetch(base + '/api/repos').then((x) => x.json());
    const names = list.filter((x) => x.path.startsWith(scanRoot)).map((x) => x.name);
    expect(names.sort()).toEqual(['opened', 'top']);
    expect(list.some((x) => x.path === fx.dir)).toBe(true); // repositories outside the scanned root are untouched
  });

  it('lists a repository in every workspace whose scan finds it, and keeps the owner workspace for manual entries', async () => {
    const scanRoot = path.join(root, 'scan');
    await post('/api/scan', { path: scanRoot, depth: 3, register: true, workspace: 'home' });
    let list: any[] = await fetch(base + '/api/repos').then((x) => x.json());
    let top = list.find((x) => x.name === 'top');
    expect(top.workspace).toBe('work'); // first registered by the work scan
    expect(top.workspaces.sort()).toEqual(['home', 'work']); // both scans find it
    expect(list.find((x) => x.name === 'opened').workspaces).toEqual([]); // opened by hand, never found by a scan (folder missing)
    // the same folder scanned again from work changes nothing
    await post('/api/scan', { path: scanRoot, depth: 3, register: true, workspace: 'work' });
    list = await fetch(base + '/api/repos').then((x) => x.json());
    expect(list.find((x) => x.name === 'top').workspaces.sort()).toEqual(['home', 'work']);
    // a scan of a different folder from home removes nothing under the other root
    await post('/api/scan', { path: path.join(root, 'elsewhere'), depth: 1, register: true, workspace: 'home' });
    list = await fetch(base + '/api/repos').then((x) => x.json());
    expect(list.find((x) => x.name === 'top').workspaces.sort()).toEqual(['home', 'work']);
    // deleting the home workspace drops its membership everywhere
    await fetch(base + '/api/workspaces', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'work', name: 'work' }]) });
    list = await fetch(base + '/api/repos').then((x) => x.json());
    expect(list.find((x) => x.name === 'top').workspaces).toEqual(['work']);
    // moving a repository by hand changes its owner workspace only
    await post('/api/repos/move', { path: top.path, workspace: 'lab' });
    top = (await fetch(base + '/api/repos').then((x) => x.json())).find((x: any) => x.name === 'top');
    expect(top.workspace).toBe('lab');
    expect(top.workspaces).toEqual(['work']);
  });

  it('persists UI preferences and the avatars switch in settings', async () => {
    const put = async (body: unknown) => {
      const r = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return r.json();
    };
    const s0 = await fetch(base + '/api/settings').then((x) => x.json());
    expect(s0.ui).toMatchObject({ fileView: 'tree', theme: 'amber', uiScale: 1 });
    expect(s0.avatars).toBe(true);
    const s1 = await put({ ui: { fileView: 'list', uiScale: 1.25 } });
    expect(s1.ui).toMatchObject({ fileView: 'list', uiScale: 1.25, theme: 'amber' }); // merged, not replaced
    const s2 = await put({ avatars: false, ui: { theme: 'ice' } });
    expect(s2.ui).toMatchObject({ fileView: 'list', uiScale: 1.25, theme: 'ice' });
    expect(s2.avatars).toBe(false);
    const av = await fetch(base + '/api/avatar?email=test@example.com');
    expect(av.status).toBe(404); // disabled: no network request is made
    await put({ avatars: true });
    const none = await fetch(base + '/api/avatar?email=not-an-address');
    expect(none.status).toBe(404);
  });

  it('refuses the test stand-in as the agent of a real engine', async () => {
    const fake = path.resolve(__dirname, '../../tools/fake-claude.sh');
    const prev = process.env.PRONG_TEST_MODE;
    delete process.env.PRONG_TEST_MODE;
    try {
      const r = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: { cliPath: fake } }) });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/test stand-in/);
    } finally {
      if (prev !== undefined) process.env.PRONG_TEST_MODE = prev;
    }
  });

  it('stops a running agent and reports it as stopped', async () => {
    process.env.PRONG_TEST_MODE = '1';
    const fake = path.resolve(__dirname, '../../tools/fake-claude.sh');
    await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: { cliPath: fake } }) });
    const events: any[] = [];
    const ctl = new AbortController();
    const sse = await fetch(base + '/api/events', { signal: ctl.signal });
    const reader = sse.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let k;
          while ((k = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, k);
            buf = buf.slice(k + 2);
            const data = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (data) events.push(JSON.parse(data.slice(5)));
          }
        }
      } catch {
        /* aborted */
      }
    })();
    const run = await post('/api/agent/run', { prompt: 'slow task', cwd: fx.dir, mode: 'repo' });
    const opId = run.body.opId;
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
    };
    await until(() => events.some((e) => e.opId === opId && String(e.line ?? '').startsWith('tool:Bash')));
    expect(events.some((e) => e.opId === opId && e.line === 'tool:Read /repo/src/state/store.ts')).toBe(true);
    const c = await post('/api/ops/cancel', { opId });
    expect(c.status).toBe(200);
    await until(() => events.some((e) => e.opId === opId && e.done));
    expect(events.find((e) => e.opId === opId && e.done)?.error).toBe('Stopped');
    expect((await post('/api/ops/cancel', { opId })).status).toBe(404);
    ctl.abort();
    await pump;
  });

  it('the agent in a repository signs in with its connection (inherited by a submodule), knows it, continues a session', async () => {
    process.env.PRONG_TEST_MODE = '1';
    const ssh = path.join(root, 'ssh-agent');
    mkdirSync(ssh, { recursive: true });
    writeFileSync(path.join(ssh, 'team_key'), 'x\n');
    process.env.PRONG_SSH_DIR = ssh;
    const log = path.join(root, 'agent.log');
    process.env.PRONG_FAKE_AGENT_LOG = log;
    const fake = path.resolve(__dirname, '../../tools/fake-claude.sh');
    await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: { cliPath: fake } }) });
    try {
      const inner = path.join(fx.dir, 'libs/agent-inner');
      mkdirSync(inner, { recursive: true });
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['init', '-q', inner]);
      expect((await post('/api/repo/setAuth', { path: fx.dir, auth: { kind: 'ssh', key: 'team_key' } })).status).toBe(200);
      const events: any[] = [];
      const ctl = new AbortController();
      const sse = await fetch(base + '/api/events', { signal: ctl.signal });
      const reader = sse.body!.getReader();
      const pump = (async () => {
        const dec = new TextDecoder();
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let k;
            while ((k = buf.indexOf('\n\n')) >= 0) {
              const data = buf.slice(0, k).split('\n').find((l) => l.startsWith('data:'));
              buf = buf.slice(k + 2);
              if (data) events.push(JSON.parse(data.slice(5)));
            }
          }
        } catch {
          /* aborted */
        }
      })();
      const run = await post('/api/agent/run', { prompt: 'look around', cwd: inner, mode: 'repo', resume: 'prev-session-1234' });
      const opId = run.body.opId;
      for (let i = 0; i < 100 && !events.some((e) => e.opId === opId && e.done); i++) await new Promise((r) => setTimeout(r, 50));
      const { readFileSync } = await import('node:fs');
      const asked = readFileSync(log, 'utf8');
      // git inside the agent uses the parent's key; the agent is told so; the earlier session goes on
      expect(asked).toContain(`ssh: ssh -i '${path.join(ssh, 'team_key')}' -o IdentitiesOnly=yes`);
      expect(asked).toMatch(/system: .*connection for this repository \(and its submodules\): SSH key team_key/);
      expect(asked).toContain('resume: prev-session-1234');
      const result = events.find((e) => e.opId === opId && String(e.line ?? '').startsWith('result:'));
      expect(JSON.parse(result.line.slice('result:'.length)).sessionId).toBe('fake-session');
      ctl.abort();
      await pump;
    } finally {
      await post('/api/repo/setAuth', { path: fx.dir, auth: null });
      delete process.env.PRONG_FAKE_AGENT_LOG;
      rmSync(path.join(fx.dir, 'libs/agent-inner'), { recursive: true, force: true });
    }
  });

  it('says which accounts can no longer sign in, without asking GitHub when there is no sign-in to try', async () => {
    const { writeFileSync: write } = await import('node:fs');
    const state = process.env.PRONG_STATE_DIR!;
    mkdirSync(state, { recursive: true });
    // an account whose Keychain entry does not exist (a made-up id): its sign-in is gone
    write(path.join(state, 'accounts.json'), JSON.stringify([{ id: 'github.com:prong-test-nobody-7f3a', host: 'github.com', login: 'prong-test-nobody-7f3a', name: 'Nobody', orgs: [] }]));
    try {
      const r = await fetch(base + '/api/accounts/check');
      const body = await r.json();
      expect(body['github.com:prong-test-nobody-7f3a']).toMatchObject({ state: 'expired' });
      expect(body['github.com:prong-test-nobody-7f3a'].message).toMatch(/Sign in again under Accounts/);
    } finally {
      write(path.join(state, 'accounts.json'), '[]');
    }
  });

  it('clone: suggests the key of the owner\'s other repositories, checks the address read-only, registers the clone with the connection', async () => {
    const { execFileSync } = await import('node:child_process');
    const { readFileSync, existsSync } = await import('node:fs');
    const ssh = path.join(root, 'ssh-clone');
    mkdirSync(ssh, { recursive: true });
    writeFileSync(path.join(ssh, 'org_key'), 'x\n');
    process.env.PRONG_SSH_DIR = ssh;
    const prevOrigin = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: fx.dir }).toString().trim();
    try {
      // a registered repository of the organization, with its key
      execFileSync('git', ['remote', 'set-url', 'origin', 'git@github.com:Playrix/homescapes.git'], { cwd: fx.dir });
      expect((await post('/api/repo/setAuth', { path: fx.dir, auth: { kind: 'ssh', key: 'org_key' } })).status).toBe(200);
      const hint = (await post('/api/repos/cloneHint', { url: 'git@github.com:playrix/township.git' })).body;
      expect(hint).toEqual({ auth: { kind: 'ssh', key: 'org_key' }, from: path.basename(fx.dir) });
      expect((await post('/api/repos/cloneHint', { url: 'https://github.com/someone-else/thing.git' })).body).toBeNull();
      expect((await post('/api/repos/cloneHint', { url: '--upload-pack=touch /tmp/x' })).status).toBe(400);
      // the address checked before cloning (a local one: the key is not needed for it, the check is the same)
      const bare = path.join(root, 'clone-src.git');
      execFileSync('git', ['clone', '-q', '--bare', fx.dir, bare]);
      const test = (await post('/api/repos/cloneTest', { url: bare, auth: { kind: 'ssh', key: 'org_key' } })).body;
      expect(test).toMatchObject({ ok: true, describe: 'SSH key org_key' });
      expect((await post('/api/repos/cloneTest', { url: path.join(root, 'nothing-here.git'), auth: null })).body.ok).toBe(false);
      // cloned with the connection: registered with it, so fetch and push of the clone use it too
      const into = path.join(root, 'clones');
      mkdirSync(into, { recursive: true });
      const r = await post('/api/repos/clone', { url: bare, dir: into, name: 'township', recursive: false, auth: { kind: 'ssh', key: 'org_key' } });
      expect(r.status).toBe(200);
      const dest = path.join(into, 'township');
      for (let i = 0; i < 100 && !JSON.parse(readFileSync(path.join(process.env.PRONG_STATE_DIR!, 'repos.json'), 'utf8')).some((x: any) => x.path === dest); i++) await new Promise((res) => setTimeout(res, 50));
      expect(existsSync(path.join(dest, '.git'))).toBe(true);
      const entry = JSON.parse(readFileSync(path.join(process.env.PRONG_STATE_DIR!, 'repos.json'), 'utf8')).find((x: any) => x.path === dest);
      expect(entry.auth).toEqual({ kind: 'ssh', key: 'org_key' });
      // a partial clone: the history, file contents on demand (the source must allow filtering)
      execFileSync('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: bare });
      const r2 = await post('/api/repos/clone', { url: `file://${bare}`, dir: into, name: 'partial', recursive: false, partial: true });
      expect(r2.status).toBe(200);
      const dest2 = path.join(into, 'partial');
      for (let i = 0; i < 100 && !JSON.parse(readFileSync(path.join(process.env.PRONG_STATE_DIR!, 'repos.json'), 'utf8')).some((x: any) => x.path === dest2); i++) await new Promise((res) => setTimeout(res, 50));
      expect(execFileSync('git', ['config', '--get', 'remote.origin.partialclonefilter'], { cwd: dest2 }).toString().trim()).toBe('blob:none');
      expect(existsSync(path.join(dest2, 'a.txt')) || execFileSync('git', ['ls-files'], { cwd: dest2 }).toString().length > 0).toBe(true);
    } finally {
      execFileSync('git', ['remote', 'set-url', 'origin', prevOrigin], { cwd: fx.dir });
      await post('/api/repo/setAuth', { path: fx.dir, auth: null });
    }
  });

  it('the start screen’s list: each repository’s branch, pins kept, Remove from list stays removed under a scan, a move out of a scanned workspace sticks, opening brings it back', async () => {
    const { execFileSync } = await import('node:child_process');
    const scanRoot = path.join(root, 'scan-list');
    const keep = path.join(scanRoot, 'keep');
    mkdirSync(keep, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'trunk', keep]); // no commit yet: HEAD still names its branch
    const list = async () => (await fetch(base + '/api/repos').then((x) => x.json())) as any[];
    const entry = async () => (await list()).find((x) => x.path === keep);
    const scan = (ws: string) => post('/api/scan', { path: scanRoot, depth: 1, register: true, workspace: ws });
    await scan('work');
    expect((await entry())).toMatchObject({ branch: 'trunk', workspaces: ['work'] });
    // a pin is kept by the engine
    await post('/api/repos/pin', { path: keep, pinned: true });
    expect((await entry()).pinned).toBe(true);
    await post('/api/repos/pin', { path: keep, pinned: false });
    expect((await entry()).pinned).toBeUndefined();
    // removed from the list: gone, and the next scan of its folder does not add it again
    await post('/api/repos/forget', { path: keep });
    expect(await entry()).toBeUndefined();
    await scan('work');
    expect(await entry()).toBeUndefined();
    // opened again: listed again
    await post('/api/repos/open', { path: keep, workspace: 'work' });
    expect(await entry()).toMatchObject({ path: keep, workspace: 'work' });
    expect((await entry()).hidden).toBeUndefined();
    // moved out of work (whose scan finds it) into lab: work's scans stop listing it there, home's still do
    await scan('home');
    await post('/api/repos/move', { path: keep, workspace: 'lab', from: 'work' });
    await scan('work');
    let e = await entry();
    expect(e.workspace).toBe('lab');
    expect(e.workspaces).toEqual(['home']);
    // and moved back: work lists it again
    await post('/api/repos/move', { path: keep, workspace: 'work', from: 'lab' });
    await scan('work');
    e = await entry();
    expect(e.workspaces.sort()).toEqual(['home', 'work']);
    expect(e.excluded ?? []).not.toContain('work');
    await post('/api/repos/forget', { path: keep });
  });

  it('a repository with no commit yet: the snapshot names the branch its first commit makes', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = path.join(root, 'unborn-repo');
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'trunk', dir]);
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    const snap = (await post('/api/repo/snapshot', { path: dir })).body;
    expect(snap.head).toBe('');
    expect(snap.unborn).toBe('trunk');
    expect(snap.unstaged.map((f: any) => f.path)).toEqual(['a.txt']);
    expect((await post('/api/repo/snapshot', { path: fx.dir })).body.unborn).toBeUndefined();
  });

  it('clone: the folder name is one folder inside the parent, not a path', async () => {
    const into = path.join(root, 'clones-names');
    mkdirSync(into, { recursive: true });
    for (const name of ['../escape', 'a/b', '..', '.']) {
      const r = await post('/api/repos/clone', { url: fx.dir, dir: into, name, recursive: false });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/Not a folder name/);
    }
    // no name: the address's last part
    const r = await post('/api/repos/clone', { url: fx.dir + '/', dir: into, name: '', recursive: false });
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(path.join(into, path.basename(fx.dir)));
  });

  it('serves snapshots and executes staging/commit ops', async () => {
    const snap = await post('/api/repo/snapshot', { path: fx.dir });
    expect(snap.status).toBe(200);
    expect(snap.body.commits.length).toBe(6);
    fx.write('api.txt', 'api\n');
    const st = await post('/api/repo/status', { path: fx.dir });
    expect(st.body.unstaged.map((f: any) => f.path)).toEqual(['api.txt']);
    await post('/api/repo/stage', { path: fx.dir, paths: ['api.txt'] });
    const c = await post('/api/repo/commit', { path: fx.dir, message: 'via api' });
    expect(c.body.sha).toMatch(/^[0-9a-f]{40}$/);
    const files = await post('/api/repo/commitFiles', { path: fx.dir, sha: c.body.sha });
    expect(files.body[0]).toMatchObject({ path: 'api.txt', status: 'A' });
    const unknown = await post('/api/repo/nope', { path: fx.dir });
    expect(unknown.status).toBe(404);
  });

  it('rejects paths and revisions that could leave the repository or pass as options', async () => {
    for (const sub of ['../outside', '/etc', 'a/../../b']) {
      expect((await post('/api/repo/submoduleRange', { path: fx.dir, sub, before: '', after: '' })).status).toBe(400);
      expect((await post('/api/repo/submoduleCommits', { path: fx.dir, sub, shas: [] })).status).toBe(400);
    }
    expect((await post('/api/repo/commitFileDiff', { path: fx.dir, rev: '--output=/tmp/x', file: 'a.txt' })).status).toBe(400);
    expect((await post('/api/repo/logPage', { path: fx.dir, skip: 0, limit: 5, revs: ['--output=/tmp/x'] })).status).toBe(400);
    expect((await post('/api/repo/logFile', { path: fx.dir, file: 'a.txt', from: '--all' })).status).toBe(400);
  });

  it('streams progress events for long operations', async () => {
    const events: any[] = [];
    const ctrl = new AbortController();
    const stream = fetch(base + '/api/events', { signal: ctrl.signal }).then(async (r) => {
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const p of parts) if (p.startsWith('data: ')) events.push(JSON.parse(p.slice(6)));
      }
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    const r = await post('/api/repo/push', { path: fx.dir });
    expect(r.body.opId).toMatch(/^op/);
    const deadline = Date.now() + 10000;
    while (!events.some((e) => e.opId === r.body.opId && e.done) && Date.now() < deadline) await new Promise((x) => setTimeout(x, 50));
    const done = events.find((e) => e.opId === r.body.opId && e.done);
    expect(done).toBeTruthy();
    expect(done.error).toBeUndefined();
    ctrl.abort();
    await stream;
    const snap = await post('/api/repo/snapshot', { path: fx.dir });
    expect(snap.body.refs.find((x: any) => x.name === 'main').ahead).toBe(0);
  });
});
