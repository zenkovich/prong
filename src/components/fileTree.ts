import type { FileChange } from '../git/types';

/** Files of a change as folders (single-child folders squashed) and as the rows a list shows. */

export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  file?: FileChange;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function buildTree(files: FileChange[]): TreeNode[] {
  const root: TreeNode[] = [];
  // a lookup per folder: a merge can list 50 000 files, a linear search among siblings made this quadratic
  const index = new Map<TreeNode[], Map<string, TreeNode>>();
  for (const f of files) {
    const parts = f.path.split('/');
    let level = root;
    let p = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const leaf = i === parts.length - 1;
      p = p ? `${p}/${name}` : name;
      let byName = index.get(level);
      if (!byName) index.set(level, (byName = new Map()));
      const key = (leaf ? 'f:' : 'd:') + name;
      let n = byName.get(key);
      if (!n) {
        n = { name, path: p, children: [] };
        level.push(n);
        byName.set(key, n);
      }
      if (leaf) n.file = f;
      level = n.children;
    }
  }
  // collapse single-child folders
  const squash = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      while (!n.file && n.children.length === 1 && !n.children[0].file) {
        const c = n.children[0];
        n.name = `${n.name}/${c.name}`;
        n.path = c.path;
        n.children = c.children;
      }
      squash(n.children);
    }
    nodes.sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0) || collator.compare(a.name, b.name));
  };
  squash(root);
  return root;
}


export interface FlatRow {
  node: TreeNode;
  depth: number;
  open: boolean;
}
/** depth-first rows of the tree; children of closed folders are left out */
export function flatten(tree: TreeNode[], area: string, collapsed: Record<string, boolean>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      const open = !n.file && !collapsed[`tree:${area}:${n.path}`];
      out.push({ node: n, depth, open });
      if (open) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

