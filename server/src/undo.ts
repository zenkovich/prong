import { constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, cp, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './state.js';
import type { DiscardPlan, Repo } from './git/repo.js';
import { runGit, StoppedError, stopRequested } from './git/run.js';

/**
 * Discarding is the one change git cannot take back: what it would lose is kept aside first (the working-tree version
 * of each changed file, untracked ones too, which ones were deleted, and where a submodule moved back was), so "Undo"
 * puts it back as it was. Kept in the engine's state folder for a week.
 *
 * On the disk of the repository (the usual case) nothing is copied: the files the discard is about to overwrite or
 * delete are moved there (a rename), a whole untracked folder in one go, so a discard of 12 000 files keeps its undo
 * at almost no cost. From another disk they are copied, and a discard too large to copy (over 200 MB or 20 000 files)
 * has no undo.
 */
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 20_000;
const KEEP_MS = 7 * 24 * 3600_000;
/** file operations side by side: renames and deletions of thousands of files go 2–3× faster than one at a time */
const PARALLEL = 8;

interface Manifest {
  dir: string;
  at: number;
  /** what was kept aside, paths inside the repository: files, or whole folders */
  files: string[];
  /** files that were deleted in the working tree: deleted again by the undo */
  absent: string[];
  /** submodules moved back to their recorded commit: where they were (a branch, else the commit) */
  heads?: { path: string; head: string; branch: string | null }[];
  /** submodules whose staged changes went too: their index as a tree, put back with `read-tree` */
  indexes?: { path: string; tree: string }[];
}

const undoRoot = () => path.join(STATE_DIR(), 'undo');
const tokenDir = (token: string) => {
  if (!/^[a-z0-9-]{6,64}$/.test(token)) throw new Error('bad undo token');
  return path.join(undoRoot(), token);
};
const newToken = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

/** `fn` over `items`, `n` at a time; `stoppable`: ends when the user stops the action (what was done is undone by the caller) */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>, stoppable = false) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        if (stoppable && stopRequested()) throw new StoppedError();
        await fn(items[next++]);
      }
    }),
  );
}
/** each folder the paths go into, made once */
function makeParents(paths: string[], root: string) {
  for (const d of new Set(paths.map((p) => path.dirname(path.join(root, p))))) mkdirSync(d, { recursive: true });
}
/** one file copied: a clone where the disk can (APFS copy-on-write), else a copy; a symbolic link as a link */
async function copyOne(from: string, to: string) {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) await symlink(await readlink(from), to);
  else if (st.isDirectory()) await cp(from, to, { recursive: true, verbatimSymlinks: true });
  else await copyFile(from, to, constants.COPYFILE_FICLONE);
}
const sameDisk = (a: string, b: string) => {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
};

/** what a discard would lose: the working-tree side of each change (a whole untracked folder as one entry), the tracked files deleted on disk, the submodules moved back */
function lossOf(repo: Repo, plan: DiscardPlan) {
  const entries: string[] = [];
  const absent: string[] = [];
  const add = (p: DiscardPlan, prefix: string) => {
    const gone = new Set(p.absent);
    for (const rel of [...p.restore, ...p.remove]) {
      const r = prefix + rel.replace(/\/+$/, '');
      if (!r || r.split('/').includes('..')) continue;
      if (gone.has(rel)) absent.push(r);
      else if (existsSync(path.join(repo.dir, r)) || lstatOk(path.join(repo.dir, r))) entries.push(r);
    }
  };
  add(plan, '');
  const heads: NonNullable<Manifest['heads']> = [];
  for (const sm of plan.submodules) {
    if (sm.inner) add(sm.inner, `${sm.path}/`);
    else heads.push({ path: sm.path, head: sm.head, branch: sm.branch });
  }
  return { entries, absent, heads };
}
/**
 * The index of every submodule whose staged changes go too (Discard's tick) kept as a tree object, so Undo puts the
 * index back as it was (`read-tree`) and not only the files. A submodule whose index cannot be written (a conflict in
 * it) is left out: its files still come back.
 */
async function indexesOf(repo: Repo, plan: DiscardPlan) {
  const out: NonNullable<Manifest['indexes']> = [];
  const root = path.resolve(repo.dir) + path.sep;
  for (const sm of plan.submodules) {
    if (!sm.inner?.reset) continue;
    const cwd = path.join(repo.dir, sm.path);
    if (!cwd.startsWith(root)) continue;
    const r = await runGit(['write-tree'], { cwd, allowFail: true });
    const tree = r.stdout.trim();
    if (r.code === 0 && /^[0-9a-f]{40,64}$/.test(tree)) out.push({ path: sm.path, tree });
  }
  return out;
}
/** a dangling symbolic link exists for lstat, not for existsSync */
const lstatOk = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Discards as `plan` says, with a way back: the token for Undo (null when nothing is kept: nothing to lose, or —
 * `tooLarge` — too much to copy from another disk) and the nested repositories left alone. Should the discard fail half way, what was
 * moved aside goes back first.
 */
export async function discardWithUndo(repo: Repo, plan: DiscardPlan): Promise<{ undo: string | null; kept: string[]; tooLarge: boolean }> {
  prune();
  const loss = lossOf(repo, plan);
  // read before the discard: afterwards the submodules' indexes are already back to HEAD
  const indexes = await indexesOf(repo, plan);
  if (!loss.entries.length && !loss.absent.length && !loss.heads.length && !indexes.length) return { undo: null, tooLarge: false, ...(await repo.applyDiscard(plan)) };
  mkdirSync(undoRoot(), { recursive: true });
  if (!sameDisk(repo.dir, undoRoot())) {
    const undo = await saveCopies(repo, loss, indexes);
    return { undo, tooLarge: !undo, ...(await repo.applyDiscard(plan)) };
  }
  const token = newToken();
  const dir = tokenDir(token);
  const store = path.join(dir, 'files');
  makeParents(loss.entries, store);
  const moved: string[] = [];
  try {
    // stopped half way (the queue's Stop): what was moved goes back below
    await pool(
      loss.entries,
      PARALLEL,
      async (rel) => {
        await rename(path.join(repo.dir, rel), path.join(store, rel));
        moved.push(rel);
      },
      true,
    );
    const m: Manifest = { dir: repo.dir, at: Date.now(), files: loss.entries, absent: loss.absent, heads: loss.heads, indexes };
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    const { kept } = await repo.applyDiscard(plan);
    return { undo: token, kept, tooLarge: false };
  } catch (e) {
    makeParents(moved, repo.dir);
    await pool(moved, PARALLEL, async (rel) => {
      const to = path.join(repo.dir, rel);
      await rm(to, { recursive: true, force: true });
      await rename(path.join(store, rel), to);
    });
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** copies of what is lost (another disk, a hunk): within the limits, else no undo */
async function saveCopies(repo: Repo, loss: ReturnType<typeof lossOf>, indexes: NonNullable<Manifest['indexes']> = []): Promise<string | null> {
  const files: string[] = [];
  for (const e of loss.entries) {
    const abs = path.join(repo.dir, e);
    if (lstatSync(abs).isDirectory()) walk(abs, e, files);
    else files.push(e);
  }
  if (files.length > MAX_FILES) return null;
  let bytes = 0;
  for (const f of files) {
    bytes += lstatSync(path.join(repo.dir, f)).size;
    if (bytes > MAX_BYTES) return null;
  }
  const token = newToken();
  const dir = tokenDir(token);
  const store = path.join(dir, 'files');
  mkdirSync(store, { recursive: true });
  makeParents(files, store);
  await pool(files, PARALLEL, (f) => copyOne(path.join(repo.dir, f), path.join(store, f)));
  const m: Manifest = { dir: repo.dir, at: Date.now(), files, absent: loss.absent, heads: loss.heads, indexes };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return token;
}

/**
 * Copies aside what discarding would lose, leaving the working tree as it is (a hunk's discard changes only part of
 * a file). `what`: a discard's plan, or the paths to plan for (all changes when null). The token, or null.
 */
export async function saveForUndo(repo: Repo, what: DiscardPlan | string[] | null): Promise<string | null> {
  prune();
  const plan = what && !Array.isArray(what) ? what : await repo.discardPlan(what);
  const loss = lossOf(repo, plan);
  if (!loss.entries.length && !loss.absent.length && !loss.heads.length) return null;
  return saveCopies(repo, loss);
}

/** puts back what was kept (and deletes again what was deleted, moves submodules back); the copies are then dropped */
export async function restoreFromUndo(repo: Repo, token: string): Promise<{ restored: number }> {
  const dir = tokenDir(token);
  if (!existsSync(path.join(dir, 'manifest.json'))) throw new Error('The copies of the discarded files are gone: this discard can no longer be undone.');
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (path.resolve(m.dir) !== path.resolve(repo.dir)) throw new Error('These copies belong to another repository.');
  const root = path.resolve(repo.dir) + path.sep;
  // the submodules first (their checkout would overwrite the files put back)
  for (const h of m.heads ?? []) {
    const sub = path.join(repo.dir, h.path);
    if (sub.startsWith(root)) await runGit(['checkout', '-q', h.branch ?? h.head], { cwd: sub });
  }
  const store = path.join(dir, 'files');
  const files = m.files.filter((f) => path.join(repo.dir, f).startsWith(root));
  const move = sameDisk(store, repo.dir);
  makeParents(files, repo.dir);
  await pool(files, PARALLEL, async (f) => {
    const to = path.join(repo.dir, f);
    await rm(to, { recursive: true, force: true });
    if (move) await rename(path.join(store, f), to);
    else await copyOne(path.join(store, f), to);
  });
  await pool(
    m.absent.map((f) => path.join(repo.dir, f)).filter((p) => p.startsWith(root)),
    PARALLEL,
    (p) => rm(p, { force: true }),
  );
  // the submodules whose staged changes went too: their index as it was (the files are back already)
  for (const i of m.indexes ?? []) {
    const sub = path.join(repo.dir, i.path);
    if (sub.startsWith(root)) await runGit(['read-tree', i.tree], { cwd: sub, allowFail: true });
  }
  rmSync(dir, { recursive: true, force: true });
  // files put back inside submodules show at the next status
  repo.forgetSubmoduleChanges();
  return { restored: m.files.length + m.absent.length + (m.heads?.length ?? 0) };
}
