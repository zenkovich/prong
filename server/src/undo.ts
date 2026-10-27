import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './state.js';
import type { Repo } from './git/repo.js';
import { inRuns } from './git/run.js';

/**
 * Discarding is the one change git cannot take back: the files are copied aside first (the working-tree version
 * of each changed file, untracked ones too, and which ones were deleted), so "Undo" puts them back as they were.
 * Copies live in the engine's state folder for a week; a discard too large to copy (over 200 MB or 20 000 files)
 * simply has no undo.
 */
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 20_000;
const KEEP_MS = 7 * 24 * 3600_000;

interface Manifest {
  dir: string;
  at: number;
  /** files copied aside (paths inside the repository) */
  files: string[];
  /** files that were deleted in the working tree: deleted again by the undo */
  absent: string[];
}

const undoRoot = () => path.join(STATE_DIR(), 'undo');
const tokenDir = (token: string) => {
  if (!/^[a-z0-9-]{6,64}$/.test(token)) throw new Error('bad undo token');
  return path.join(undoRoot(), token);
};

function prune() {
  try {
    for (const d of readdirSync(undoRoot())) {
      const p = path.join(undoRoot(), d);
      if (Date.now() - statSync(p).mtimeMs > KEEP_MS) rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* nothing kept yet */
  }
}

/** every file under a folder of the working tree, skipping nested repositories' .git */
function walk(abs: string, rel: string, out: string[]) {
  for (const name of readdirSync(abs)) {
    if (name === '.git') continue;
    const a = path.join(abs, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(a);
    if (st.isDirectory()) walk(a, r, out);
    else out.push(r);
  }
}

/** copies aside what discarding `paths` (all changes when null) would lose; the token to undo it, or null */
export async function saveForUndo(repo: Repo, paths: string[] | null): Promise<string | null> {
  prune();
  // the working-tree side of every change: modified and untracked files, and the ones deleted from disk
  // (a folder's files in runs that fit a command line)
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames'];
  let listed = '';
  for (const run of paths ? inRuns(paths) : [null]) {
    const r = await repo.git(run ? [...args, '--', ...run] : args, { allowFail: true });
    if (r.code !== 0) return null;
    listed += r.stdout;
  }
  const files: string[] = [];
  const absent: string[] = [];
  for (const entry of [...new Set(listed.split('\0').filter(Boolean))]) {
    const xy = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (!rel || rel.includes('..')) continue;
    const abs = path.join(repo.dir, rel);
    if (xy[1] === 'D' || (!existsSync(abs) && xy !== '??')) absent.push(rel);
    else if (existsSync(abs)) {
      if (lstatSync(abs).isDirectory()) walk(abs, rel, files);
      else files.push(rel);
    }
  }
  if (!files.length && !absent.length) return null;
  if (files.length > MAX_FILES) return null;
  let bytes = 0;
  for (const f of files) {
    bytes += lstatSync(path.join(repo.dir, f)).size;
    if (bytes > MAX_BYTES) return null;
  }
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = tokenDir(token);
  mkdirSync(path.join(dir, 'files'), { recursive: true });
  for (const f of files) cpSync(path.join(repo.dir, f), path.join(dir, 'files', f), { recursive: false, verbatimSymlinks: true });
  const m: Manifest = { dir: repo.dir, at: Date.now(), files, absent };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return token;
}

/** puts the copied files back (and deletes again what was deleted); the copies are then dropped */
export function restoreFromUndo(repo: Repo, token: string): { restored: number } {
  const dir = tokenDir(token);
  if (!existsSync(path.join(dir, 'manifest.json'))) throw new Error('The copies of the discarded files are gone: this discard can no longer be undone.');
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (path.resolve(m.dir) !== path.resolve(repo.dir)) throw new Error('These copies belong to another repository.');
  for (const f of m.files) {
    const to = path.join(repo.dir, f);
    if (!to.startsWith(path.resolve(repo.dir) + path.sep)) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(path.join(dir, 'files', f), to, { force: true, verbatimSymlinks: true });
  }
  for (const f of m.absent) {
    const p = path.join(repo.dir, f);
    if (p.startsWith(path.resolve(repo.dir) + path.sep)) rmSync(p, { force: true });
  }
  rmSync(dir, { recursive: true, force: true });
  return { restored: m.files.length + m.absent.length };
}
