import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeConflict, Repo } from '../src/git/repo.js';

/**
 * Fork's way with a conflicted file: the whole file, each conflict with ours | theirs, a pick per conflict, and the
 * file written from the picks (the lines both sides agree on untouched).
 */
describe('conflicts resolved one by one', () => {
  let root: string;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-conflict-parts-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** two conflicts in f.txt, apart, and lines both sides keep */
  const fixture = (name: string) => {
    const dir = path.join(root, name);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'commit.gpgsign', 'false');
    const lines = (a: string, b: string) => ['head', a, 'm1', 'm2', 'm3', 'm4', 'm5', b, 'tail', ''].join('\n');
    writeFileSync(path.join(dir, 'f.txt'), lines('one', 'two'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'switch', '-q', '-c', 'other');
    writeFileSync(path.join(dir, 'f.txt'), lines('one theirs', 'two theirs'));
    git(dir, 'commit', '-qam', 'theirs');
    git(dir, 'switch', '-q', 'main');
    writeFileSync(path.join(dir, 'f.txt'), lines('one ours', 'two ours'));
    git(dir, 'commit', '-qam', 'ours');
    try {
      git(dir, 'merge', 'other');
    } catch {
      /* conflicts */
    }
    return dir;
  };

  it('the view gets the whole file: agreed lines and each conflict with its three sides', async () => {
    const dir = fixture('blocks');
    const c = await new Repo(dir).conflictOf('f.txt');
    expect(c?.blocks?.map((b) => b.kind)).toEqual(['same', 'conflict', 'same', 'conflict', 'same']);
    expect(c!.blocks![1]).toEqual({ kind: 'conflict', ours: ['one ours'], base: ['one'], theirs: ['one theirs'] });
    expect(c!.blocks![2]).toEqual({ kind: 'same', lines: ['m1', 'm2', 'm3', 'm4', 'm5'] });
    // the regions-only view is still there
    expect(c!.ours).toEqual(['one ours', '⋯', 'two ours']);
  });

  it('a pick per conflict: ours for one, both (theirs first) for the other; written whole and marked resolved', async () => {
    const dir = fixture('picks');
    await new Repo(dir).resolveConflictParts('f.txt', ['ours', 'theirs+ours']);
    expect(readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(['head', 'one ours', 'm1', 'm2', 'm3', 'm4', 'm5', 'two theirs', 'two ours', 'tail', ''].join('\n'));
    expect(git(dir, 'status', '--porcelain')).toBe('M  f.txt\n');
  });

  it('a wrong number of picks (the file changed under the view) is refused, nothing written', async () => {
    const dir = fixture('stale');
    const before = readFileSync(path.join(dir, 'f.txt'), 'utf8');
    await expect(new Repo(dir).resolveConflictParts('f.txt', ['ours'])).rejects.toThrow(/2 conflicts now, 1 choices/);
    expect(readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(before);
    expect(git(dir, 'status', '--porcelain')).toContain('UU f.txt');
  });

  it('composing: the base keeps neither change', () => {
    expect(composeConflict([{ kind: 'same', lines: ['a'] }, { kind: 'conflict', ours: ['o'], base: ['b'], theirs: ['t'] }, { kind: 'same', lines: [''] }], ['base'])).toBe('a\nb\n');
  });
});
