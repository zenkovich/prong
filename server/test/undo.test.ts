import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';
import { restoreFromUndo, saveForUndo } from '../src/undo.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function makeRepo(dir: string) {
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'a');
}

describe('branch names on a case-insensitive disk', () => {
  let root: string;
  let dir: string;
  let ignorecase = false;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-case-'));
    dir = path.join(root, 'r');
    makeRepo(dir);
    ignorecase = git(dir, 'config', '--bool', 'core.ignorecase') === 'true';
    git(dir, 'branch', 'tmp/existing');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a branch git lists in another case than HEAD names it is still the current one', async () => {
    if (!ignorecase) return; // only a case-insensitive disk does this
    // what happened: `switch -c Tmp/x` next to the folder tmp/ → stored and listed as tmp/x, HEAD says Tmp/x
    git(dir, 'switch', '-q', '-c', 'Tmp/typed');
    expect(git(dir, 'symbolic-ref', 'HEAD')).toBe('refs/heads/Tmp/typed');
    const refs = await new Repo(dir).refs();
    const cur = refs.filter((r) => r.kind === 'branch' && r.current);
    expect(cur.map((r) => r.name)).toEqual(['tmp/typed']);
    git(dir, 'switch', '-q', 'main');
  });

  it('a new branch takes the spelling of the folder that exists; a case-only rename works', async () => {
    const repo = new Repo(dir);
    const made = await repo.createBranch('TMP/new', 'HEAD', true);
    expect(made.name).toBe(ignorecase ? 'tmp/new' : 'TMP/new');
    expect(git(dir, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${made.name}`);
    git(dir, 'switch', '-q', 'main');
    git(dir, 'branch', 'Feature');
    await repo.renameBranch('Feature', 'feature');
    expect(git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n')).toContain('feature');
    expect(git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n')).not.toContain('Feature');
  });
});

describe('undo building blocks and submodule sync', () => {
  let root: string;
  let dir: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-undo-'));
    process.env.PRONG_STATE_DIR = path.join(root, 'state');
    dir = path.join(root, 'r');
    makeRepo(dir);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('discarding keeps copies: modified, untracked and deleted files come back exactly', async () => {
    const repo = new Repo(dir);
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', 'b.txt');
    git(dir, 'commit', '-qm', 'b');
    writeFileSync(path.join(dir, 'a.txt'), 'a changed\n');
    writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
    rmSync(path.join(dir, 'b.txt'));
    const token = await saveForUndo(repo, null);
    expect(token).toBeTruthy();
    await repo.discardAll();
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a\n');
    expect(existsSync(path.join(dir, 'new.txt'))).toBe(false);
    expect(existsSync(path.join(dir, 'b.txt'))).toBe(true);
    expect(restoreFromUndo(repo, token!).restored).toBe(3);
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a changed\n');
    expect(readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('untracked\n');
    expect(existsSync(path.join(dir, 'b.txt'))).toBe(false);
    expect(() => restoreFromUndo(repo, token!)).toThrow(/no longer be undone/);
    // one file: only that one is copied
    const one = await saveForUndo(repo, ['a.txt']);
    await repo.discard(['a.txt']);
    restoreFromUndo(repo, one!);
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a changed\n');
    git(dir, 'checkout', '--', '.');
    git(dir, 'clean', '-fdq');
  });

  it('the index goes back exactly (write-tree / read-tree); reset --keep moves the branch back', async () => {
    const repo = new Repo(dir);
    const before = (await repo.writeTree())!;
    writeFileSync(path.join(dir, 'c.txt'), 'c\n');
    await repo.stage(['c.txt']);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('c.txt');
    await repo.readTree(before);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(existsSync(path.join(dir, 'c.txt'))).toBe(true); // the working tree is untouched
    const head = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'commit', '-qm', 'empty', '--allow-empty');
    await repo.reset(head, 'keep');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    rmSync(path.join(dir, 'c.txt'));
  });

  it('stash: push says which commit, it pops by commit; a dropped stash comes back; a deleted annotated tag too', async () => {
    const repo = new Repo(dir);
    writeFileSync(path.join(dir, 'a.txt'), 'stashed\n');
    const { sha } = await repo.stashPush('mine', false, true);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await repo.stashPush('', false, true)).sha).toBeNull(); // nothing to stash
    await repo.stashPopCommit(sha!);
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('stashed\n');
    await repo.stashPush('again', false, true);
    const dropped = await repo.stashDrop(0);
    expect(dropped.message).toContain('again');
    expect(git(dir, 'stash', 'list')).toBe('');
    await repo.stashStore(dropped.sha, dropped.message);
    expect(git(dir, 'stash', 'list')).toContain('again');
    git(dir, 'stash', 'drop', '-q');
    git(dir, 'tag', '-a', 'v1', '-m', 'release one');
    const tag = await repo.deleteTag('v1');
    await repo.restoreRef('refs/tags/v1', tag.sha);
    expect(git(dir, 'for-each-ref', '--format=%(contents:subject)', 'refs/tags/v1')).toBe('release one');
    await expect(repo.restoreRef('refs/tags/v1', tag.sha)).rejects.toThrow(); // only when nothing of that name exists
  });

  it('changed submodules: only an initialized one still where the old commit had it may follow', async () => {
    const sub = path.join(root, 'sub');
    makeRepo(sub);
    const s1 = git(sub, 'rev-parse', 'HEAD');
    const sup = path.join(root, 'sup');
    makeRepo(sup);
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'libs/sub');
    git(sup, 'commit', '-qm', 'add sub');
    const c1 = git(sup, 'rev-parse', 'HEAD');
    writeFileSync(path.join(sub, 'more.txt'), 'more\n');
    git(sub, 'add', '-A');
    git(sub, 'commit', '-qm', 'more');
    const s2 = git(sub, 'rev-parse', 'HEAD');
    git(path.join(sup, 'libs/sub'), '-c', 'protocol.file.allow=always', 'fetch', '-q', 'origin');
    git(path.join(sup, 'libs/sub'), 'checkout', '-q', s2);
    git(sup, 'add', 'libs/sub');
    git(sup, 'commit', '-qm', 'bump sub');
    const c2 = git(sup, 'rev-parse', 'HEAD');
    const repo = new Repo(sup);
    // back at c1 in the superproject, the submodule left at s2 (git does not move it): c2 → c1 changed it
    git(sup, 'checkout', '-q', c1);
    expect(await repo.changedSubmodules(c2, c1)).toEqual([{ path: 'libs/sub', from: s2, to: s1, initialized: true, inSync: true }]);
    // the user moved it themselves: not in sync with what c2 recorded
    git(path.join(sup, 'libs/sub'), 'checkout', '-q', s1);
    expect((await repo.changedSubmodules(c2, c1))[0].inSync).toBe(false);
    expect(await repo.changedSubmodules(c1, c1)).toEqual([]);
  });
});
