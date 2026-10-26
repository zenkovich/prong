import type { Submodule } from '../git/GitClient';

/** Submodule paths as a folder tree for the sidebar (pure). */
export interface PathNode {
  name: string;
  full: string;
  children: PathNode[];
  sub?: Submodule;
}
/** submodule paths as a folder tree; single-child folders are squashed ("libs/core" stays one row) */
export function pathTree(subs: Submodule[]): PathNode[] {
  const root: PathNode[] = [];
  for (const s of subs) {
    const parts = s.path.split('/');
    let level = root;
    let full = '';
    parts.forEach((p, i) => {
      full = full ? `${full}/${p}` : p;
      const leaf = i === parts.length - 1;
      let n = level.find((x) => x.name === p && !!x.sub === leaf);
      if (!n) {
        n = { name: p, full, children: [] };
        level.push(n);
      }
      if (leaf) n.sub = s;
      level = n.children;
    });
  }
  const squash = (nodes: PathNode[]): PathNode[] =>
    nodes.map((n) => {
      let cur = n;
      while (!cur.sub && cur.children.length === 1 && !cur.children[0].sub) cur = { ...cur.children[0], name: `${cur.name}/${cur.children[0].name}` };
      return { ...cur, children: squash(cur.children) };
    });
  const sort = (nodes: PathNode[]) => {
    nodes.sort((a, b) => Number(!!a.sub) - Number(!!b.sub) || a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
    return nodes;
  };
  return sort(squash(root));
}
export const countLeaves = (n: PathNode): number => (n.sub ? 1 : n.children.reduce((a, c) => a + countLeaves(c), 0));
