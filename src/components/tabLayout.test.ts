import { describe, expect, it } from 'vitest';
import { fitWidths, groupTabs, naturalTabWidth } from './tabLayout';

describe('groupTabs', () => {
  const t = (id: string, path: string) => ({ id, path, name: path.split('/').pop()! });
  it('puts submodule tabs right after their parent, labelled by relative path', () => {
    const out = groupTabs([t('engine', '/w/hs/engine'), t('other', '/w/other'), t('hs', '/w/hs'), t('vso', '/w/hs/libs/vso')]);
    expect(out.map((x) => x.id)).toEqual(['other', 'hs', 'engine', 'vso']);
    expect(out.find((x) => x.id === 'vso')).toMatchObject({ parent: 'hs', label: 'libs/vso' });
    expect(out.find((x) => x.id === 'hs')).toMatchObject({ parent: null, label: 'hs', children: ['engine', 'vso'] });
  });
  it('groups nested submodules under the outermost open repository', () => {
    const out = groupTabs([t('a', '/w/a'), t('b', '/w/a/sub'), t('c', '/w/a/sub/deep')]);
    expect(out.map((x) => [x.id, x.parent, x.label])).toEqual([
      ['a', null, 'a'],
      ['b', 'a', 'sub'],
      ['c', 'a', 'sub/deep'],
    ]);
  });
  it('does not confuse sibling folders with a shared prefix', () => {
    const out = groupTabs([t('a', '/w/app'), t('b', '/w/app-tools')]);
    expect(out.every((x) => x.parent === null)).toBe(true);
  });
  it('a submodule whose parent is not open is a normal tab', () => {
    const out = groupTabs([t('engine', '/w/hs/engine')]);
    expect(out[0]).toMatchObject({ parent: null, label: 'engine' });
  });
});

describe('fitWidths', () => {
  it('keeps natural widths when they fit', () => {
    expect(fitWidths([100, 150], 400, 60)).toEqual({ widths: [100, 150], overflow: false });
  });
  it('shrinks the widest first and fills the space exactly', () => {
    // only the 300 px tab is over the cap: it shrinks to 180, the others keep their natural width
    expect(fitWidths([100, 300, 120], 400, 60)).toEqual({ widths: [100, 180, 120], overflow: false });
    // all three over the cap: equal widths that fill the bar
    const { widths } = fitWidths([300, 300, 300], 450, 60);
    expect(widths).toEqual([150, 150, 150]);
  });
  it('never goes below the minimum and reports overflow', () => {
    expect(fitWidths([200, 200, 200], 150, 60)).toEqual({ widths: [60, 60, 60], overflow: true });
    expect(fitWidths([200, 200], 300, [140, 60]).widths[0]).toBeGreaterThanOrEqual(140);
  });
  it('estimates monospace tab widths', () => {
    expect(naturalTabWidth('abcd', { charW: 7 })).toBe(47 + 28);
    expect(naturalTabWidth('abcd', { charW: 7, active: true })).toBe(68 + 28);
    expect(naturalTabWidth('abcd', { charW: 7, nested: true, badge: 2 })).toBe(50 + 28 + 28);
  });
});
