import { describe, expect, it } from 'vitest';
import type { Ref } from '../git/types';
import { branchNameProblem, mainBranch, remoteTwin, remoteTwins } from './branchNames';

describe('branchNameProblem', () => {
  it('takes what git takes', () => {
    for (const n of ['main', 'feature/x', 'hs/tmp/alpha', 'ver/925', 'games/wordfall/main', 'fix-1.2', 'a+b', 'issue#12', 'Case-Me', 'v1.0/x']) expect(branchNameProblem(n), n).toBeNull();
  });
  it('refuses what git refuses, saying why', () => {
    for (const n of ['', 'bad name', 'tab\tname', 'a..b', 'trailing/', '/leading', 'two//slashes', '-dash', 'end.', 'dir/.hidden', '.hidden', 'x.lock', 'x.lock/y', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[1', 'a\\b', 'at@{u}', '@']) {
      const why = branchNameProblem(n);
      expect(why, JSON.stringify(n)).toMatch(/^Not a valid branch name: /);
    }
  });
});

describe('remoteTwin', () => {
  const refs: Ref[] = [
    { name: 'pub', kind: 'branch', sha: 'a', upstream: 'origin/pub' },
    { name: 'origin/pub', kind: 'remote', sha: 'a' },
    { name: 'renamed', kind: 'branch', sha: 'a', upstream: 'origin/other' },
    { name: 'origin/other', kind: 'remote', sha: 'a' },
    { name: 'gone', kind: 'branch', sha: 'a', upstream: 'origin/gone', gone: true },
    { name: 'untracked', kind: 'branch', sha: 'a' },
    { name: 'origin/untracked', kind: 'remote', sha: 'a' },
    { name: 'local-up', kind: 'branch', sha: 'a', upstream: 'main' },
    { name: 'main', kind: 'branch', sha: 'a' },
    { name: 'nowhere', kind: 'branch', sha: 'a' },
    { name: 'fork/only', kind: 'remote', sha: 'a' },
    { name: 'only', kind: 'branch', sha: 'a' },
  ];
  const remotes = [{ name: 'fork' }, { name: 'origin' }];
  const twin = (n: string) => remoteTwin(refs, remotes, refs.find((r) => r.name === n)!);
  it('is the upstream while the remote has it', () => {
    expect(twin('pub')).toBe('origin/pub');
    expect(twin('renamed')).toBe('origin/other');
  });
  it('is the same name on origin when there is no usable upstream', () => {
    expect(twin('untracked')).toBe('origin/untracked');
    expect(twin('gone')).toBeUndefined();
  });
  it('is never a local branch, and nothing when no remote has it', () => {
    expect(twin('local-up')).toBeUndefined();
    expect(twin('nowhere')).toBeUndefined();
    // origin is asked first; the same name on another remote is not guessed
    expect(twin('only')).toBeUndefined();
    expect(remoteTwin(refs, [], refs.find((r) => r.name === 'untracked')!)).toBeUndefined();
  });
});

describe('mainBranch', () => {
  const o = [{ name: 'origin' }];
  it('the branch origin/HEAD points to, local and remote', () => {
    const refs: Ref[] = [
      { name: 'master', kind: 'branch', sha: 'a', upstream: 'origin/master', behind: 2 },
      { name: 'main', kind: 'branch', sha: 'b' },
      { name: 'origin/HEAD', kind: 'remote', sha: 'c', target: 'origin/master' },
      { name: 'origin/master', kind: 'remote', sha: 'c' },
    ];
    const m = mainBranch(refs, o);
    expect(m?.name).toBe('master');
    expect(m?.local?.name).toBe('master');
    expect(m?.remote?.name).toBe('origin/master');
  });
  it('without origin/HEAD: main, else master; a missing side is left out', () => {
    expect(mainBranch([{ name: 'master', kind: 'branch', sha: 'a' }, { name: 'x', kind: 'branch', sha: 'b' }], []))?.toMatchObject({ name: 'master', local: { name: 'master' }, remote: undefined });
    const remoteOnly = mainBranch([{ name: 'feature', kind: 'branch', sha: 'a', current: true }, { name: 'origin/main', kind: 'remote', sha: 'b' }], o);
    expect(remoteOnly?.local).toBeUndefined();
    expect(remoteOnly?.remote?.name).toBe('origin/main');
    expect(mainBranch([{ name: 'dev', kind: 'branch', sha: 'a' }], o)).toBeNull();
  });
  it('a local branch of another name tracking it stands in for the local one', () => {
    const m = mainBranch([{ name: 'trunk-local', kind: 'branch', sha: 'a', upstream: 'origin/trunk' }, { name: 'origin/HEAD', kind: 'remote', sha: 'a', target: 'origin/trunk' }, { name: 'origin/trunk', kind: 'remote', sha: 'a' }], o);
    expect(m?.name).toBe('trunk');
    expect(m?.local?.name).toBe('trunk-local');
  });
});

describe('remoteTwins', () => {
  it('is remoteTwin of every local branch', () => {
    const refs: Ref[] = [
      { name: 'pub', kind: 'branch', sha: 'a', upstream: 'origin/pub' },
      { name: 'origin/pub', kind: 'remote', sha: 'a' },
      { name: 'renamed', kind: 'branch', sha: 'a', upstream: 'origin/other' },
      { name: 'origin/other', kind: 'remote', sha: 'a' },
      { name: 'gone', kind: 'branch', sha: 'a', upstream: 'origin/gone', gone: true },
      { name: 'untracked', kind: 'branch', sha: 'a' },
      { name: 'origin/untracked', kind: 'remote', sha: 'a' },
      { name: 'nowhere', kind: 'branch', sha: 'a' },
    ];
    const o = [{ name: 'origin' }];
    const all = remoteTwins(refs, o);
    for (const b of refs.filter((x) => x.kind === 'branch')) expect(all.get(b.name), b.name).toBe(remoteTwin(refs, o, b));
    expect(all.size).toBe(3);
  });
});

