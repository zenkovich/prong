import { describe, expect, it } from 'vitest';
import { filterRevs, inFilter, toggleFilterRef } from './branchFilter';
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
  it('maps filters to git revisions', () => {
    expect(filterRevs(all)).toBeNull();
    expect(filterRevs({ ...all, hideRemotes: true })).toEqual(['--branches', '--tags']);
    expect(filterRevs({ mode: 'current', refs: [], hideRemotes: false })).toEqual(['HEAD']);
    expect(filterRevs({ mode: 'selected', refs: ['a', 'b'], hideRemotes: false })).toEqual(['a', 'b']);
  });
});
