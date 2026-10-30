import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';

/** The pull, push and sync buttons of a branch row: a branch that is not checked out, and the current one with local changes. */
describe('branch pull and sync', () => {
  let root: string;
  let origin: string;
  let n = 0;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commit = (cwd: string, file: string, text: string, msg: string) => {
    writeFileSync(path.join(cwd, file), text);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', msg);
  };
  const clone = () => {
    const dir = path.join(root, `c${++n}`);
    execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'pipe' });
    git(dir, 'config', 'commit.gpgsign', 'false');
    return dir;
  };
  const sha = (cwd: string, ref: string) => git(cwd, 'rev-parse', ref);
  const remoteSha = (branch: string) => git(origin, 'rev-parse', `refs/heads/${branch}`);
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-branch-sync-'));
    origin = path.join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const seed = clone();
    commit(seed, 'a.txt', 'a\n', 'a');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    git(seed, 'push', '-q', 'origin', 'HEAD:feature');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a clone knows its remote’s default branch: origin/HEAD names it', async () => {
    const refs = await new Repo(clone()).refs();
    expect(refs.find((r) => r.name === 'origin/HEAD')?.target).toBe('origin/main');
    expect(refs.find((r) => r.name === 'main')?.target).toBeUndefined();
  });

  it('pull into a branch that is not checked out: fast-forwarded when behind, left when ahead, refused when it went both ways', async () => {
    const work = clone();
    git(work, 'branch', '--track', 'feature', 'origin/feature');
    const other = clone();
    git(other, 'switch', '-q', 'feature');
    commit(other, 'f.txt', 'f\n', 'feature work');
    git(other, 'push', '-q', 'origin', 'feature');
    const repo = new Repo(work);
    const said: string[] = [];
    expect(await repo.fastForwardBranch('feature', (l) => said.push(l))).toBe('updated');
    expect(sha(work, 'feature')).toBe(remoteSha('feature'));
    expect(sha(work, 'origin/feature')).toBe(remoteSha('feature'));
    expect(said.join('\n')).toMatch(/feature fast-forwarded to origin\/feature \(1 commit\)/);
    // still on main, the work tree untouched
    expect(git(work, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(existsSync(path.join(work, 'f.txt'))).toBe(false);
    expect(await repo.fastForwardBranch('feature')).toBe('up-to-date');
    // a commit of its own: ahead, nothing to pull
    git(work, 'switch', '-q', 'feature');
    commit(work, 'mine.txt', 'm\n', 'mine');
    git(work, 'switch', '-q', 'main');
    const mine = sha(work, 'feature');
    expect(await repo.fastForwardBranch('feature')).toBe('ahead');
    expect(sha(work, 'feature')).toBe(mine);
    // and someone else's too: diverged
    commit(other, 'g.txt', 'g\n', 'more feature work');
    git(other, 'push', '-q', 'origin', 'feature');
    await expect(repo.fastForwardBranch('feature')).rejects.toThrow(/have diverged: check out feature/);
    expect(sha(work, 'feature')).toBe(mine);
  });

  it('pull into a branch: the checked-out one and one tracking nothing are refused', async () => {
    const work = clone();
    const repo = new Repo(work);
    await expect(repo.fastForwardBranch('main')).rejects.toThrow(/main is checked out/);
    git(work, 'branch', 'loose');
    await expect(repo.fastForwardBranch('loose')).rejects.toThrow(/tracks no remote branch/);
    await expect(repo.syncBranch('loose')).rejects.toThrow(/tracks no remote branch/);
  });

  it('sync a branch that is not checked out: pushed when ahead, fast-forwarded when behind', async () => {
    const work = clone();
    git(work, 'branch', '--track', 'feature', 'origin/feature');
    git(work, 'switch', '-q', 'feature');
    commit(work, 'sync-ahead.txt', 's\n', 'ahead');
    git(work, 'switch', '-q', 'main');
    const repo = new Repo(work);
    await repo.syncBranch('feature');
    expect(remoteSha('feature')).toBe(sha(work, 'feature'));
    const other = clone();
    git(other, 'switch', '-q', 'feature');
    commit(other, 'sync-behind.txt', 'b\n', 'behind');
    git(other, 'push', '-q', 'origin', 'feature');
    await repo.syncBranch('feature');
    expect(sha(work, 'feature')).toBe(remoteSha('feature'));
    expect(git(work, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('sync the current branch: local changes stashed, the remote’s work pulled, ours pushed, the changes back', async () => {
    const work = clone();
    const other = clone();
    commit(other, 'theirs.txt', 't\n', 'their work');
    git(other, 'push', '-q', 'origin', 'main');
    commit(work, 'ours.txt', 'o\n', 'our work');
    // an edit and a new file in the working tree
    writeFileSync(path.join(work, 'a.txt'), 'a\nedited\n');
    writeFileSync(path.join(work, 'new.txt'), 'new\n');
    const said: string[] = [];
    await new Repo(work).syncBranch('main', 'merge', (l) => said.push(l));
    expect(remoteSha('main')).toBe(sha(work, 'main'));
    expect(git(work, 'log', '--format=%s', 'main')).toMatch(/our work[\s\S]*their work|their work[\s\S]*our work/);
    expect(readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('a\nedited\n');
    expect(readFileSync(path.join(work, 'new.txt'), 'utf8')).toBe('new\n');
    expect(git(work, 'stash', 'list')).toBe('');
    expect(said).toEqual(expect.arrayContaining(['Stashed the local changes', 'Put the local changes back', 'main is in sync with origin/main']));
    // nothing changed and nothing new: a sync is harmless
    await new Repo(work).syncBranch('main', 'rebase');
    expect(git(work, 'stash', 'list')).toBe('');
  });

  it('sync stopped by conflicts in the pull: the local changes stay in the stash, said so', async () => {
    const work = clone();
    const other = clone();
    commit(other, 'c.txt', 'theirs\n', 'their c');
    git(other, 'push', '-q', 'origin', 'main');
    commit(work, 'c.txt', 'ours\n', 'our c');
    writeFileSync(path.join(work, 'wip.txt'), 'wip\n');
    await expect(new Repo(work).syncBranch('main', 'merge')).rejects.toThrow(/CONFLICT[\s\S]*Your local changes are in the stash \(“Prong: sync main”\)/);
    expect(git(work, 'stash', 'list')).toMatch(/Prong: sync main/);
    expect(existsSync(path.join(work, '.git', 'MERGE_HEAD'))).toBe(true);
    git(work, 'merge', '--abort');
  });

  it('sync where the local changes clash with what came in: pulled and pushed, the changes kept in the stash', async () => {
    const work = clone();
    const other = clone();
    commit(other, 'clash.txt', 'theirs\n', 'their clash');
    git(other, 'push', '-q', 'origin', 'main');
    commit(work, 'own.txt', 'own\n', 'our own');
    // not committed: the same file the pull brings
    writeFileSync(path.join(work, 'clash.txt'), 'ours\n');
    await expect(new Repo(work).syncBranch('main', 'rebase')).rejects.toThrow(/Pulled and pushed, but the local changes conflict/);
    expect(remoteSha('main')).toBe(sha(work, 'main'));
    expect(git(work, 'stash', 'list')).toMatch(/Prong: sync main/);
  });

  it('the Checkout dialog: a tracking branch made from a remote one; local changes stashed around a switch and put back', async () => {
    const work = clone();
    const other = clone();
    git(other, 'switch', '-q', '-c', 'made-here');
    commit(other, 'm.txt', 'm\n', 'made');
    git(other, 'push', '-q', 'origin', 'made-here');
    git(work, 'fetch', '-q', 'origin');
    writeFileSync(path.join(work, 'a.txt'), 'a\nwip\n');
    // a new file stays where it is (a checkout carries it); with `untracked` it goes to the stash and back too
    writeFileSync(path.join(work, 'untracked.txt'), 'u\n');
    const r = await new Repo(work).switchBranch({ ref: 'made-here', start: 'origin/made-here', stash: true, untracked: true });
    expect(r).toMatchObject({ name: 'made-here', stashed: true, reapplied: true, stopped: false });
    expect(git(work, 'symbolic-ref', '--short', 'HEAD')).toBe('made-here');
    expect(git(work, 'rev-parse', '--abbrev-ref', 'made-here@{upstream}')).toBe('origin/made-here');
    expect(readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('a\nwip\n');
    expect(readFileSync(path.join(work, 'untracked.txt'), 'utf8')).toBe('u\n');
    expect(git(work, 'stash', 'list')).toBe('');
  });

  it('the Checkout dialog: a branch behind its remote one merged or rebased on the way; conflicts stop there with the changes in the stash', async () => {
    const work = clone();
    git(work, 'branch', '--track', 'feature', 'origin/feature');
    const other = clone();
    git(other, 'switch', '-q', 'feature');
    commit(other, 'up.txt', 'up\n', 'feature moves on');
    git(other, 'push', '-q', 'origin', 'feature');
    git(work, 'fetch', '-q', 'origin');
    const repo = new Repo(work);
    expect(await repo.switchBranch({ ref: 'feature', integrate: { mode: 'merge', from: 'origin/feature' } })).toMatchObject({ name: 'feature', stopped: false });
    expect(sha(work, 'feature')).toBe(sha(work, 'origin/feature'));
    // a commit of ours and one of theirs on the same file: the rebase stops, the local change waits in the stash
    git(work, 'switch', '-q', 'main');
    git(work, 'switch', '-q', 'feature');
    commit(work, 'up.txt', 'ours\n', 'ours');
    commit(other, 'up.txt', 'theirs\n', 'theirs');
    git(other, 'push', '-q', 'origin', 'feature');
    git(work, 'fetch', '-q', 'origin');
    git(work, 'switch', '-q', 'main');
    writeFileSync(path.join(work, 'a.txt'), 'a\nwip\n');
    const r = await repo.switchBranch({ ref: 'feature', stash: true, integrate: { mode: 'rebase', from: 'origin/feature' } });
    expect(r).toMatchObject({ stashed: true, stopped: true });
    expect(r.output).toMatch(/Your local changes are in the stash/);
    expect(git(work, 'stash', 'list')).toMatch(/Prong: before switching to feature/);
    expect((await repo.opState()).kind).toBe('rebase');
    git(work, 'rebase', '--abort');
  });

  it('the Checkout dialog: a rebase with changes kept in the working tree does not start; the switch is said, nothing lost', async () => {
    const work = clone();
    git(work, 'branch', '--track', 'feature', 'origin/feature');
    git(work, 'switch', '-q', 'feature');
    commit(work, 'own.txt', 'own\n', 'own');
    git(work, 'switch', '-q', 'main');
    const other = clone();
    git(other, 'switch', '-q', 'feature');
    commit(other, 'more.txt', 'more\n', 'more');
    git(other, 'push', '-q', 'origin', 'feature');
    git(work, 'fetch', '-q', 'origin');
    writeFileSync(path.join(work, 'a.txt'), 'a\nkept\n');
    await expect(new Repo(work).switchBranch({ ref: 'feature', integrate: { mode: 'rebase', from: 'origin/feature' } })).rejects.toThrow(/Switched to feature, but the rebase of origin\/feature did not start/);
    expect(git(work, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
    expect(readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('a\nkept\n');
  });
});

