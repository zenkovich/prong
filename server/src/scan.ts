import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Folders never descended into while looking for repositories. */
const SKIP = new Set(['node_modules', '.git', 'Library', '.Trash', 'Pods', 'DerivedData', 'build', 'dist', '.cache', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.expo']);

export interface ScannedRepo {
  path: string;
  name: string;
  /** nested inside another repository (submodule or vendored checkout) */
  nested: boolean;
}

/**
 * Finds git working copies under `root` up to `depth` levels deep. A repository is a directory with
 * a `.git` entry (directory or file for worktrees/submodules). Submodules are reported as nested.
 */
export function scanRepos(root: string, depth = 3, limit = 500): ScannedRepo[] {
  const out: ScannedRepo[] = [];
  const walk = (dir: string, level: number, insideRepo: boolean) => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const isRepo = entries.includes('.git');
    if (isRepo) out.push({ path: dir, name: path.basename(dir), nested: insideRepo });
    // do not descend into a repository: its submodules and vendored checkouts belong to it
    if (isRepo || level >= depth) return;
    for (const e of entries) {
      if (e.startsWith('.') || SKIP.has(e)) continue;
      const full = path.join(dir, e);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(full, level + 1, insideRepo || isRepo);
    }
  };
  if (!existsSync(root)) return [];
  walk(root, 0, false);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
