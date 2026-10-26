import { describe, expect, it } from 'vitest';
import type { Submodule } from '../git/GitClient';
import { countLeaves, pathTree } from './pathTree';

const sm = (path: string) => ({ path, name: path, url: '', sha: 'x', state: 'ok' }) as Submodule;
const show = (nodes: ReturnType<typeof pathTree>, d = 0): string[] => nodes.flatMap((n) => [`${'  '.repeat(d)}${n.name}${n.sub ? '' : '/'}`, ...show(n.children, d + 1)]);

describe('submodule tree', () => {
  it('groups by folder, folders first, squashing single-child chains', () => {
    const tree = pathTree([sm('sdk/AppsFlyer'), sm('engine'), sm('libs/vso'), sm('sdk/Firebase'), sm('docs/vso/docs')]);
    expect(show(tree)).toEqual(['docs/vso/', '  docs', 'libs/', '  vso', 'sdk/', '  AppsFlyer', '  Firebase', 'engine']);
    expect(countLeaves(tree[2])).toBe(2);
  });
  it('a submodule inside another submodule folder keeps both', () => {
    expect(show(pathTree([sm('a'), sm('a/b')]))).toEqual(['a/', '  b', 'a']);
  });
});
