import { describe, expect, it } from 'vitest';
import type { Ref } from '../git/types';
import { filterChips, filterRevs, filterTwin, inFilter, toggleFilterRef, withFilterRef } from './branchFilter';
import type { GraphFilter } from './graphLayout';

const all: GraphFilter = { mode: 'all', refs: [], hideRemotes: false };

describe('branch filter', () => {
  it('the first funnel shows only that branch, more funnels add branches', () => {
    const a = toggleFilterRef(all, 'main');
    expect(a).toEqual({ mode: 'selected', refs: ['main'], hideRemotes: false });
    const b = toggleFilterRef(a, 'origin/feature/x');
    expect(b.refs).toEqual(['main', 'origin/feature/x']);
    expect(inFilter(b, 'main')).toBe(true);
    expect(inFilter(all, 'main')).toBe(false);
  });
  it('removing the last branch shows the whole history again', () => {
    const one = toggleFilterRef(all, 'main');
    expect(toggleFilterRef(one, 'main')).toEqual({ mode: 'all', refs: [], hideRemotes: false });
  });
  it('a "current branch" filter is replaced, not extended', () => {
    expect(toggleFilterRef({ mode: 'current', refs: [], hideRemotes: true }, 'dev')).toEqual({ mode: 'selected', refs: ['dev'], hideRemotes: true });
  });
  it('a click on a branch the filter leaves out takes it in (with its remote branch); one already shown changes nothing', () => {
    const sel: GraphFilter = { mode: 'selected', refs: ['main', 'origin/main'], hideRemotes: false };
    expect(withFilterRef(sel, 'dev', 'origin/dev').refs).toEqual(['main', 'origin/main', 'dev', 'origin/dev']);
    expect(withFilterRef(sel, 'origin/main')).toBe(sel);
    expect(withFilterRef(sel, 'v1.0').refs).toEqual(['main', 'origin/main', 'v1.0']);
    expect(withFilterRef({ ...sel, refs: ['origin/dev'] }, 'dev', 'origin/dev').refs).toEqual(['origin/dev', 'dev']);
    expect(withFilterRef(all, 'dev', 'origin/dev')).toBe(all);
    const hidden: GraphFilter = { ...all, hideRemotes: true };
    expect(withFilterRef(hidden, 'dev')).toBe(hidden);
  });
  it('"current branch" and a click on another branch: the current one and the clicked one, each with its remote branch', () => {
    const cur: GraphFilter = { mode: 'current', refs: [], hideRemotes: false };
    expect(withFilterRef(cur, 'main', 'origin/main', { name: 'main', twin: 'origin/main' })).toBe(cur);
    expect(withFilterRef(cur, 'dev', 'origin/dev', { name: 'main', twin: 'origin/main' })).toEqual({ mode: 'selected', refs: ['main', 'origin/main', 'dev', 'origin/dev'], hideRemotes: false });
    expect(withFilterRef(cur, 'origin/main', undefined, { name: 'main', twin: 'origin/main' }).refs).toEqual(['main', 'origin/main']);
    // detached HEAD: no current branch, only the clicked one
    expect(withFilterRef(cur, 'dev').refs).toEqual(['dev']);
  });
  it('maps filters to git revisions', () => {
    expect(filterRevs(all)).toBeNull();
    expect(filterRevs({ ...all, hideRemotes: true })).toEqual(['--branches', '--tags']);
    expect(filterRevs({ mode: 'current', refs: [], hideRemotes: false })).toEqual(['HEAD']);
    expect(filterRevs({ mode: 'selected', refs: ['a', 'b'], hideRemotes: false })).toEqual(['a', 'b']);
  });
  it('a local branch comes with its remote branch: both in, both out; the remote one alone stays its own', () => {
    const a = toggleFilterRef(all, 'feature/x', 'origin/feature/x');
    expect(a.refs).toEqual(['feature/x', 'origin/feature/x']);
    const b = toggleFilterRef(a, 'topic', 'origin/topic');
    expect(b.refs).toEqual(['feature/x', 'origin/feature/x', 'topic', 'origin/topic']);
    expect(toggleFilterRef(b, 'feature/x', 'origin/feature/x').refs).toEqual(['topic', 'origin/topic']);
    // the remote one taken out by its own funnel: the local one stays
    expect(toggleFilterRef(b, 'origin/topic').refs).toEqual(['feature/x', 'origin/feature/x', 'topic']);
    // already in by its own funnel: not twice
    expect(toggleFilterRef({ ...all, mode: 'selected', refs: ['origin/x'] }, 'x', 'origin/x').refs).toEqual(['origin/x', 'x']);
    expect(toggleFilterRef(a, 'feature/x', 'origin/feature/x')).toEqual(all);
  });
});

describe('filter twins and chips', () => {
  const refs: Ref[] = [
    { name: 'main', kind: 'branch', sha: 'a', upstream: 'origin/main' },
    { name: 'origin/main', kind: 'remote', sha: 'a' },
    { name: 'topic', kind: 'branch', sha: 'b' },
    { name: 'origin/topic', kind: 'remote', sha: 'b' },
    { name: 'solo', kind: 'branch', sha: 'c' },
    { name: 'v1', kind: 'tag', sha: 'a' },
  ];
  const remotes = [{ name: 'origin' }];
  const sel = (r: string[]) => ({ mode: 'selected' as const, refs: r, hideRemotes: false });
  it('the twin: the upstream, else the namesake on origin; none for remote branches, tags, or with remotes hidden', () => {
    expect(filterTwin(refs, remotes, 'main')).toBe('origin/main');
    expect(filterTwin(refs, remotes, 'topic')).toBe('origin/topic');
    expect(filterTwin(refs, remotes, 'solo')).toBeUndefined();
    expect(filterTwin(refs, remotes, 'origin/main')).toBeUndefined();
    expect(filterTwin(refs, remotes, 'v1')).toBeUndefined();
    expect(filterTwin(refs, remotes, 'main', true)).toBeUndefined();
  });
  it('a branch and its twin share a chip, at the branch’s place; alone each has its own', () => {
    expect(filterChips(sel(['origin/topic', 'main', 'v1', 'topic', 'origin/main']), refs, remotes)).toEqual([{ name: 'main', twin: 'origin/main' }, { name: 'v1' }, { name: 'topic', twin: 'origin/topic' }]);
    expect(filterChips(sel(['main', 'origin/topic']), refs, remotes)).toEqual([{ name: 'main' }, { name: 'origin/topic' }]);
    expect(filterChips(all, refs, remotes)).toEqual([]);
  });
});

