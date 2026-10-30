import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';

/**
 * Abort of a merge or rebase stopped on conflicts goes back to where it started, all of it: the commit, the local
 * changes of that moment, edits made while the conflicts were open, the stash Prong set changes aside in.
 */
describe('abort: everything back as it was', () => {
  let root: string;
  let n = 0;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const write = (dir: string, f: string, t: string) => writeFileSync(path.join(dir, f), t);
  const read = (dir: string, f: string) => readFileSync(path.join(dir, f), 'utf8');
  const commit = (dir: string, f: string, t: string, m: string) => {
    write(dir, f, t);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', m);
  };
  /** main and side changing c.txt both ways (a conflict), side also changing clean.txt */
  const fixture = () => {
    const dir = path.join(root, `r${++n}`);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'commit.gpgsign', 'false');
    write(dir, 'clean.txt', 'clean\n');
    write(dir, 'local.txt', 'local\n');
    commit(dir, 'c.txt', 'base\n', 'base');
    git(dir, 'switch', '-q', '-c', 'side');
    write(dir, 'clean.txt', 'clean from side\n');
    commit(dir, 'c.txt', 'side\n', 'side');
    git(dir, 'switch', '-q', 'main');
    commit(dir, 'c.txt', 'main\n', 'main');
    return dir;
  };
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-abort-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a merge: the local change of the start back, edits made during the conflicts gone — where git’s own abort refuses', async () => {
    const dir = fixture();
    const repo = new Repo(dir);
    const before = git(dir, 'rev-parse', 'HEAD');
    write(dir, 'local.txt', 'local, not committed\n');
    expect((await repo.withRollback(() => repo.merge('side'))).conflicts).toBe(true);
    // while the conflicts are open: clean.txt (merged in cleanly, staged) edited again — `git merge --abort` refuses
    write(dir, 'clean.txt', 'edited during the conflict\n');
    write(dir, 'c.txt', 'half resolved\n');
    const r = await repo.abortOp();
    expect(r).toMatchObject({ kind: 'merge', restored: true });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(path.join(dir, '.git/MERGE_HEAD'))).toBe(false);
    expect(read(dir, 'clean.txt')).toBe('clean\n');
    expect(read(dir, 'c.txt')).toBe('main\n');
    expect(read(dir, 'local.txt')).toBe('local, not committed\n');
    expect(git(dir, 'status', '--porcelain')).toBe('M local.txt');
    expect(existsSync(path.join(dir, '.git/prong-rollback.json'))).toBe(false);
  });

  it('a rebase: back on the branch at its commit, an edit made during it gone', async () => {
    const dir = fixture();
    const repo = new Repo(dir);
    const before = git(dir, 'rev-parse', 'main');
    expect((await repo.withRollback(() => repo.rebase('side'))).conflicts).toBe(true);
    write(dir, 'local.txt', 'edited during the rebase\n');
    await repo.abortOp();
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect((await repo.opState()).kind).toBe('none');
  });

  it('started outside Prong and git refuses: said so; with force, back to the start', async () => {
    const dir = fixture();
    const repo = new Repo(dir);
    const before = git(dir, 'rev-parse', 'HEAD');
    try {
      git(dir, 'merge', 'side');
    } catch {
      /* conflicts */
    }
    write(dir, 'clean.txt', 'edited during the conflict\n');
    await expect(repo.abortOp()).rejects.toThrow(/git could not abort the merge[\s\S]*Abort anyway/);
    expect((await repo.opState()).kind).toBe('merge');
    await repo.abortOp({ force: true });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect((await repo.opState()).kind).toBe('none');
  });

  it('the Checkout dialog’s rebase and its stash: Abort pops the stash; finishing it pops it too', async () => {
    const dir = fixture();
    const repo = new Repo(dir);
    write(dir, 'local.txt', 'wip\n');
    const r = await repo.switchBranch({ ref: 'main', stash: true, integrate: { mode: 'rebase', from: 'side' } });
    expect(r.stopped).toBe(true);
    expect(git(dir, 'stash', 'list')).toMatch(/Prong: before switching to main/);
    const a = await repo.abortOp();
    expect(a.popped).toBe(true);
    expect(read(dir, 'local.txt')).toBe('wip\n');
    expect(git(dir, 'stash', 'list')).toBe('');
    // the same, finished instead: resolved, continued — the stash comes back then
    await repo.switchBranch({ ref: 'main', stash: true, integrate: { mode: 'rebase', from: 'side' } });
    write(dir, 'c.txt', 'resolved\n');
    git(dir, 'add', 'c.txt');
    const c = await repo.continueOp();
    expect(c.conflicts).toBe(false);
    expect(await repo.settleRollback()).toMatchObject({ popped: true });
    expect(read(dir, 'local.txt')).toBe('wip\n');
    expect(git(dir, 'stash', 'list')).toBe('');
  });

  it('nothing stopped: no note is left behind', async () => {
    const dir = fixture();
    const repo = new Repo(dir);
    git(dir, 'switch', '-q', '-c', 'ff', 'main~1');
    await repo.withRollback(() => repo.merge('main'));
    expect(existsSync(path.join(dir, '.git/prong-rollback.json'))).toBe(false);
    await expect(repo.abortOp()).rejects.toThrow(/No merge, rebase/);
  });
});
