import { describe, expect, it } from 'vitest';
import type { Ref } from '../git/types';
import { versionGroups, versionOf } from './versions';

const b = (name: string, extra: Partial<Ref> = {}): Ref => ({ name, kind: 'branch', sha: 'a', ...extra });
const r = (name: string): Ref => ({ name, kind: 'remote', sha: 'a' });

describe('versions', () => {
  it('reads the version out of a local and a remote branch, ignoring everything else', () => {
    expect(versionOf(b('ver/120'))).toBe('120');
    expect(versionOf(b('ver/120-filter'))).toBe('120-filter');
    expect(versionOf(r('origin/ver/120'))).toBe('120');
    expect(versionOf(b('main'))).toBe(null);
    expect(versionOf(b('feature/ver/100'))).toBe(null);
    expect(versionOf({ name: 'ver/100', kind: 'tag', sha: 'a' })).toBe(null);
  });

  it('takes only versions that start with three digits', () => {
    expect(versionOf(b('ver/1'))).toBe(null);
    expect(versionOf(b('ver/12'))).toBe(null);
    expect(versionOf(b('ver/1.2.0'))).toBe(null);
    expect(versionOf(b('ver/wip'))).toBe(null);
    expect(versionOf(r('origin/ver/beta-123'))).toBe(null);
    expect(versionOf(b('ver/1234'))).toBe('1234');
  });

  it('groups the branches of one version, local first, and sorts versions newest first', () => {
    const groups = versionGroups([b('main'), r('origin/ver/009'), b('ver/010'), r('origin/ver/010'), r('upstream/ver/010'), b('dev/x')]);
    expect(groups.map((g) => g.version)).toEqual(['010', '009']);
    expect(groups[0].refs.map((x) => x.name)).toEqual(['ver/010', 'origin/ver/010', 'upstream/ver/010']);
    expect(groups[0].local).toBe(true);
    expect(groups[1].local).toBe(false);
  });

  it('marks the version that is checked out', () => {
    const groups = versionGroups([b('ver/003', { current: true }), r('origin/ver/003')]);
    expect(groups[0].current).toBe(true);
  });
});
