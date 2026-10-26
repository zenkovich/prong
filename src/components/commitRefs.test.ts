import { describe, expect, it } from 'vitest';
import type { Ref } from '../git/types';
import { refLabels } from './commitRefs';

const r = (name: string, kind: Ref['kind'], extra: Partial<Ref> = {}): Ref => ({ name, kind, sha: 'x', ...extra }) as Ref;

describe('commit row ref labels', () => {
  it('merges a branch with the remote branch it tracks on the same commit', () => {
    const out = refLabels([r('origin/main', 'remote'), r('main', 'branch', { current: true, upstream: 'origin/main' }), r('origin/HEAD', 'remote')]);
    expect(out.map((l) => [l.name, l.remote, l.remoteOnly])).toEqual([['main', true, false]]);
  });
  it('falls back to the same-named origin twin when no upstream is configured', () => {
    expect(refLabels([r('feature/x', 'branch'), r('origin/feature/x', 'remote')]).map((l) => [l.name, l.remote])).toEqual([['feature/x', true]]);
  });
  it('keeps remote-only branches, puts the current branch first and tags last', () => {
    const out = refLabels([r('v1.0', 'tag'), r('dev', 'branch'), r('origin/release', 'remote'), r('main', 'branch', { current: true })]);
    expect(out.map((l) => [l.name, l.remote, l.remoteOnly])).toEqual([
      ['main', false, false],
      ['dev', false, false],
      ['origin/release', true, true],
      ['v1.0', false, false],
    ]);
  });
});
