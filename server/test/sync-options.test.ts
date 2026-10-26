import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';

/** The options of the Fetch, Pull and Push dialogs (as in Fork), against a real origin. */
describe('fetch, pull and push options', () => {
  let root: string;
  let origin: string;
  let seed: string;
  let work: string;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commit = (cwd: string, file: string, text: string, msg: string) => {
    writeFileSync(path.join(cwd, file), text);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', msg);
  };
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-sync-'));
    origin = path.join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    seed = path.join(root, 'seed');
    execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'pipe' });
    git(seed, 'config', 'commit.gpgsign', 'false');
    commit(seed, 'a.txt', 'a\n', 'a');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    work = path.join(root, 'work');
    execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' });
    git(work, 'config', 'commit.gpgsign', 'false');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('fetch: "all tags" brings tags off the fetched branches; pruning never drops local tags', async () => {
    // a tag on a commit no branch of origin reaches: auto-following never brings it
    git(seed, 'switch', '-q', '-c', 'side');
    commit(seed, 'side.txt', 's\n', 'side');
    git(seed, 'tag', 'v-side');
    git(seed, 'push', '-q', 'origin', 'v-side');
    git(seed, 'switch', '-q', 'main');
    git(work, 'tag', 'local-only');
    const repo = new Repo(work);
    await repo.fetch('--all', true);
    expect(git(work, 'tag', '--list')).not.toContain('v-side');
    await repo.fetch('origin', true, undefined, { tags: true });
    expect(git(work, 'tag', '--list').split('\n')).toEqual(expect.arrayContaining(['v-side', 'local-only']));
  });

  it('pull: a chosen branch of the remote into the current one; autostash carries local changes over', async () => {
    git(seed, 'switch', '-q', '-c', 'feature');
    commit(seed, 'a.txt', 'a\nfrom feature\n', 'feature work');
    git(seed, 'push', '-q', 'origin', 'feature');
    git(seed, 'switch', '-q', 'main');
    const repo = new Repo(work);
    // a local change to the file the pull changes: git refuses, --autostash stashes it and puts it back
    writeFileSync(path.join(work, 'a.txt'), 'a\nlocal\n');
    await expect(repo.pull('merge', undefined, { remote: 'origin', branch: 'feature' })).rejects.toThrow(/would be overwritten|commit your changes or stash/i);
    writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, 'checkout', '--', 'a.txt');
    commit(seed, 'c.txt', 'c\n', 'main moves'); // not pushed: the pull is from feature, not main
    await repo.pull('ff', undefined, { remote: 'origin', branch: 'feature', autostash: true });
    expect(git(work, 'log', '-1', '--format=%s')).toBe('feature work');
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(path.join(work, 'b.txt'), 'utf8')).toBe('b\n'); // the untracked file is untouched
    // with tracked local changes in the way
    git(seed, 'switch', '-q', 'feature');
    commit(seed, 'a.txt', 'a\nfrom feature\nmore\n', 'more feature work');
    git(seed, 'push', '-q', 'origin', 'feature');
    git(seed, 'switch', '-q', 'main');
    writeFileSync(path.join(work, 'd.txt'), 'tracked\n');
    git(work, 'add', 'd.txt');
    git(work, 'commit', '-qm', 'd');
    writeFileSync(path.join(work, 'd.txt'), 'tracked, changed locally\n');
    await repo.pull('rebase', undefined, { remote: 'origin', branch: 'feature', autostash: true });
    expect(git(work, 'log', '--format=%s', '-3').split('\n')).toEqual(['d', 'more feature work', 'feature work']);
    expect(readFileSync(path.join(work, 'd.txt'), 'utf8')).toBe('tracked, changed locally\n');
    expect(git(work, 'stash', 'list')).toBe('');
  });

  it('push: any local branch, under another name on the remote, tracking it', async () => {
    const repo = new Repo(work);
    git(work, 'branch', 'not-current', 'HEAD~1');
    await repo.push({ remote: 'origin', branch: 'not-current', remoteBranch: 'published/name', setUpstream: true });
    expect(git(origin, 'rev-parse', 'refs/heads/published/name')).toBe(git(work, 'rev-parse', 'not-current'));
    expect(git(work, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/not-current')).toBe('origin/published/name');
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // the current branch is untouched
    // the same name when none is given; tags along on request
    git(work, 'tag', 'v-pushed');
    await repo.push({ remote: 'origin', branch: 'main', tags: true });
    expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(git(work, 'rev-parse', 'main'));
    expect(git(origin, 'tag', '--list')).toContain('v-pushed');
  });
});
