import { describe, expect, it } from 'vitest';
import { filesOf, lfsTree, pickedCounts, pickOf, type LfsMissing } from './lfsTree';

const m = (path: string, size = 10, downloaded = false): LfsMissing => ({ path, size, downloaded });
const MISSING = [
  m('fmod/Assets/Music/a.ogg', 100),
  m('fmod/Assets/Music/b.ogg', 100),
  m('fmod/Assets/Sfx/c.wav', 50, true),
  m('fmod/Assets/d.bank', 5),
  m('fmod/Metadata/e.xml', 1),
  m('android/app/src/main/res/raw/f.ogg', 20),
  m('top.bin', 3),
];

describe('the restore dialog’s folders', () => {
  it('folders with counts and sizes, chains squashed, files at the top kept at the top', () => {
    const root = lfsTree(MISSING);
    expect([root.count, root.bytes, root.toDownload]).toEqual([7, 279, 229]);
    expect(root.own.map((f) => f.path)).toEqual(['top.bin']);
    expect(root.folders.map((f) => [f.name, f.path, f.count, f.bytes])).toEqual([
      ['android/app/src/main/res/raw', 'android/app/src/main/res/raw', 1, 20],
      ['fmod', 'fmod', 5, 256],
    ]);
    const assets = root.folders[1].folders[0];
    expect([assets.name, assets.own.map((f) => f.path), assets.folders.map((f) => f.name), assets.toDownload]).toEqual(['Assets', ['fmod/Assets/d.bank'], ['Music', 'Sfx'], 205]);
    expect(filesOf(assets)).toHaveLength(4);
  });

  it('a pick: all of it is everything; whole folders by folder, the rest by name', () => {
    const root = lfsTree(MISSING);
    expect(pickOf(root, new Set(MISSING.map((f) => f.path))).pick).toEqual({ all: true });
    const some = new Set(['fmod/Assets/Music/a.ogg', 'fmod/Assets/Music/b.ogg', 'fmod/Assets/d.bank', 'android/app/src/main/res/raw/f.ogg']);
    const r = pickOf(root, some);
    // Assets' own file and its Music folder, not Sfx: Assets is not taken whole
    expect(r.pick).toEqual({ folders: ['android/app/src/main/res/raw', 'fmod/Assets/Music'], files: ['fmod/Assets/d.bank'] });
    expect([r.count, r.bytes, r.toDownload]).toEqual([4, 225, 225]);
    expect(pickedCounts(root, some).get('fmod')).toBe(3);
    expect(pickOf(root, new Set()).pick).toEqual({ folders: [], files: [] });
    expect(pickOf(lfsTree([]), new Set()).count).toBe(0);
  });
});
