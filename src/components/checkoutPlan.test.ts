import { describe, expect, it } from 'vitest';
import type { Ref } from '../git/types';
import { canIntegrate, checkoutPlan, defaultIntegrate, relationText, rowCheckoutChoices } from './checkoutPlan';

const refs: Ref[] = [
  { name: 'main', kind: 'branch', sha: 'm', current: true, upstream: 'origin/main', ahead: 0, behind: 2 },
  { name: 'origin/main', kind: 'remote', sha: 'om' },
  { name: 'feature', kind: 'branch', sha: 'f', upstream: 'origin/feature', ahead: 1, behind: 3 },
  { name: 'origin/feature', kind: 'remote', sha: 'of' },
  { name: 'level', kind: 'branch', sha: 'l', upstream: 'origin/level', ahead: 0, behind: 0 },
  { name: 'origin/level', kind: 'remote', sha: 'l' },
  { name: 'mine', kind: 'branch', sha: 'x', upstream: 'origin/mine', ahead: 2, behind: 0 },
  { name: 'origin/mine', kind: 'remote', sha: 'y' },
  { name: 'loose', kind: 'branch', sha: 'z' },
  { name: 'origin/loose', kind: 'remote', sha: 'w' },
  { name: 'origin/new', kind: 'remote', sha: 'n' },
  { name: 'origin/HEAD', kind: 'remote', sha: 'om', target: 'origin/main' },
  { name: 'v1', kind: 'tag', sha: 'm' },
];

describe('checkoutPlan', () => {
  it('a local branch: compared with its upstream', () => {
    expect(checkoutPlan(refs, 'feature')).toEqual({ ref: 'feature', target: 'feature', current: false, other: 'origin/feature', ahead: 1, behind: 3, differs: true });
    expect(checkoutPlan(refs, 'level')).toMatchObject({ differs: false });
    expect(checkoutPlan(refs, 'main')).toMatchObject({ current: true, behind: 2, differs: true });
    expect(checkoutPlan(refs, 'v1')).toBeNull();
    expect(checkoutPlan(refs, 'origin/HEAD')).toBeNull();
  });
  it('a remote branch: its local branch, compared with it; none: a new one tracking it', () => {
    expect(checkoutPlan(refs, 'origin/main')).toMatchObject({ target: 'main', current: true, other: 'origin/main', behind: 2, differs: true });
    expect(checkoutPlan(refs, 'origin/new')).toEqual({ ref: 'origin/new', target: 'new', start: 'origin/new', current: false, differs: false });
    // same name, not tracking it: no counts, only "different commits"
    expect(checkoutPlan(refs, 'origin/loose')).toMatchObject({ target: 'loose', other: 'origin/loose', ahead: undefined, behind: undefined, differs: true });
  });
  it('a merge or rebase is offered when it would bring something; the default follows the pull mode for a branch only behind', () => {
    const p = (n: string) => checkoutPlan(refs, n)!;
    expect(canIntegrate(p('feature'))).toBe(true);
    expect(defaultIntegrate(p('feature'))).toBe('none');
    expect(defaultIntegrate(p('main'))).toBe('merge');
    expect(defaultIntegrate(p('main'), 'rebase')).toBe('rebase');
    expect(defaultIntegrate(p('main'), 'ff')).toBe('merge');
    expect(canIntegrate(p('mine'))).toBe(false);
    expect(canIntegrate(p('level'))).toBe(false);
    expect(canIntegrate(p('origin/loose'))).toBe(true);
    expect(defaultIntegrate(p('origin/loose'))).toBe('none');
  });
  it('says how they stand', () => {
    const p = (n: string) => relationText(checkoutPlan(refs, n)!);
    expect(p('main')).toBe('main is 2 commits behind origin/main');
    expect(p('feature')).toBe('feature and origin/feature have diverged: 1 commit of its own, 3 commits new on origin/feature');
    expect(p('mine')).toBe('mine is 2 commits ahead of origin/mine: push to publish');
    expect(p('level')).toBe('level is at origin/level');
    expect(p('origin/loose')).toBe('loose and origin/loose point to different commits');
    expect(p('origin/new')).toBe('A new branch new is made at origin/new and tracks it');
    expect(p('loose')).toBeNull();
  });
  it('a commit row offers its other local branches, then remote ones without a local label there', () => {
    const at = (names: string[]) => refs.filter((r) => names.includes(r.name));
    expect(rowCheckoutChoices(at(['main', 'origin/main', 'feature', 'origin/new', 'origin/HEAD', 'v1']))).toEqual(['feature', 'origin/new']);
    expect(rowCheckoutChoices(at(['main', 'origin/main']))).toEqual([]);
    expect(rowCheckoutChoices(at(['origin/main']))).toEqual(['origin/main']);
  });
});
