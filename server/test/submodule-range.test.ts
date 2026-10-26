import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';

/** A submodule pointer change in a commit: which submodule commits it brought in or left behind. */
describe('submodule range', () => {
  let root: string;
  let sup: string;
  let sub: string;
  let base = '';
  let one = '';
  let two = '';
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-subrange-'));
    const origin = path.join(root, 'core');
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    git(origin, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(origin, 'core.txt'), 'core\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'core: base');
    sup = path.join(root, 'super');
    execFileSync('git', ['init', '-q', '-b', 'main', sup]);
    git(sup, 'config', 'commit.gpgsign', 'false');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'libs/core');
    git(sup, 'commit', '-q', '-m', 'Add core');
    sub = path.join(sup, 'libs/core');
    git(sub, 'config', 'commit.gpgsign', 'false');
    base = git(sub, 'rev-parse', 'HEAD');
    writeFileSync(path.join(sub, 'core.txt'), 'core\none\n');
    git(sub, 'commit', '-qam', 'core: one');
    one = git(sub, 'rev-parse', 'HEAD');
    writeFileSync(path.join(sub, 'core.txt'), 'core\none\ntwo\n');
    git(sub, 'commit', '-qam', 'core: two');
    two = git(sub, 'rev-parse', 'HEAD');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists the commits a pointer move brought in, newest first', async () => {
    const r = await new Repo(sup).submoduleRange('libs/core', base, two);
    expect(r.added.map((c) => c.subject)).toEqual(['core: two', 'core: one']);
    expect(r.removed).toEqual([]);
    expect(r).toMatchObject({ missing: [], uninitialized: false, more: false });
  });

  it('a pointer moved back lists what it left behind', async () => {
    const r = await new Repo(sup).submoduleRange('libs/core', two, one);
    expect(r.added).toEqual([]);
    expect(r.removed.map((c) => c.subject)).toEqual(['core: two']);
  });

  it('a newly added submodule lists its history; a limit says there is more', async () => {
    const r = await new Repo(sup).submoduleRange('libs/core', '', two, 2);
    expect(r.added.map((c) => c.subject)).toEqual(['core: two', 'core: one']);
    expect(r.more).toBe(true);
  });

  it('pointers the clone does not have are reported, not thrown', async () => {
    const ghost = 'f'.repeat(40);
    const r = await new Repo(sup).submoduleRange('libs/core', two, ghost);
    expect(r.missing).toEqual([ghost]);
    expect(r.added).toEqual([]);
    expect((await new Repo(sup).submoduleCommits('libs/core', [one, ghost]))[one]).toBe('core: one');
  });

  it('a submodule that is not checked out says so', async () => {
    const clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', sup, clone]);
    const r = await new Repo(clone).submoduleRange('libs/core', base, two);
    expect(r.uninitialized).toBe(true);
  });

  it('a branch pushed from a narrow clone gets tracked: origin/<branch> exists and the upstream resolves', async () => {
    // a single-branch clone fetches only master (like vso-engine)
    const bare = path.join(root, 'narrow-origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const seed = path.join(root, 'seed');
    execFileSync('git', ['clone', '-q', bare, seed], { stdio: 'pipe' });
    git(seed, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(seed, 'a.txt'), 'a\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'a');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const narrow = path.join(root, 'narrow');
    execFileSync('git', ['clone', '-q', '--single-branch', '-b', 'main', bare, narrow], { stdio: 'pipe' });
    git(narrow, 'config', 'commit.gpgsign', 'false');
    expect(git(narrow, 'config', '--get-all', 'remote.origin.fetch')).toBe('+refs/heads/main:refs/remotes/origin/main');
    const repo = new Repo(narrow);
    // the old way: pushed with -u, but git kept no remote copy, so the upstream did not resolve
    git(narrow, 'switch', '-q', '-c', 'hs/tmp/fix');
    writeFileSync(path.join(narrow, 'b.txt'), 'b\n');
    git(narrow, 'add', '-A');
    git(narrow, 'commit', '-qm', 'b');
    git(narrow, 'push', '-q', '-u', 'origin', 'hs/tmp/fix');
    expect(git(narrow, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/hs/tmp/fix')).toBe('');
    // Prong's push: the branch joins the fetch list and its remote copy is read
    await repo.push({ remote: 'origin', branch: 'hs/tmp/fix', setUpstream: true });
    expect(git(narrow, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/hs/tmp/fix')).toBe('origin/hs/tmp/fix');
    expect(git(narrow, 'rev-parse', 'origin/hs/tmp/fix')).toBe(git(narrow, 'rev-parse', 'HEAD'));
    expect(await repo.fetchesBranch('origin', 'hs/tmp/fix')).toBe(true);
    // a fresh branch: tracked right away
    git(narrow, 'switch', '-q', '-c', 'feature/new');
    await repo.push({ remote: 'origin', branch: 'feature/new', setUpstream: true });
    expect(git(narrow, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/feature/new')).toBe('origin/feature/new');
    // a clone that fetches everything is left as it is
    expect(await new Repo(seed).fetchesBranch('origin', 'anything/here')).toBe(true);

    // the remote deletes the published branch (merged and cleaned up): git alone now fails every fetch
    git(seed, 'push', '-q', 'origin', '--delete', 'hs/tmp/fix');
    expect(() => git(narrow, 'fetch', '--all', '--prune')).toThrow(/couldn't find remote ref refs\/heads\/hs\/tmp\/fix/);
    // Prong's fetch: the gone branch leaves the fetch list, its stale remote copy goes, the rest is fetched
    const log: string[] = [];
    await repo.fetch('--all', true, (l) => log.push(l));
    expect(git(narrow, 'config', '--get-all', 'remote.origin.fetch').split('\n')).toEqual(['+refs/heads/main:refs/remotes/origin/main', '+refs/heads/feature/new:refs/remotes/origin/feature/new']);
    expect(git(narrow, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/hs')).toBe('');
    expect(log.at(-1)).toBe('Deleted on the remote, no longer fetched: origin/hs/tmp/fix');
    expect(git(narrow, 'rev-parse', '--verify', '-q', 'refs/heads/hs/tmp/fix')).toBeTruthy(); // the local branch stays
    // the same for a pull of a branch that is still there
    git(seed, 'push', '-q', 'origin', 'HEAD:feature/gone');
    git(narrow, 'remote', 'set-branches', '--add', 'origin', 'feature/gone');
    git(narrow, 'fetch', '-q');
    git(seed, 'push', '-q', 'origin', '--delete', 'feature/gone');
    git(narrow, 'switch', '-q', 'feature/new');
    await repo.pull('ff');
    expect(git(narrow, 'config', '--get-all', 'remote.origin.fetch')).not.toContain('feature/gone');
  });
});
