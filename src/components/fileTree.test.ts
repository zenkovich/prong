import { describe, expect, it } from 'vitest';
import type { FileChange } from '../git/types';
import { buildTree, flatten, rowKey } from './fileTree';

const f = (path: string): FileChange => ({ path, status: 'M', kind: 'text', additions: 0, deletions: 0 });

describe('file tree', () => {
  it('folders first, natural order, single-child folders squashed', () => {
    const tree = buildTree(['b/file10.txt', 'b/file2.txt', 'a/deep/only/x.ts', 'top.txt'].map(f));
    expect(tree.map((n) => n.name)).toEqual(['a/deep/only', 'b', 'top.txt']);
    expect(tree[1].children.map((n) => n.name)).toEqual(['file2.txt', 'file10.txt']);
  });

  it('rows skip the contents of closed folders', () => {
    const tree = buildTree(['a/1.txt', 'a/2.txt', 'b/3.txt'].map(f));
    expect(flatten(tree, 'commit', {}).map((r) => r.node.name)).toEqual(['a', '1.txt', '2.txt', 'b', '3.txt']);
    expect(flatten(tree, 'commit', { 'tree:commit:a': true }).map((r) => [r.node.name, r.depth])).toEqual([
      ['a', 0],
      ['b', 0],
      ['3.txt', 1],
    ]);
  });

  it('builds a 50 000-file merge quickly (was quadratic)', () => {
    const files = Array.from({ length: 50000 }, (_, i) => f(`Assets/Content/pack${i % 50}/item${i}.asset`));
    const t0 = performance.now();
    const tree = buildTree(files);
    const rows = flatten(tree, 'commit', {});
    expect(rows.filter((r) => r.node.file)).toHaveLength(50000);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('untracked folders in the tree (homescapes2: sdk/AiHelp/, src/Tests/runtime-test-framework/ …)', () => {
  const status = [
    'Server/updater/utils', 'autotests', 'sdk/AppsFlyerChina', 'src/Services/CrossAuth/CrossAuthService.cpp', 'src/Services/CrossAuth/CrossAuthService.h',
    'src/Services/CrossAuth/TokenProviders/GameCenterCrossAuthTokenProvider.cpp', 'src/Services/SignIn/GameCenterWrapper.cpp', 'vpython',
    'engine/', 'libs/lib-client/', 'libs/vso/', 'sdk/AiHelp/', 'sdk/Amplitude/', 'sdk/AntiAddiction/', 'sdk/AppsFlyer/', 'src/Tests/runtime-test-framework/',
  ];
  const files = status.map((p) => ({ path: p, status: (p.endsWith('/') ? '?' : 'M') as any, kind: 'text' as const, additions: 0, deletions: 0, hunks: [] }));

  it('an untracked folder is one entry with its own name, not a folder holding a nameless file', () => {
    const rows = flatten(buildTree(files), 'unstaged', {});
    expect(rows.some((r) => r.node.name === '')).toBe(false);
    const ai = rows.find((r) => r.node.file?.path === 'sdk/AiHelp/');
    expect(ai?.node.name).toBe('AiHelp');
    expect(rows.filter((r) => !r.node.file && r.node.path === 'sdk/AiHelp')).toHaveLength(0);
  });

  it('every row has its own key, folders open or closed (duplicate keys left stale rows on screen)', () => {
    const tree = buildTree(files);
    const states: Record<string, boolean>[] = [{}, { 'tree:unstaged:sdk': true }, { 'tree:unstaged:src': true, 'tree:unstaged:libs': true }];
    for (const collapsed of states) {
      const keys = flatten(tree, 'unstaged', collapsed).map(rowKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
