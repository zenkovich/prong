import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';
import { runGit } from '../src/git/run.js';
import { scanRepos } from '../src/scan.js';
import { loadSettings, loadWorkspaces, saveSettings, saveWorkspaces } from '../src/state.js';
import { listSshKeys } from '../src/system.js';
import { checkClaude } from '../src/agent.js';
import { makeFixtureRepo } from './fixture.js';

describe('scanRepos', () => {
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-scan-'));
    for (const d of ['a', 'b/c', 'node_modules/x', 'd/e/f/g', 'a/sub']) {
      mkdirSync(path.join(root, d), { recursive: true });
      await runGit(['init', '-q', path.join(root, d)], { cwd: root });
    }
    mkdirSync(path.join(root, 'plain'), { recursive: true });
    writeFileSync(path.join(root, 'plain', 'x.txt'), 'x');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds repositories up to the given depth and skips node_modules', () => {
    const found = scanRepos(root, 3).map((r) => path.relative(root, r.path));
    expect(found).toEqual(['a', 'b/c']); // a/sub is inside repository a and is not reported
    expect(scanRepos(root, 4).map((r) => path.relative(root, r.path))).toContain('d/e/f/g');
  });
  it('returns nothing for a missing folder', () => {
    expect(scanRepos(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('submodules', () => {
  let root: string;
  let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-sub-'));
    fx = await makeFixtureRepo(root);
    // the bare origin of the fixture serves as the submodule source
    await fx.repo.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', fx.bare, 'vendor/lib']);
    await fx.repo.commit('Add submodule');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists submodules with state and shows their commits in diffs', async () => {
    const subs = await fx.repo.submodules();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ path: 'vendor/lib', name: 'vendor/lib', state: 'ok' });
    expect(subs[0].sha).toMatch(/^[0-9a-f]{40}$/);
    const names = await fx.repo.submoduleCommits('vendor/lib', [subs[0].sha]);
    expect(Object.keys(names)).toEqual([subs[0].sha]);
  });

  it('reports a moved submodule pointer as a submodule change', async () => {
    const sub = new Repo(path.join(fx.dir, 'vendor/lib'));
    await sub.setConfig('user.name', 'T');
    await sub.setConfig('user.email', 't@x');
    writeFileSync(path.join(fx.dir, 'vendor/lib/inner.txt'), 'inner\n');
    await sub.stageAll();
    await sub.commit('inner change');
    const st = await fx.repo.status();
    const f = st.unstaged.find((x) => x.path === 'vendor/lib');
    expect(f?.kind).toBe('submodule');
    const subs = await fx.repo.submodules();
    expect(subs[0].state).toBe('modified');
    const d = await fx.repo.fileDiff('vendor/lib', 'unstaged');
    expect(d?.kind).toBe('submodule');
    expect(d?.submodule?.before).toMatch(/^[0-9a-f]{40}$/);
    expect(d?.submodule?.after).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('state files', () => {
  it('round-trips workspaces and settings under PRONG_STATE_DIR', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prong-state-'));
    const prev = process.env.PRONG_STATE_DIR;
    process.env.PRONG_STATE_DIR = dir;
    try {
      expect(loadWorkspaces().map((w) => w.id)).toEqual(['work', 'home']);
      saveWorkspaces([{ id: 'x', name: 'X', rootPath: '/tmp/x', scanDepth: 2 }]);
      expect(loadWorkspaces()[0]).toMatchObject({ id: 'x', rootPath: '/tmp/x' });
      const s = loadSettings();
      expect(s.agent.provider).toBe('anthropic-claude-code');
      saveSettings({ ...s, editor: 'Zed', agent: { ...s.agent, model: 'claude-fable-5-1' } });
      expect(loadSettings()).toMatchObject({ editor: 'Zed', pullMode: 'rebase', agent: { model: 'claude-fable-5-1', provider: 'anthropic-claude-code' } });
    } finally {
      if (prev === undefined) delete process.env.PRONG_STATE_DIR;
      else process.env.PRONG_STATE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('system services', () => {
  it('lists ssh keys with fingerprints (whatever the machine has)', async () => {
    const keys = await listSshKeys();
    expect(Array.isArray(keys)).toBe(true);
    for (const k of keys) {
      expect(k.publicKey.length).toBeGreaterThan(20);
      expect(typeof k.inAgent).toBe('boolean');
    }
  });
  it('reports whether Claude Code is available', async () => {
    const c = await checkClaude();
    expect(typeof c.ok).toBe('boolean');
    if (c.ok) expect(c.version).toMatch(/\d+\.\d+/);
  });
});

describe('snapshot performance paths', () => {
  it('caches the log by ref signature and reports timings', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prong-perf-'));
    try {
      const fx = await makeFixtureRepo(root);
      const s1 = await fx.repo.snapshot(300);
      expect(s1.timings.total).toBeGreaterThanOrEqual(0);
      const s2 = await fx.repo.snapshot(300);
      expect(s2.commits).toBe(s1.commits); // same array instance → served from the in-memory cache
      fx.write('perf.txt', 'x\n');
      await fx.repo.stageAll();
      await fx.repo.commit('perf');
      const s3 = await fx.repo.snapshot(300);
      expect(s3.commits).not.toBe(s1.commits);
      expect(s3.commits[0].subject).toBe('perf');
      expect(await fx.repo.config('core.fsmonitor')).toBe('true');
      const page = await fx.repo.logPage(1, 2);
      expect(page.map((c) => c.sha)).toEqual(s3.commits.slice(1, 3).map((c) => c.sha));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
