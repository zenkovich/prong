import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePushPorcelain, Repo } from '../src/git/repo.js';

/** Several branches at once: delete (local, with their remote twins, remote only) and push. */
describe('batch branch operations', () => {
  let root: string;
  let dir: string;
  let origin: string;
  let repo: Repo;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commit = (msg: string) => {
    writeFileSync(path.join(dir, `${msg}.txt`), msg);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', msg);
  };
  const branches = () => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes').split('\n').filter(Boolean).sort();
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-batch-'));
    origin = path.join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    dir = path.join(root, 'work');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'remote', 'add', 'origin', origin);
    commit('base');
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    for (const b of ['done/a', 'done/b', 'only-remote']) {
      git(dir, 'branch', b);
      git(dir, 'push', '-q', '-u', 'origin', b);
    }
    // an unmerged branch: its commit is nowhere else
    git(dir, 'switch', '-q', '-c', 'wip');
    commit('wip');
    git(dir, 'switch', '-q', 'main');
    repo = new Repo(dir);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('deletes merged branches with their remote twins and reports the unmerged one', async () => {
    const r = await repo.deleteBranches(['done/a', 'done/b', 'wip'], false, true);
    expect(r.done.sort()).toEqual(['done/a', 'done/b', 'origin/done/a', 'origin/done/b']);
    expect(r.failed.map((f) => f.name)).toEqual(['wip']);
    expect(r.failed[0].error).toMatch(/not fully merged/);
    expect(branches()).toEqual(['main', 'only-remote', 'origin', 'origin/main', 'origin/only-remote', 'wip'].filter((b) => b !== 'origin').sort());
    expect(git(origin, 'branch', '--list')).not.toMatch(/done\//);
    // forced, the unmerged one goes too
    expect((await repo.deleteBranches(['wip'], true, false)).done).toEqual(['wip']);
  });

  it('deletes remote branches in one push per remote; one already gone only loses its stale ref', async () => {
    git(origin, 'branch', 'stale', 'main');
    git(dir, 'fetch', '-q', 'origin');
    git(origin, 'branch', '-D', 'stale'); // gone on the server, still known here
    const r = await repo.deleteRemoteBranches(['origin/only-remote', 'origin/stale', 'nowhere/x']);
    expect(r.done.sort()).toEqual(['origin/only-remote', 'origin/stale']);
    expect(r.failed).toEqual([{ name: 'nowhere/x', error: 'not a remote branch' }]);
    expect(branches()).not.toContain('origin/stale');
    expect(git(origin, 'branch', '--list')).not.toMatch(/only-remote/);
  });

  it('pushes several branches at once with upstreams; a rejected one is reported', async () => {
    git(dir, 'branch', 'p1');
    git(dir, 'branch', 'p2');
    // p3 exists on the server with other history: a non-fast-forward
    git(dir, 'switch', '-q', '-c', 'p3');
    commit('p3-local');
    git(dir, 'switch', '-q', 'main');
    const other = path.join(root, 'other');
    execFileSync('git', ['clone', '-q', origin, other], { stdio: 'pipe' });
    git(other, 'config', 'commit.gpgsign', 'false');
    git(other, 'switch', '-q', '-c', 'p3');
    writeFileSync(path.join(other, 'x.txt'), 'x');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'p3-remote');
    git(other, 'push', '-q', 'origin', 'p3');
    const r = await repo.pushBranches(['p1', 'p2', 'p3'], 'origin');
    expect(r.done.sort()).toEqual(['p1', 'p2']);
    expect(r.failed.map((f) => f.name)).toEqual(['p3']);
    expect(r.failed[0].error).toMatch(/rejected|fetch first|non-fast-forward/);
    expect(git(dir, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/p1')).toBe('origin/p1');
  });

  it('reads push porcelain lines', () => {
    const m = parsePushPorcelain('To /x\n-\t:refs/heads/a\t[deleted]\n!\trefs/heads/b:refs/heads/b\t[rejected] (fetch first)\n*\trefs/heads/c:refs/heads/c\t[new branch]\nDone\n');
    expect(m.get('refs/heads/a')).toEqual({ ok: true, summary: '[deleted]' });
    expect(m.get('refs/heads/b')).toEqual({ ok: false, summary: '[rejected] (fetch first)' });
    expect(m.get('refs/heads/c')?.ok).toBe(true);
  });
});
