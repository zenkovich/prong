import type { LfsFiles, LfsPick } from '../git/GitClient';

/**
 * The Git LFS files a working copy holds as pointers, as folders for the restore dialog: files are only counted
 * (township has 10 000 of them), folders with nothing of their own but one subfolder are squashed
 * ("android/app/src/main/res/raw"), as in Changes.
 */

export type LfsMissing = LfsFiles['missing'][number];

export interface LfsFolder {
  /** shown name (squashed folders joined with "/") */
  name: string;
  /** full path, '' for the repository's top */
  path: string;
  folders: LfsFolder[];
  /** the files right in this folder */
  own: LfsMissing[];
  /** files below it, its own and its subfolders' */
  count: number;
  bytes: number;
  /** what of `bytes` is not on this machine yet */
  toDownload: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function lfsTree(missing: LfsMissing[]): LfsFolder {
  const root: LfsFolder = { name: '', path: '', folders: [], own: [], count: 0, bytes: 0, toDownload: 0 };
  const byPath = new Map<string, LfsFolder>([['', root]]);
  const folderOf = (dir: string): LfsFolder => {
    let f = byPath.get(dir);
    if (f) return f;
    const cut = dir.lastIndexOf('/');
    const parent = folderOf(cut < 0 ? '' : dir.slice(0, cut));
    f = { name: dir.slice(cut + 1), path: dir, folders: [], own: [], count: 0, bytes: 0, toDownload: 0 };
    parent.folders.push(f);
    byPath.set(dir, f);
    return f;
  };
  for (const m of missing) {
    const cut = m.path.lastIndexOf('/');
    folderOf(cut < 0 ? '' : m.path.slice(0, cut)).own.push(m);
  }
  const sum = (f: LfsFolder) => {
    for (const c of f.folders) sum(c);
    f.count = f.own.length + f.folders.reduce((n, c) => n + c.count, 0);
    f.bytes = f.own.reduce((n, m) => n + m.size, 0) + f.folders.reduce((n, c) => n + c.bytes, 0);
    f.toDownload = f.own.reduce((n, m) => n + (m.downloaded ? 0 : m.size), 0) + f.folders.reduce((n, c) => n + c.toDownload, 0);
  };
  sum(root);
  const squash = (f: LfsFolder) => {
    for (const c of f.folders) {
      while (!c.own.length && c.folders.length === 1) {
        const only = c.folders[0];
        c.name = `${c.name}/${only.name}`;
        c.path = only.path;
        c.own = only.own;
        c.folders = only.folders;
      }
      squash(c);
    }
    f.folders.sort((a, b) => collator.compare(a.name, b.name));
  };
  squash(root);
  return root;
}

/** every file below a folder */
export function filesOf(f: LfsFolder): LfsMissing[] {
  return [...f.own, ...f.folders.flatMap(filesOf)];
}

/** how many of each folder's files are picked (by folder path) */
export function pickedCounts(root: LfsFolder, picked: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (f: LfsFolder): number => {
    const n = f.own.reduce((k, m) => k + (picked.has(m.path) ? 1 : 0), 0) + f.folders.reduce((k, c) => k + walk(c), 0);
    out.set(f.path, n);
    return n;
  };
  walk(root);
  return out;
}

/**
 * What the picked files are as a restore request: every LFS file when all are picked, otherwise the folders picked
 * whole (with all below them) and the other picked files by name.
 */
export function pickOf(root: LfsFolder, picked: Set<string>): { pick: LfsPick; count: number; bytes: number; toDownload: number } {
  const counts = pickedCounts(root, picked);
  const all = filesOf(root).filter((m) => picked.has(m.path));
  const totals = { count: all.length, bytes: all.reduce((n, m) => n + m.size, 0), toDownload: all.reduce((n, m) => n + (m.downloaded ? 0 : m.size), 0) };
  if (root.count > 0 && counts.get('') === root.count) return { pick: { all: true }, ...totals };
  const folders: string[] = [];
  const files: string[] = [];
  const walk = (f: LfsFolder) => {
    const n = counts.get(f.path) ?? 0;
    if (!n) return;
    if (f.path && n === f.count) return void folders.push(f.path);
    for (const m of f.own) if (picked.has(m.path)) files.push(m.path);
    for (const c of f.folders) walk(c);
  };
  walk(root);
  return { pick: { folders, files }, ...totals };
}
