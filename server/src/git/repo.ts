import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { Commit, FileChange, FileStatus, Hunk, RepoSnapshot, Sha, Stash, SubmoduleChanges } from '../types.js';
import { hunkPatch, joinSubmoduleChanges, kindOf, LFS_POINTER_MAX, type LfsPointer, LOG_FORMAT, parseLfsPointer, parseDiff, parseLog, parseNumstat, parseRaw, parseRefs, parseRemotes, parseStashList, parseStatus, REC, REF_FORMAT, STASH_FORMAT } from './parse.js';
import { inRuns, progressOf, runGit, runGitLines, runGitToFile, RunOptions, withoutProgress } from './run.js';
import type { NetAuth } from '../auth.js';

export type Progress = (line: string, progress: number | null) => void;

export interface RebaseTodoItem {
  sha: Sha;
  action: 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
  message?: string;
}

export interface OpState {
  kind: 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  /** branch being rebased, when known */
  detail?: string;
  /** the message git prepared for the commit that ends a merge, cherry-pick or revert (MERGE_MSG, comments left out) */
  message?: string;
}

const LARGE_DIFF_LINES = 4000;

/** files listed from wholly untracked folders, at most: past this a folder stays one row */
export const UNTRACKED_LIST_MAX = 5000;

/**
 * The submodules' own changes (see submoduleChanges): a read this recent is reused; the list waits this long for a
 * read under way before it goes with the last one known (not at all where the last read took longer: a big
 * submodule's scan takes seconds); this many submodules are read at once; this many of a submodule's files are named.
 */
const INSIDE_FRESH_MS = 1500;
export const INSIDE_WAIT_MS = { value: 400 };
const INSIDE_JOBS = 4;
export const INSIDE_FILES = 50;
/** the last read of each repository's submodules (by folder), and the read under way */
const insideCache = new Map<string, { at: number; list: SubmoduleChanges[]; took?: number; pending?: Promise<SubmoduleChanges[]> }>();
/** a new file's lines are counted (its "+N") up to this size, and up to this much is read per status */
const UNTRACKED_COUNT_FILE_BYTES = 4 * 1024 * 1024;
const UNTRACKED_COUNT_TOTAL_BYTES = 48 * 1024 * 1024;
/** counts by absolute path, kept while the file's mtime and size stay */
const untrackedCounts = new Map<string, { stamp: string; lines: number; binary: boolean }>();

/**
 * The "+N" of new (untracked) files, which `git diff --numstat` does not cover: their lines, counted here; a file
 * with a NUL byte is binary. Files too big for it keep 0 and are marked `large` (the diff says so, with "load anyway").
 */
function countUntrackedLines(dir: string, list: FileChange[]) {
  let budget = UNTRACKED_COUNT_TOTAL_BYTES;
  for (const f of list) {
    if (f.status !== '?' || f.path.endsWith('/') || f.kind !== 'text') continue;
    const abs = path.join(dir, f.path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const stamp = `${st.mtimeMs}:${st.size}`;
    let c = untrackedCounts.get(abs);
    if (!c || c.stamp !== stamp) {
      if (st.size > UNTRACKED_COUNT_FILE_BYTES || st.size > budget) {
        if (st.size > UNTRACKED_COUNT_FILE_BYTES) f.kind = 'large';
        continue;
      }
      budget -= st.size;
      const buf = readFileSync(abs);
      const binary = buf.subarray(0, 8000).includes(0);
      let lines = 0;
      if (!binary) {
        for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
        if (buf.length && buf[buf.length - 1] !== 10) lines++;
      }
      c = { stamp, lines, binary };
      if (untrackedCounts.size > 50_000) untrackedCounts.clear();
      untrackedCounts.set(abs, c);
    }
    if (c.binary) f.kind = 'binary';
    else f.additions = c.lines;
  }
}

/** a commit with more files than this is listed first; each file's diff is read when it is selected */
export const COMMIT_PATCH_FILES = 300;
/** a commit (or stash) patch bigger than this is not sent at once either */
export const COMMIT_PATCH_BYTES = 8 * 1024 * 1024;
/** one file's diff is read up to this size */
export const FILE_DIFF_BYTES = 24 * 1024 * 1024;
/** revision name for the working copy in mediaSides / blobInfo / the blob endpoint */
export const WORKTREE = 'WORKTREE';
export interface BlobSide {
  rev: string;
  file: string;
  bytes: number;
  /** changes whenever the content does: object id, or mtime+size for the working copy (cache-busting) */
  version: string;
  oid?: string;
  /**
   * The file is in Git LFS: git holds a pointer to an object by its sha256. `bytes` is the real file's size;
   * `local`: the object is on this machine (otherwise the preview offers to download it); `pointerFile`: the working
   * copy still holds the pointer, not the file.
   */
  lfs?: { oid: string; size: number; local: boolean; pointerFile?: boolean };
}
/** what `lfsFiles` reports: the Git LFS files of HEAD the working copy holds as pointers */
export interface LfsFiles {
  installed: boolean;
  version?: string;
  /** LFS files in HEAD */
  total: number;
  /** still pointers in the working copy; `downloaded`: the object is here, only the checkout is missing */
  missing: { path: string; size: number; downloaded: boolean }[];
  /** what the repository leaves out of downloads (`lfs.fetchexclude`, its own config and .lfsconfig) */
  excluded: string[];
}
/**
 * What to restore: every LFS file, or folders (with everything below them) and single files. Paths are
 * repository-relative. A folder's own files without its subfolders are named one by one: git-lfs reads `dir/*` as
 * gitignore does, and that takes in the subfolders too.
 */
export interface LfsPick {
  all?: boolean;
  folders?: string[];
  files?: string[];
}
/** a path as a git-lfs include pattern: its glob characters escaped; a comma (the list separator) matches as `?` */
const lfsGlob = (p: string) => p.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/,/g, '?');
/** the --include patterns of a pick: `dir/**` and `file` */
export function lfsPatterns(pick: LfsPick): string[] {
  const ok = (p: unknown): p is string => typeof p === 'string' && safeRelPath(p) && !p.startsWith('-') && !/[\n\r]/.test(p);
  return [
    ...(pick.folders ?? []).filter(ok).map((f) => `${lfsGlob(f.replace(/\/+$/, ''))}/**`),
    ...(pick.files ?? []).filter(ok).map((f) => lfsGlob(f)),
  ];
}
/** paths in groups that fit on a command line */
function chunkPaths(paths: string[], limit = 60_000): string[][] {
  const out: string[][] = [];
  let len = 0;
  for (const p of paths) {
    if (!out.length || len + p.length > limit) {
      out.push([]);
      len = 0;
    }
    out[out.length - 1].push(p);
    len += p.length + 1;
  }
  return out;
}
/** a preview's copy of an LFS object: by its id, with the file's extension so other apps know the type */
const lfsCachePath = (oid: string, file: string) => path.join(stateDir(), 'cache', 'blobs', `lfs-${oid}${path.extname(file).toLowerCase()}`);
/** what each repository's git-lfs store is (rev-parse once per repository, not on every preview) */
const lfsStores = new Map<string, Promise<string>>();
/** a preview of an LFS file whose object is not on this machine */
export class LfsNotDownloaded extends Error {
  constructor(file: string) {
    super(`${file} is in Git LFS and not downloaded yet`);
  }
}
const MIME: Record<string, string> = {
  svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', png: 'image/png',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain; charset=utf-8',
};
export function mimeOf(file: string) {
  return MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}
/** a repository-relative path that cannot escape the repository */
export function safeRelPath(file: string) {
  if (!file || path.isAbsolute(file) || file.includes('\0')) return false;
  const norm = path.posix.normalize(file.replace(/\\/g, '/'));
  return norm !== '..' && !norm.startsWith('../') && !norm.startsWith('/');
}
const stateDir = () => process.env.PRONG_STATE_DIR ?? path.join(homedir(), '.prong');
export function humanBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const CACHE_DIR = path.join(process.env.PRONG_STATE_DIR ?? path.join(homedir(), '.prong'), 'cache');
const perfConfigured = new Set<string>();
/** numbers the temporary files blobs are extracted into */
let blobSeq = 0;
const logCache = new Map<string, { sig: string; limit: number; commits: Commit[] }>();
const snapCache = new Map<string, unknown>();

export interface Submodule {
  path: string;
  name: string;
  url: string;
  sha: string;
  /** ' ' in sync, '-' not initialized, '+' checked-out commit differs from index, 'U' conflicts */
  state: 'ok' | 'uninitialized' | 'modified' | 'conflict';
  describe?: string;
  /** changes in its own files, as last read (see submoduleChanges) */
  inside?: { modified: number; untracked: number };
}

/** what a batch operation did: names done, and each failure with git's reason */
export interface BatchResult {
  done: string[];
  failed: { name: string; error: string }[];
}

/**
 * `git push --porcelain` lines ("<flag>\t<from>:<to>\t<summary>") → status per destination ref.
 * Flags: " " fast-forward, "+" forced, "-" deleted, "*" new, "=" up to date, "!" rejected.
 */
export function parsePushPorcelain(out: string): Map<string, { ok: boolean; summary: string }> {
  const m = new Map<string, { ok: boolean; summary: string }>();
  for (const line of out.split('\n')) {
    const p = line.split('\t');
    if (p.length < 3 || p[0].length !== 1) continue;
    const to = p[1].slice(p[1].indexOf(':') + 1);
    m.set(to, { ok: p[0] !== '!', summary: p[2].trim() });
  }
  return m;
}

/**
 * The revisions a history read walks: `--all` without the stash. `git log --all` also walks refs/stash, and each
 * stash's own commits ("On main: …", "index on main: …", "untracked files on …") showed in the graph as commits.
 */
export function historyRevs(revs: string[]): string[] {
  return revs.flatMap((r) => (r === '--all' ? ['--exclude=refs/stash', '--all'] : [r]));
}

/** All git operations for one working copy. Stateless: every call shells out to git. */
export class Repo {
  constructor(public readonly dir: string) {}

  static isRepo(dir: string): boolean {
    try {
      return statSync(dir).isDirectory() && existsSync(path.join(dir, '.git'));
    } catch {
      return false;
    }
  }

  git(args: string[], opts: Partial<RunOptions> = {}) {
    return runGit(args, { cwd: this.dir, ...opts });
  }

  /**
   * How network commands of a folder sign in (set by the API from the repository settings; null: git's defaults).
   * Submodule commands started by git (submodule update) inherit it through the environment and `-c` settings.
   */
  static auth: ((dir: string) => Promise<NetAuth | null>) | null = null;
  /** a command that talks to a remote: with the repository's SSH key or account */
  async net(args: string[], opts: Partial<RunOptions> = {}, override?: NetAuth | null) {
    const a = override !== undefined ? override : Repo.auth ? await Repo.auth(this.dir) : null;
    const cfg = (a?.config ?? []).flatMap((c) => ['-c', c]);
    return this.git([...cfg, ...args], { ...opts, env: { ...(opts.env ?? {}), ...(a?.env ?? {}) } });
  }
  /** can the remote be reached with these credentials? (`git ls-remote <remote> HEAD`, read-only) */
  async testConnection(remote: string, auth?: NetAuth | null) {
    const r = await this.net(['ls-remote', remote, 'HEAD'], { allowFail: true, timeoutMs: 30000 }, auth);
    return { ok: r.code === 0, output: (r.stderr || r.stdout).trim() };
  }

  // ---------- reading ----------

  /** --date-order keeps parents after children (graph-safe) while showing recent work first, so HEAD lands on the first page. */
  async log(limit = 500, revs: string[] = ['--all']): Promise<Commit[]> {
    const r = await this.git(['log', `--format=${LOG_FORMAT}`, '--date-order', `-n${limit}`, ...historyRevs(revs), '--']);
    return parseLog(r.stdout);
  }

  async head(): Promise<Sha> {
    const r = await this.git(['rev-parse', 'HEAD'], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : '';
  }

  async refs() {
    const r = await this.git(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
    const refs = parseRefs(r.stdout);
    // on a case-insensitive disk a branch made as `Tmp/x` next to an existing `tmp/` folder is stored (and listed)
    // as `tmp/x` while HEAD still says `Tmp/x`: git marks no branch current, so the one HEAD names in another case is
    if (!refs.some((x) => x.kind === 'branch' && x.current)) {
      const head = (await this.git(['symbolic-ref', '-q', 'HEAD'], { allowFail: true })).stdout.trim();
      const name = head.startsWith('refs/heads/') ? head.slice('refs/heads/'.length).toLowerCase() : '';
      const same = name ? refs.find((x) => x.kind === 'branch' && x.name.toLowerCase() === name) : undefined;
      if (same) same.current = true;
    }
    return refs;
  }
  /**
   * A new branch name as the disk will keep it: with core.ignorecase (macOS) a branch is a file under refs/heads, so
   * `Tmp/x` next to an existing `tmp/` folder lands in that folder and is listed as `tmp/x` — while HEAD and the
   * reflog say `Tmp/x`. Folders that already exist keep their spelling.
   */
  async storedBranchName(name: string): Promise<string> {
    if (!name.includes('/')) return name;
    const ic = (await this.git(['config', '--bool', 'core.ignorecase'], { allowFail: true })).stdout.trim() === 'true';
    if (!ic) return name;
    const names = (await this.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout.split('\n').filter(Boolean);
    const parts = name.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const prefix = parts.slice(0, i + 1).join('/').toLowerCase() + '/';
      const existing = names.find((n) => n.toLowerCase().startsWith(prefix));
      if (existing) parts.splice(0, i + 1, ...existing.split('/').slice(0, i + 1));
    }
    return parts.join('/');
  }

  async remotes() {
    const [r, specs] = await Promise.all([this.git(['remote', '-v']), this.git(['config', '--get-regexp', '^remote\\..*\\.fetch$'], { allowFail: true })]);
    // which remotes fetch every branch (a wildcard refspec): a --single-branch or narrowed clone follows only some,
    // so most of origin's branches never appear in the sidebar until the fetch list is widened
    const wild = new Set(
      specs.stdout
        .split('\n')
        .map((l) => l.match(/^remote\.(.+)\.fetch\s+\+?([^:\s]+)/))
        .filter((m): m is RegExpMatchArray => !!m && m[2] === 'refs/heads/*')
        .map((m) => m[1]),
    );
    return parseRemotes(r.stdout).map((rm) => (wild.has(rm.name) ? rm : { ...rm, narrow: true }));
  }

  async stashes(): Promise<Stash[]> {
    const r = await this.git(['stash', 'list', `--format=${STASH_FORMAT}`]);
    return parseStashList(r.stdout);
  }

  async status() {
    // untracked dirs collapsed and submodule worktrees not scanned: on huge trees this is the difference between 17s
    // and 0.25s. The submodules' own changes are read beside it, each submodule by itself (submoduleChanges)
    const inside = this.submoduleChanges().catch(() => null);
    const r = await this.git(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignore-submodules=dirty', '--no-renames']);
    const st = parseStatus(r.stdout);
    // a wholly untracked folder comes as one entry ("Assets/ImageToUI/"): its files are listed (only those
    // folders are walked, not the whole tree), and new files get their line counts
    st.unstaged = await this.expandUntrackedDirs(st.unstaged);
    countUntrackedLines(this.dir, st.unstaged);
    // a read that takes longer does not hold the list: the last one known goes in, and the client asks for the
    // fresh one (a submodule with edited files used to be missing from Changes, as Fork lists it)
    const took = insideCache.get(this.dir)?.took;
    const wait = took != null && took > INSIDE_WAIT_MS.value ? 0 : INSIDE_WAIT_MS.value;
    const join = async () => {
      const fresh = await Promise.race([inside, new Promise<null>((res) => setTimeout(() => res(null), wait).unref?.())]);
      st.unstaged = joinSubmoduleChanges(st.unstaged, fresh ?? this.knownSubmoduleChanges());
    };
    if (st.unstaged.length + st.staged.length === 0) {
      await join();
      return st;
    }
    // +/- counts without loading hunks; sequential so the two processes do not fight over the index.
    // --no-renames as the status above: a staged `git mv` is listed as D + A, and each gets its own counts
    // (with renames numstat names only the new path, 100% similar: "+0 −0" on both rows)
    const joined = join();
    const [un, idx] = await Promise.all([
      st.unstaged.length ? this.git(['diff', '--numstat', '-z', '--no-renames', '--ignore-submodules=dirty', '--'], { allowFail: true }) : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
      st.staged.length ? this.git(['diff', '--cached', '--numstat', '-z', '--no-renames', '--ignore-submodules=dirty', '--'], { allowFail: true }) : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    ]);
    const unMap = parseNumstat(un.stdout);
    const idxMap = parseNumstat(idx.stdout);
    const put = (f: FileChange, c?: { additions: number; deletions: number; binary?: boolean }) => {
      if (!c) return;
      f.additions = c.additions;
      f.deletions = c.deletions;
      // a binary file named like text (data.bin, a .asset): no "+0 −0", its diff is the binary preview
      if (c.binary && f.kind === 'text') f.kind = 'binary';
    };
    await joined;
    for (const f of st.unstaged) put(f, unMap.get(f.path));
    for (const f of st.staged) put(f, idxMap.get(f.path));
    return st;
  }

  /**
   * The submodules whose own files have changes (edited, new), each read by its own `git status`, a few at a time:
   * the superproject's status skips them (--ignore-submodules=dirty) because git reads them one after another, and a
   * big one alone takes seconds. A read within INSIDE_FRESH_MS is reused and one under way is shared. As git status,
   * it honours `submodule.<name>.ignore` (.git/config over .gitmodules) and then `diff.ignoreSubmodules`.
   */
  async submoduleChanges(maxAge = INSIDE_FRESH_MS): Promise<SubmoduleChanges[]> {
    const c = insideCache.get(this.dir);
    if (c?.pending) return c.pending;
    if (c && Date.now() - c.at < maxAge) return c.list;
    const t0 = Date.now();
    const pending = this.readSubmoduleChanges().then(
      (list) => {
        insideCache.set(this.dir, { at: Date.now(), list, took: Date.now() - t0 });
        return list;
      },
      (e) => {
        insideCache.set(this.dir, { at: c?.at ?? 0, list: c?.list ?? [], took: c?.took });
        throw e;
      },
    );
    insideCache.set(this.dir, { at: c?.at ?? 0, list: c?.list ?? [], took: c?.took, pending });
    return pending;
  }

  /** the last read of submoduleChanges, without reading (none yet: none) */
  knownSubmoduleChanges(): SubmoduleChanges[] {
    return insideCache.get(this.dir)?.list ?? [];
  }

  private async readSubmoduleChanges(): Promise<SubmoduleChanges[]> {
    if (!existsSync(path.join(this.dir, '.gitmodules'))) return [];
    // -z: a name may hold spaces (key and value are split by a newline, entries by NUL)
    const [gm, local] = await Promise.all([
      this.git(['config', '-z', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|ignore)$'], { allowFail: true }),
      this.git(['config', '-z', '--get-regexp', '^(submodule\\..*\\.ignore|diff\\.ignoresubmodules)$'], { allowFail: true }),
    ]);
    const byName = new Map<string, { path?: string; ignore?: string }>();
    const entries = (out: string) => out.split('\0').filter(Boolean).map((e) => [e.slice(0, e.indexOf('\n') < 0 ? e.length : e.indexOf('\n')), e.indexOf('\n') < 0 ? '' : e.slice(e.indexOf('\n') + 1)] as const);
    for (const [k, v] of entries(gm.stdout)) {
      const m = k.match(/^submodule\.(.+)\.(path|ignore)$/);
      if (m) byName.set(m[1], { ...byName.get(m[1]), [m[2]]: v.trim() });
    }
    let fallback = 'none';
    const own = new Map<string, string>();
    for (const [k, v] of entries(local.stdout)) {
      if (k === 'diff.ignoresubmodules') fallback = v.trim();
      const m = k.match(/^submodule\.(.+)\.ignore$/);
      if (m) own.set(m[1], v.trim());
    }
    const subs = [...byName]
      .map(([name, e]) => ({ path: e.path ?? '', ignore: own.get(name) ?? e.ignore ?? fallback }))
      // not checked out: nothing of its own to change
      .filter((s) => s.path && safeRelPath(s.path) && s.ignore !== 'all' && s.ignore !== 'dirty' && existsSync(path.join(this.dir, s.path, '.git')));
    const read = async (s: { path: string; ignore: string }): Promise<SubmoduleChanges | null> => {
      // its own nested submodules count as in git status (a changed one is a changed file here)
      const r = await runGit(['status', '--porcelain=v2', '-z', `--untracked-files=${s.ignore === 'untracked' ? 'no' : 'normal'}`, '--no-renames'], { cwd: path.join(this.dir, s.path), allowFail: true });
      if (r.code !== 0) return null;
      const st = parseStatus(r.stdout);
      const tracked = new Map<string, FileStatus>();
      for (const f of st.staged) tracked.set(f.path, f.status);
      const untracked: string[] = [];
      for (const f of st.unstaged) {
        if (f.status === '?') untracked.push(f.path);
        else tracked.set(f.path, f.status);
      }
      if (!tracked.size && !untracked.length) return null;
      const files = [...[...tracked].map(([p, status]) => ({ path: p, status })), ...untracked.map((p) => ({ path: p, status: '?' as FileStatus }))];
      return { path: s.path, modified: tracked.size, untracked: untracked.length, files: files.slice(0, INSIDE_FILES) };
    };
    const out: (SubmoduleChanges | null)[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(INSIDE_JOBS, subs.length) }, async () => {
        while (next < subs.length) {
          const i = next++;
          out[i] = await read(subs[i]).catch(() => null);
        }
      }),
    );
    return out.filter((x): x is SubmoduleChanges => !!x).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * The files of the untracked folders git names once ("dir/"), in their place; ignored files are left out. A
   * folder past the budget (UNTRACKED_LIST_MAX files in all) stays one entry, and so does a nested repository.
   */
  private async expandUntrackedDirs(list: FileChange[]): Promise<FileChange[]> {
    if (!list.some((f) => f.status === '?' && f.path.endsWith('/'))) return list;
    let budget = UNTRACKED_LIST_MAX;
    const out: FileChange[] = [];
    for (const f of list) {
      if (f.status !== '?' || !f.path.endsWith('/') || budget <= 0) {
        out.push(f);
        continue;
      }
      const files: string[] = [];
      let over = false;
      await runGitLines(
        ['ls-files', '--others', '--exclude-standard', '-z', '--', `:(literal)${f.path}`],
        { cwd: this.dir },
        (p) => {
          if (!p) return;
          files.push(p);
          if (files.length > budget) {
            over = true;
            return false;
          }
        },
        '\0',
      ).catch(() => (over = true));
      // a nested repository lists as itself ("dir/"): nothing to open
      if (over || !files.length || (files.length === 1 && files[0] === f.path)) {
        out.push(f);
        continue;
      }
      budget -= files.length;
      for (const p of files) out.push({ path: p, status: '?', kind: p.endsWith('/') ? 'text' : kindOf(p), additions: 0, deletions: 0 });
    }
    return out;
  }

  /** a clone whose history is cut off (`clone --depth`, `.git/shallow`) */
  async isShallow() {
    const r = await this.git(['rev-parse', '--is-shallow-repository'], { allowFail: true });
    return r.stdout.trim() === 'true';
  }

  async opState(): Promise<OpState> {
    // a submodule's (or a worktree's) .git is a file naming the real folder: a conflict there is shown too
    let g = path.join(this.dir, '.git');
    try {
      if (statSync(g).isFile()) {
        const m = readFileSync(g, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (m) g = path.resolve(this.dir, m[1].trim());
      }
    } catch {
      /* not a repository: nothing in progress */
    }
    if (existsSync(path.join(g, 'rebase-merge')) || existsSync(path.join(g, 'rebase-apply'))) return { kind: 'rebase' };
    const message = () => {
      try {
        const m = readFileSync(path.join(g, 'MERGE_MSG'), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
        return m ? { message: m } : {};
      } catch {
        return {};
      }
    };
    if (existsSync(path.join(g, 'MERGE_HEAD'))) return { kind: 'merge', ...message() };
    if (existsSync(path.join(g, 'CHERRY_PICK_HEAD'))) return { kind: 'cherry-pick', ...message() };
    if (existsSync(path.join(g, 'REVERT_HEAD'))) return { kind: 'revert', ...message() };
    return { kind: 'none' };
  }

  /** One-time per-session performance settings: fsmonitor daemon + untracked cache make status O(changes). */
  async ensurePerfConfig() {
    if (perfConfigured.has(this.dir)) return;
    perfConfigured.add(this.dir);
    for (const [k, v] of [['core.fsmonitor', 'true'], ['core.untrackedCache', 'true']]) {
      const cur = await this.config(k);
      if (cur === null) await this.git(['config', k, v], { allowFail: true });
    }
  }

  private refsSig(refs: { name: string; sha: string }[], head: Sha, limit: number) {
    const h = createHash('sha1');
    // "nostash": logs cached when the stash's commits were still in them are read again
    h.update('nostash|' + head + '|' + limit + '|');
    for (const r of refs) h.update(r.name + '=' + r.sha + ';');
    return h.digest('hex');
  }

  /** Log with an in-memory + on-disk cache keyed by the ref tips: reopening a huge repo is instant. */
  async cachedLog(limit: number, refs: { name: string; sha: string }[], head: Sha): Promise<Commit[]> {
    const sig = this.refsSig(refs, head, limit);
    const mem = logCache.get(this.dir);
    if (mem && mem.sig === sig) return mem.commits;
    const file = path.join(CACHE_DIR, createHash('sha1').update(this.dir).digest('hex') + '.json');
    try {
      const disk = JSON.parse(readFileSync(file, 'utf8')) as { sig: string; commits: Commit[] };
      if (disk.sig === sig) {
        logCache.set(this.dir, { sig, limit, commits: disk.commits });
        return disk.commits;
      }
    } catch {
      /* no disk cache */
    }
    const commits = await this.log(limit);
    logCache.set(this.dir, { sig, limit, commits });
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify({ sig, commits }));
    } catch {
      /* cache is best-effort */
    }
    return commits;
  }

  async snapshot(limit = 300): Promise<RepoSnapshot & { op: OpState; timings: Record<string, number> }> {
    await this.ensurePerfConfig();
    const t0 = Date.now();
    const timed = async <T>(k: string, p: Promise<T>) => {
      const v = await p;
      timings[k] = Date.now() - t0;
      return v;
    };
    const timings: Record<string, number> = {};
    const [refs, head] = await Promise.all([timed('refs', this.refs()), this.head()]);
    const [commits, remotes, stashes, op, shallow] = await Promise.all([timed('log', this.cachedLog(limit, refs, head)), this.remotes(), this.stashes(), this.opState(), this.isShallow()]);
    const st = await timed('status', this.status());
    timings.total = Date.now() - t0;
    // no commit yet: no ref names the branch, git status does ("main" after git init)
    const unborn = !head && st.branch?.head && st.branch.head !== '(detached)' ? st.branch.head : undefined;
    const snap = { commits, refs, remotes, stashes, unstaged: st.unstaged, staged: st.staged, head, op, shallow, unborn, timings };
    snapCache.set(this.dir, snap);
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(path.join(CACHE_DIR, 'snap-' + createHash('sha1').update(this.dir).digest('hex') + '.json'), JSON.stringify(snap));
    } catch {
      /* best effort */
    }
    return snap;
  }

  /** Last known snapshot (memory, then disk) so the UI can paint before git answers; null when unknown. */
  cachedSnapshot(): (RepoSnapshot & { op: OpState; timings: Record<string, number>; stale: true }) | null {
    const mem = snapCache.get(this.dir) as any;
    if (mem) return { ...mem, stale: true };
    try {
      const disk = JSON.parse(readFileSync(path.join(CACHE_DIR, 'snap-' + createHash('sha1').update(this.dir).digest('hex') + '.json'), 'utf8'));
      snapCache.set(this.dir, disk);
      return { ...disk, stale: true };
    } catch {
      return null;
    }
  }

  /** Next page of history (topo order), for infinite scroll. */
  async logPage(skip: number, limit: number, revs: string[] = ['--all']): Promise<Commit[]> {
    const r = await this.git(['log', `--format=${LOG_FORMAT}`, '--date-order', `--skip=${skip}`, `-n${limit}`, ...historyRevs(revs), '--']);
    return parseLog(r.stdout);
  }

  /**
   * Position of a commit in the date-ordered log of `revs` (what the history list shows), or -1 when it is not
   * among the first `max`. Streams `git rev-list` and stops at the commit, so a near one costs little.
   */
  async logPosition(sha: Sha, revs: string[] = ['--all'], max = 200000): Promise<number> {
    let i = 0;
    let found = -1;
    await runGitLines(['rev-list', '--date-order', `-n${max}`, ...historyRevs(revs), '--'], { cwd: this.dir }, (line) => {
      if (line === sha) {
        found = i;
        return false;
      }
      i++;
    });
    return found;
  }

  /**
   * The log of `revs` from position `skip` down to commit `sha` and `after` commits past it, in one streamed pass
   * (a branch click deep in the history). `index` is the commit's position, -1 when it is not among the first `max`.
   */
  async logUntil(sha: Sha, skip: number, after = 200, revs: string[] = ['--all'], max = 200000): Promise<{ index: number; commits: Commit[] }> {
    const records: string[] = [];
    let at = -1;
    const n = Math.max(0, max - skip);
    if (n > 0)
      await runGitLines(
        ['log', `--format=${LOG_FORMAT}`, '--date-order', `--skip=${skip}`, `-n${n}`, ...historyRevs(revs), '--'],
        { cwd: this.dir },
        (rec) => {
          records.push(rec);
          if (at < 0 && rec.replace(/^\n/, '').startsWith(sha)) at = records.length - 1;
          if (at >= 0 && records.length - 1 - at >= after) return false;
        },
        REC,
      );
    if (at < 0) return { index: -1, commits: [] };
    return { index: skip + at, commits: parseLog(records.join(REC)) };
  }

  /**
   * The commit search over the whole history of `revs` (the list can only filter what it has loaded): commits whose
   * subject, body, author name or e-mail contains `q` (any case), or whose id starts with it, in the order the
   * history list shows, up to `limit`. One streamed `git log`, stopped at the limit or after `maxScan` commits;
   * `more`: it stopped before the end.
   */
  async searchLog(q: string, revs: string[] = ['--all'], limit = 300, maxScan = 200000): Promise<{ commits: Commit[]; scanned: number; more: boolean }> {
    const needle = q.trim().toLowerCase();
    const commits: Commit[] = [];
    let scanned = 0;
    let more = false;
    if (!needle) return { commits, scanned, more };
    const hit = (c: Commit) => c.subject.toLowerCase().includes(needle) || c.body.toLowerCase().includes(needle) || c.author.toLowerCase().includes(needle) || c.email.toLowerCase().includes(needle) || c.sha.startsWith(needle);
    await runGitLines(
      ['log', `--format=${LOG_FORMAT}`, '--date-order', `-n${maxScan}`, ...historyRevs(revs), '--'],
      { cwd: this.dir },
      (rec) => {
        const [c] = parseLog(rec);
        if (!c) return;
        scanned++;
        if (!hit(c)) return;
        if (commits.length >= limit) {
          more = true;
          return false;
        }
        commits.push(c);
      },
      REC,
    );
    return { commits, scanned, more: more || scanned >= maxScan };
  }

  /**
   * History of one path, following renames. `git log --follow` cannot use the commit-graph's path filters and
   * walks the whole history (9 s for a file in a 480 000-commit project); instead the plain log is read (fast),
   * and when its oldest commit created the file by renaming another, the old name is read from that commit's
   * parent on, and so on.
   */
  async logFile(file: string, limit = 200, start = 'HEAD'): Promise<Commit[]> {
    const out: Commit[] = [];
    const seen = new Set<Sha>();
    let name = file;
    let from = start;
    for (let hop = 0; hop < 20 && out.length < limit; hop++) {
      const r = await this.git(['log', `--format=${LOG_FORMAT}`, `-n${limit - out.length}`, from, '--', name]);
      const page = parseLog(r.stdout).filter((c) => !seen.has(c.sha));
      for (const c of page) {
        seen.add(c.sha);
        // the name it had there: the history shows that file's diff for each commit
        c.fileName = name;
      }
      out.push(...page);
      const oldest = page[page.length - 1];
      if (!oldest || !oldest.parents[0] || out.length >= limit) break;
      const d = await this.git(['diff', '--name-status', '-M', oldest.parents[0], oldest.sha], { allowFail: true, maxBytes: 32 * 1024 * 1024 });
      const renamed = d.stdout
        .split('\n')
        .map((l) => l.split('\t'))
        .find((p) => p[0]?.startsWith('R') && p[2] === name);
      if (!renamed) break;
      name = renamed[1];
      from = oldest.parents[0];
    }
    return out;
  }

  async fileAt(rev: string, file: string): Promise<string | null> {
    const r = await this.git(['show', `${rev}:${file}`], { allowFail: true });
    return r.code === 0 ? r.stdout : null;
  }

  // ---------- submodules ----------

  async submodules(): Promise<Submodule[]> {
    const gm = path.join(this.dir, '.gitmodules');
    if (!existsSync(gm)) return [];
    const cfg = await this.git(['config', '-f', '.gitmodules', '--list'], { allowFail: true });
    const byName = new Map<string, { path?: string; url?: string }>();
    for (const line of cfg.stdout.split('\n')) {
      const m = line.match(/^submodule\.(.+)\.(path|url)=(.*)$/);
      if (!m) continue;
      const e = byName.get(m[1]) ?? {};
      (e as any)[m[2]] = m[3];
      byName.set(m[1], e);
    }
    // `git submodule status` describes the submodules one after another (1.3 s for 20 in a big project);
    // the index gives the recorded commits and each checkout is asked in parallel instead
    const paths = [...byName.values()].map((e) => e.path).filter((p): p is string => !!p);
    const idx = paths.length ? await this.git(['ls-files', '-s', '--', ...paths], { allowFail: true }) : { stdout: '' };
    const recorded = new Map<string, { sha: string; conflict: boolean }>();
    for (const line of idx.stdout.split('\n')) {
      const m = line.match(/^160000 ([0-9a-f]{40,64}) (\d)\t(.*)$/);
      if (m) recorded.set(m[3], { sha: m[1], conflict: m[2] !== '0' || !!recorded.get(m[3])?.conflict });
    }
    const states = new Map<string, { sha: string; state: Submodule['state']; describe?: string }>();
    const probe = async (p: string) => {
      const rec = recorded.get(p);
      const sub = path.join(this.dir, p);
      if (!existsSync(path.join(sub, '.git'))) {
        states.set(p, { sha: rec?.sha ?? '', state: rec?.conflict ? 'conflict' : 'uninitialized' });
        return;
      }
      const [head, desc] = await Promise.all([runGit(['rev-parse', 'HEAD'], { cwd: sub, allowFail: true }), runGit(['describe', '--all', '--always', 'HEAD'], { cwd: sub, allowFail: true })]);
      const sha = head.code === 0 ? head.stdout.trim() : '';
      const state: Submodule['state'] = rec?.conflict ? 'conflict' : sha && rec && sha !== rec.sha ? 'modified' : 'ok';
      states.set(p, { sha: sha || rec?.sha || '', state, describe: desc.code === 0 ? desc.stdout.trim() || undefined : undefined });
    };
    for (let i = 0; i < paths.length; i += 8) await Promise.all(paths.slice(i, i + 8).map(probe));
    const out: Submodule[] = [];
    const inside = new Map(this.knownSubmoduleChanges().map((c) => [c.path, c]));
    for (const [name, e] of byName) {
      if (!e.path) continue;
      const s = states.get(e.path);
      const c = inside.get(e.path);
      out.push({ path: e.path, name, url: e.url ?? '', sha: s?.sha ?? '', state: s?.state ?? 'uninitialized', describe: s?.describe, ...(c ? { inside: { modified: c.modified, untracked: c.untracked } } : {}) });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async submoduleUpdate(paths: string[] | undefined, recursive: boolean, onProgress?: Progress) {
    const args = ['submodule', 'update', '--init', '--progress', ...(recursive ? ['--recursive'] : []), '--', ...(paths ?? [])];
    await this.net(args, { onLine: (l) => onProgress?.(l, progressOf(l)) });
  }
  async submoduleSync() {
    await this.git(['submodule', 'sync', '--recursive']);
  }
  /** Subjects for the before/after commits of a submodule change (empty when the object is missing). */
  /**
   * What a submodule pointer change brought: the submodule's commits from `before` to `after` (`added`), and when
   * the pointer moved back or sideways, the ones it left (`removed`). `missing` lists pointers the submodule's clone
   * does not have (not fetched yet); `uninitialized` when the submodule is not checked out at all.
   */
  async submoduleRange(subPath: string, before: string, after: string, limit = 100): Promise<{ added: Commit[]; removed: Commit[]; missing: string[]; uninitialized: boolean; more: boolean }> {
    const dir = path.join(this.dir, subPath);
    if (!existsSync(path.join(dir, '.git'))) return { added: [], removed: [], missing: [], uninitialized: true, more: false };
    const sub = new Repo(dir);
    const has = async (sha: string) => !!sha && (await sub.git(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })).code === 0;
    const missing = [before, after].filter(Boolean);
    const [hb, ha] = await Promise.all([has(before), has(after)]);
    const gone = missing.filter((s) => (s === before ? !hb : !ha));
    const log = async (range: string[]) => parseLog((await sub.git(['log', `--format=${LOG_FORMAT}`, `-n${limit + 1}`, ...range, '--'], { allowFail: true })).stdout);
    let added: Commit[] = [];
    let removed: Commit[] = [];
    if (ha && hb) [added, removed] = await Promise.all([log([`${before}..${after}`]), log([`${after}..${before}`])]);
    else if (ha && !before) added = await log([after]);
    const more = added.length > limit || removed.length > limit;
    return { added: added.slice(0, limit), removed: removed.slice(0, limit), missing: gone, uninitialized: false, more };
  }

  async submoduleCommits(subPath: string, shas: string[]): Promise<Record<string, string>> {
    const sub = new Repo(path.join(this.dir, subPath));
    const out: Record<string, string> = {};
    for (const sha of shas) {
      if (!sha) continue;
      const r = await sub.git(['log', '-1', '--format=%s', sha], { allowFail: true });
      if (r.code === 0) out[sha] = r.stdout.trim();
    }
    return out;
  }

  // ---------- remotes & misc ----------

  async addRemote(name: string, url: string) {
    await this.git(['remote', 'add', name, url]);
  }
  async setRemoteUrl(name: string, url: string) {
    await this.git(['remote', 'set-url', name, url]);
  }
  /** a new name: git moves its remote branches and the upstreams that point there along */
  async renameRemote(oldName: string, newName: string) {
    await this.git(['remote', 'rename', oldName, newName]);
  }
  async removeRemote(name: string) {
    await this.git(['remote', 'remove', name]);
  }
  async pruneRemote(name: string) {
    const r = await this.net(['remote', 'prune', name]);
    return { output: r.stdout.trim() };
  }
  async pushTag(remote: string, tag: string) {
    await this.net(['push', remote, `refs/tags/${tag}`]);
  }
  async checkoutDetached(sha: string) {
    await this.git(['checkout', '--detach', sha]);
  }
  /** lines added at the end of the root .gitignore (on a line of their own: a file without a final newline gets one) */
  async appendIgnore(pattern: string) {
    const file = path.join(this.dir, '.gitignore');
    const had = existsSync(file) ? readFileSync(file, 'utf8') : '';
    appendFileSync(file, (had && !had.endsWith('\n') ? '\n' : '') + pattern + '\n');
  }
  async globalConfig(key: string): Promise<string | null> {
    const r = await this.git(['config', '--global', '--get', key], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async setGlobalConfig(key: string, value: string) {
    await this.git(['config', '--global', key, value]);
  }

  /** Files touched by a commit, with hunks. */
  /**
   * Files of a commit. Small commits come with their diffs; a commit with hundreds of files, or a patch of
   * many megabytes (a merge of two long-lived branches can touch 50 000 files and produce a gigabyte), comes as
   * a list (`lazy` files) and each diff is read by `commitFileDiff` when the file is selected.
   */
  async commitFiles(sha: Sha): Promise<FileChange[]> {
    const raw = await this.git(['show', '--format=', '--raw', '--no-abbrev', '--find-renames', '-m', '--first-parent', sha, '--'], { maxBytes: 256 * 1024 * 1024 });
    const listed = parseRaw(raw.stdout);
    if (listed.length > COMMIT_PATCH_FILES) return listed;
    const r = await this.git(['show', '--format=', '--no-color', '-U3', '--find-renames', '-m', '--first-parent', sha, '--'], { maxBytes: COMMIT_PATCH_BYTES });
    if (r.truncated) return listed;
    return parseDiff(r.stdout, { largeThreshold: LARGE_DIFF_LINES });
  }

  /**
   * One file of a commit (or of a stash: `rev` = "stash@{n}"); `force` reads a large diff in full; `context`: lines
   * around each change (Expand context).
   */
  async commitFileDiff(rev: string, file: string, oldPath?: string, force = false, context = 3): Promise<FileChange | null> {
    const paths = oldPath && oldPath !== file ? [oldPath, file] : [file];
    const r = await this.git(['show', '--format=', '--no-color', `-U${context}`, '--find-renames', '-m', '--first-parent', rev, '--', ...paths], { maxBytes: FILE_DIFF_BYTES });
    const files = parseDiff(r.stdout, { largeThreshold: force ? undefined : LARGE_DIFF_LINES });
    const f = files.find((x) => x.path === file) ?? files[0] ?? null;
    if (f && r.truncated) f.truncated = true;
    return f;
  }

  async stashFiles(index: number): Promise<FileChange[]> {
    const r = await this.git(['stash', 'show', '-p', '--no-color', '--include-untracked', `stash@{${index}}`], { maxBytes: COMMIT_PATCH_BYTES });
    if (!r.truncated) return parseDiff(r.stdout, { largeThreshold: LARGE_DIFF_LINES });
    const raw = await this.git(['stash', 'show', '--raw', '--no-abbrev', '--include-untracked', `stash@{${index}}`], { maxBytes: 256 * 1024 * 1024 });
    return parseRaw(raw.stdout);
  }

  /** Diff of one working-copy file: unstaged (worktree vs index) or staged (index vs HEAD). */
  async fileDiff(file: string, area: 'unstaged' | 'staged', force = false, context = 3): Promise<FileChange | null> {
    if (area === 'unstaged') {
      // a conflicted file: git gives a combined diff ("diff --cc") nothing here reads; its sides instead
      const conflict = await this.conflictOf(file);
      if (conflict) return { path: file, status: 'U', kind: conflict.binary ? 'binary' : kindOf(file), additions: 0, deletions: 0, conflict };
    }
    const args = area === 'staged' ? ['diff', '--cached'] : ['diff'];
    // read up to FILE_DIFF_BYTES, as a commit's file: a generated file of hundreds of megabytes is cut, not a crash
    let r = await this.git([...args, '--no-color', `-U${context}`, '--find-renames', '--', file], { maxBytes: FILE_DIFF_BYTES });
    if (!r.stdout.trim() && area === 'unstaged') {
      // untracked file: show it as an addition
      const st = await this.git(['status', '--porcelain', '--', file]);
      if (st.stdout.startsWith('??')) {
        r = await this.git(['diff', '--no-color', '-U3', '--no-index', '--', '/dev/null', file], { allowFail: true, maxBytes: FILE_DIFF_BYTES });
        const [f] = parseDiff(r.stdout.replace(/^diff --git a\/.* b\/(.*)$/m, (_, p) => `diff --git a/${p} b/${p}`), { largeThreshold: force ? undefined : LARGE_DIFF_LINES });
        if (f) {
          f.status = '?';
          f.path = file;
          if (r.truncated) f.truncated = true;
          return f;
        }
        return null;
      }
    }
    const [f] = parseDiff(r.stdout, { largeThreshold: force ? undefined : LARGE_DIFF_LINES });
    if (!f) return null;
    if (r.truncated) f.truncated = true;
    return f;
  }

  /**
   * Where both sides of a working-copy, commit or stash change live, without reading their content.
   * `area`: 'unstaged' (index → worktree), 'staged' (HEAD → index), a commit (first parent → commit) or a
   * stash ref (base → stash; untracked files of a stash live in its third parent). A side is absent when the
   * file does not exist there: added files have no `before`, deleted files no `after`.
   */
  async mediaSides(file: string, area: string, oldPath?: string): Promise<{ before?: BlobSide; after?: BlobSide }> {
    const prev = oldPath ?? file;
    let before: BlobSide | null;
    let after: BlobSide | null;
    if (area === 'unstaged') {
      before = await this.blobInfo(':0', prev);
      after = await this.blobInfo(WORKTREE, file);
    } else if (area === 'staged') {
      before = await this.blobInfo('HEAD', prev);
      after = await this.blobInfo(':0', file);
    } else {
      before = await this.blobInfo(`${area}^`, prev);
      after = await this.blobInfo(area, file);
      if (!after && /^stash@\{\d+\}$/.test(area)) after = await this.blobInfo(`${area}^3`, file);
    }
    return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
  }

  /**
   * Size and identity of a file at a revision (`WORKTREE`, `:0` = index, or any revision); null when absent. A file
   * in Git LFS is described by the pointer git keeps for it: the real size, the LFS object id, and whether that object
   * is on this machine (`lfs.local`). In the working copy the file itself may still be its pointer (`pointerFile`: it
   * was never restored, e.g. left out by `lfs.fetchexclude`).
   */
  async blobInfo(rev: string, file: string): Promise<BlobSide | null> {
    if (!safeRelPath(file)) return null;
    if (rev === WORKTREE) {
      const abs = path.join(this.dir, file);
      try {
        const st = statSync(abs);
        if (!st.isFile()) return null;
        const side: BlobSide = { rev, file, bytes: st.size, version: `w${Math.round(st.mtimeMs)}-${st.size}` };
        const ptr = st.size <= LFS_POINTER_MAX ? parseLfsPointer(readFileSync(abs)) : null;
        return ptr ? this.lfsSide(side, ptr, true) : side;
      } catch {
        return null;
      }
    }
    const spec = rev === ':0' ? `:0:${file}` : `${rev}:${file}`;
    const r = await this.git(['cat-file', '--batch-check'], { input: `${spec}\n`, allowFail: true });
    const m = r.stdout.trim().match(/^([0-9a-f]{40,64}) blob (\d+)$/);
    if (!m) return null;
    const side: BlobSide = { rev, file, bytes: parseInt(m[2], 10), version: m[1], oid: m[1] };
    if (side.bytes > LFS_POINTER_MAX) return side;
    const blob = await this.git(['cat-file', 'blob', m[1]], { binary: true, allowFail: true });
    const ptr = blob.code === 0 && blob.raw ? parseLfsPointer(blob.raw) : null;
    return ptr ? this.lfsSide(side, ptr, false) : side;
  }

  /** a side whose content is a Git LFS object: its real size, and a version that changes once it is downloaded */
  private async lfsSide(side: BlobSide, ptr: LfsPointer, pointerFile: boolean): Promise<BlobSide> {
    const local = await this.lfsLocal(ptr, side.file);
    return { ...side, bytes: ptr.size, version: `lfs-${ptr.oid.slice(0, 16)}${local ? '' : '-missing'}`, lfs: { oid: ptr.oid, size: ptr.size, local, ...(pointerFile ? { pointerFile } : {}) } };
  }

  /** where git-lfs keeps this repository's objects: <git common dir>/lfs/objects, or under `lfs.storage` */
  async lfsObjectsDir(): Promise<string> {
    let dir = lfsStores.get(this.dir);
    if (!dir) {
      dir = (async () => {
        const common = path.resolve(this.dir, (await this.git(['rev-parse', '--git-common-dir'])).stdout.trim());
        const storage = (await this.git(['config', '--get', 'lfs.storage'], { allowFail: true })).stdout.trim();
        return path.join(storage ? path.resolve(common, storage) : path.join(common, 'lfs'), 'objects');
      })();
      dir.catch(() => lfsStores.delete(this.dir));
      lfsStores.set(this.dir, dir);
    }
    return dir;
  }

  /** the object's content on this machine: in git-lfs's store, or already copied into the blob cache */
  private async lfsLocalPath(ptr: LfsPointer, file: string): Promise<string | null> {
    const sized = (p: string) => {
      try {
        return statSync(p).size === ptr.size;
      } catch {
        return false;
      }
    };
    const cached = lfsCachePath(ptr.oid, file);
    if (sized(cached)) return cached;
    const obj = path.join(await this.lfsObjectsDir().catch(() => ''), ptr.oid.slice(0, 2), ptr.oid.slice(2, 4), ptr.oid);
    return sized(obj) ? obj : null;
  }
  private async lfsLocal(ptr: LfsPointer, file: string) {
    return !!(await this.lfsLocalPath(ptr, file));
  }

  /**
   * A file on disk with the content of `file` at `rev`: the working copy itself, or the blob extracted once into
   * the content-addressed cache (named by object id, keeping the extension so other apps recognise the type).
   * Streams through git, so large videos never sit in memory. A Git LFS file is its LFS object (linked into the
   * cache under its name's extension); one not downloaded yet is an LfsNotDownloaded error.
   */
  async materializeBlob(rev: string, file: string): Promise<{ path: string; bytes: number } | null> {
    const info = await this.blobInfo(rev, file);
    if (!info) return null;
    if (info.lfs) {
      const ptr = { oid: info.lfs.oid, size: info.lfs.size };
      const at = await this.lfsLocalPath(ptr, file);
      if (!at) throw new LfsNotDownloaded(file);
      const out = lfsCachePath(ptr.oid, file);
      if (at !== out) {
        mkdirSync(path.dirname(out), { recursive: true });
        const tmp = `${out}.${process.pid}.${Date.now()}.${++blobSeq}.part`;
        // a hard link costs nothing (LFS objects never change); another volume gets a copy
        try {
          linkSync(at, tmp);
        } catch {
          copyFileSync(at, tmp);
        }
        renameSync(tmp, out);
      }
      return { path: out, bytes: info.bytes };
    }
    if (rev === WORKTREE) return { path: path.join(this.dir, file), bytes: info.bytes };
    const dir = path.join(stateDir(), 'cache', 'blobs');
    const out = path.join(dir, `${info.oid}${path.extname(file).toLowerCase()}`);
    if (existsSync(out) && statSync(out).size === info.bytes) return { path: out, bytes: info.bytes };
    mkdirSync(dir, { recursive: true });
    // a name of its own per read: two requests for the same blob in the same millisecond (the before and after
    // panes, a range request) wrote one file, and the second rename failed ("ENOENT … .part", a 500)
    const tmp = `${out}.${process.pid}.${Date.now()}.${++blobSeq}.part`;
    await runGitToFile(['cat-file', 'blob', info.oid!], tmp, { cwd: this.dir });
    renameSync(tmp, out);
    return { path: out, bytes: info.bytes };
  }

  /**
   * Downloads the Git LFS object of `file` at `rev` for its preview (`git lfs smudge` of its pointer, which keeps the
   * object in git-lfs's store too); the working copy is left as it is. Patterns the repository leaves out of downloads
   * (`lfs.fetchexclude`, often in .lfsconfig) do not apply: the file was asked for by name.
   */
  async lfsDownload(rev: string, file: string, onLine?: (line: string) => void): Promise<BlobSide> {
    const info = await this.blobInfo(rev, file);
    if (!info?.lfs) throw new Error(`${file} is not a Git LFS file at ${rev === WORKTREE ? 'the working copy' : rev}`);
    if (info.lfs.local) return info;
    const pointer = rev === WORKTREE ? readFileSync(path.join(this.dir, file)) : (await this.git(['cat-file', 'blob', info.oid!], { binary: true })).raw!;
    const out = lfsCachePath(info.lfs.oid, file);
    mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.${Date.now()}.${++blobSeq}.part`;
    const a = Repo.auth ? await Repo.auth(this.dir) : null;
    const { stderr } = await runGitToFile([...(a?.config ?? []).flatMap((c) => ['-c', c]), '-c', 'lfs.fetchexclude=', '-c', 'lfs.fetchinclude=', 'lfs', 'smudge', '--', file], tmp, { cwd: this.dir, input: pointer, onLine, env: { ...(a?.env ?? {}), GIT_LFS_FORCE_PROGRESS: '1' } });
    // smudge writes the pointer back when it did not download (no endpoint, refused): that is not the file
    if (statSync(tmp).size !== info.lfs.size) {
      rmSync(tmp, { force: true });
      throw new Error(`Git LFS did not download ${file}${withoutProgress(stderr).trim() ? `: ${withoutProgress(stderr).trim().split('\n').slice(-2).join(' ')}` : ''}`);
    }
    renameSync(tmp, out);
    return (await this.blobInfo(rev, file)) ?? info;
  }

  /**
   * The working copy's Git LFS files that are still pointers (never restored: cloned without LFS, or left out by
   * `lfs.fetchexclude`), with the patterns the repository leaves out of downloads. `git lfs ls-files` reads every
   * LFS file of HEAD: seconds on a big repository (township: 66 000 files, 9 s).
   */
  async lfsFiles(): Promise<LfsFiles> {
    const ver = await this.git(['lfs', 'version'], { allowFail: true });
    if (ver.code !== 0) return { installed: false, total: 0, missing: [], excluded: [] };
    const r = await this.git(['lfs', 'ls-files', '--json'], { maxBytes: 1024 * 1024 * 1024, env: { GIT_OPTIONAL_LOCKS: '0' } });
    let files: { name: string; size: number; checkout: boolean; downloaded: boolean }[] = [];
    try {
      files = JSON.parse(r.stdout || '{}').files ?? [];
    } catch {
      throw new Error('git lfs ls-files gave an answer Prong does not read: ' + r.stdout.slice(0, 120));
    }
    const excluded = (await this.git(['config', '--get-all', 'lfs.fetchexclude'], { allowFail: true })).stdout;
    const fromFile = existsSync(path.join(this.dir, '.lfsconfig')) ? (await this.git(['config', '-f', '.lfsconfig', '--get-all', 'lfs.fetchexclude'], { allowFail: true })).stdout : '';
    const patterns = [...new Set(`${excluded}\n${fromFile}`.split(/[\n,]/).map((p) => p.trim()).filter(Boolean))];
    return {
      installed: true,
      version: ver.stdout.trim().split(' ')[0]?.replace('git-lfs/', ''),
      total: files.length,
      missing: files.filter((f) => !f.checkout).map((f) => ({ path: f.name, size: f.size, downloaded: !!f.downloaded })),
      excluded: patterns,
    };
  }

  /**
   * Puts the real files in place of their pointers: `git lfs pull` (downloads what is not on this machine, then checks
   * out) for the folders and files picked, or for every LFS file of HEAD. What the repository leaves out of downloads
   * is restored too: the user asked for it.
   */
  async lfsRestore(pick: LfsPick, onProgress?: Progress) {
    const base = ['-c', 'lfs.fetchexclude=', '-c', 'lfs.fetchinclude=', 'lfs', 'pull', '--exclude='];
    const env = { GIT_LFS_FORCE_PROGRESS: '1' };
    const patterns = pick.all ? [] : lfsPatterns(pick);
    if (!pick.all && !patterns.length) return;
    // a long list goes in parts: the command line has a limit
    const parts: string[][] = pick.all ? [[]] : [];
    for (const p of patterns) {
      const last = parts[parts.length - 1];
      if (last && last.join(',').length + p.length < 60_000) last.push(p);
      else parts.push([p]);
    }
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const scale = (p: number | null) => (p === null ? null : (i + p) / parts.length);
      await this.net([...base, ...(part.length ? [`--include=${part.join(',')}`] : [])], { env, stdoutLines: true, onLine: (l) => onProgress?.(l, scale(progressOf(l))) });
    }
    await this.lfsSettleIndex();
  }

  /**
   * After LFS files were put in place: the index still has their pointers' sizes when git-lfs could not update it
   * (another git held index.lock, e.g. a status read at that moment), and git then calls them modified without
   * reading them (a size change is a change). Those whose content is what the index has (`git diff` finds nothing)
   * are added again, which only updates the index's record of the file; files really edited are left alone.
   */
  async lfsSettleIndex() {
    const st = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames']);
    const modified = st.stdout
      .split('\0')
      .filter((r) => r.length > 3 && r[1] === 'M')
      .map((r) => r.slice(3));
    if (!modified.length) return;
    const attrs = await this.git(['check-attr', '-z', '--stdin', 'filter'], { input: modified.join('\0') + '\0' });
    const parts = attrs.stdout.split('\0');
    const lfs: string[] = [];
    for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === 'lfs') lfs.push(parts[i]);
    if (!lfs.length) return;
    // names as they are (a "[hd]" folder is not a pattern); diff takes them on its command line, in parts
    const differ = new Set<string>();
    for (const part of chunkPaths(lfs)) for (const f of (await this.git(['--literal-pathspecs', 'diff', '--name-only', '-z', '--no-renames', '--', ...part])).stdout.split('\0')) if (f) differ.add(f);
    const same = lfs.filter((f) => !differ.has(f));
    if (same.length) await this.git(['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: same.join('\0') + '\0' });
  }

  /** blame of the working copy, or of the file as it is in commit `rev` */
  async blame(file: string, rev?: string): Promise<{ sha: string; author: string; date: number; line: string }[]> {
    const r = await this.git(['blame', '--line-porcelain', ...(rev ? [rev] : []), '--', file], { maxBytes: 64 * 1024 * 1024 });
    const out: { sha: string; author: string; date: number; line: string }[] = [];
    let cur: any = null;
    for (const l of r.stdout.split('\n')) {
      if (/^[0-9a-f]{40} \d+ \d+/.test(l)) cur = { sha: l.slice(0, 40), author: '', date: 0, line: '' };
      else if (l.startsWith('author ')) cur.author = l.slice(7);
      else if (l.startsWith('author-time ')) cur.date = parseInt(l.slice(12), 10) * 1000;
      else if (l.startsWith('\t')) {
        cur.line = l.slice(1);
        out.push(cur);
      }
    }
    return out;
  }

  // ---------- staging ----------

  // a folder's worth of paths goes to git in runs that fit a command line

  async stage(paths: string[]) {
    for (const run of inRuns(paths)) await this.git(['add', '-A', '--', ...run]);
  }
  async stageAll() {
    await this.git(['add', '-A']);
  }
  async unstage(paths: string[]) {
    for (const run of inRuns(paths)) await this.git(['restore', '--staged', '--', ...run]);
  }
  async unstageAll() {
    await this.git(['reset', '-q']);
  }
  /** `kept`: repositories of their own among the paths, left alone */
  async discard(paths: string[]): Promise<{ kept: string[] }> {
    // which are untracked (deleted from disk) and which git puts back: one status per run, not one per file
    const untracked = new Set<string>();
    for (const run of inRuns(paths)) {
      const st = await this.git(['status', '--porcelain=v1', '-z', '--', ...run]);
      for (const e of st.stdout.split('\0')) if (e.startsWith('?? ')) untracked.add(e.slice(3));
    }
    // status may name an untracked folder ("dir/") for a path inside it, or the files of a folder named "dir/"
    // (status.showUntrackedFiles=all)
    const dirs = [...untracked].filter((u) => u.endsWith('/'));
    const isUntracked = (p: string) => untracked.has(p) || dirs.some((d) => p.startsWith(d)) || (p.endsWith('/') && [...untracked].some((u) => u.startsWith(p)));
    const tracked: string[] = [];
    // a repository of its own inside (git lists it as "dir/"): its history is not a change to drop, and the copy for
    // Undo cannot hold its .git — left alone, as `git clean` leaves it
    const nested: string[] = [];
    for (const p of paths) {
      if (!isUntracked(p)) {
        tracked.push(p);
        continue;
      }
      if (existsSync(path.join(this.dir, p.replace(/\/+$/, ''), '.git'))) {
        nested.push(p);
        continue;
      }
      rmSync(path.join(this.dir, p), { recursive: true, force: true });
      // the files of a new folder go one by one: the folders they leave empty go too
      for (let d = path.dirname(path.join(this.dir, p.replace(/\/+$/, ''))); d.startsWith(this.dir + path.sep); d = path.dirname(d)) {
        try {
          if (readdirSync(d).length) break;
          rmdirSync(d);
        } catch {
          break;
        }
      }
    }
    for (const run of inRuns(tracked)) await this.git(['checkout', '--', ...run]);
    return { kept: nested };
  }
  async discardAll() {
    await this.git(['checkout', '--', '.']);
    await this.git(['clean', '-fd']);
  }

  async stageHunk(file: FileChange, hunk: Hunk) {
    await this.git(['apply', '--cached', '--unidiff-zero', '-'], { input: hunkPatch(file, hunk) });
  }
  async unstageHunk(file: FileChange, hunk: Hunk) {
    await this.git(['apply', '--cached', '--reverse', '--unidiff-zero', '-'], { input: hunkPatch(file, hunk) });
  }
  async discardHunk(file: FileChange, hunk: Hunk) {
    await this.git(['apply', '--reverse', '--unidiff-zero', '-'], { input: hunkPatch(file, hunk) });
  }

  // ---------- conflicts ----------

  /** the index stages of a conflicted file (1 base, 2 ours, 3 theirs) as object ids; none when it is not conflicted */
  async stages(file: string): Promise<Record<number, string>> {
    const r = await this.git(['ls-files', '-u', '-z', '--', `:(literal)${file}`], { allowFail: true });
    const out: Record<number, string> = {};
    for (const e of r.stdout.split('\0')) {
      const m = e.match(/^\d+ ([0-9a-f]{40,64}) ([123])\t/);
      if (m) out[+m[2]] = m[1];
    }
    return out;
  }

  /**
   * The stages merged again by `git merge-file` in a temporary folder (the working copy is not touched): `diff3`
   * marks each conflict with the base between the sides, `union` takes both sides of each one. Null when a side is
   * binary.
   */
  private async mergeStages(st: Record<number, string>, mode: 'diff3' | 'union'): Promise<Buffer | null> {
    const sides = await Promise.all([st[2], st[1], st[3]].map(async (sha) => (sha ? (await this.git(['cat-file', 'blob', sha], { binary: true })).raw ?? Buffer.alloc(0) : Buffer.alloc(0))));
    // a Git LFS file conflicts as two pointers: lines of hashes to merge are no help, it is a side to take
    if (sides.some((b) => b.subarray(0, 8000).includes(0) || !!parseLfsPointer(b))) return null;
    const tmp = mkdtempSync(path.join(tmpdir(), 'prong-merge-'));
    try {
      const files = ['ours', 'base', 'theirs'].map((n, i) => {
        const f = path.join(tmp, n);
        writeFileSync(f, sides[i]);
        return f;
      });
      // the exit code is the number of conflicts; a negative one (255) is an error
      const r = await this.git(['merge-file', '-p', mode === 'diff3' ? '--diff3' : '--union', '-L', 'ours', '-L', 'base', '-L', 'theirs', ...files], { allowFail: true, binary: true });
      if (r.code < 0 || r.code > 127) throw new Error(r.stderr.trim() || 'git merge-file failed');
      return r.raw ?? Buffer.alloc(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * What the three-pane conflict view shows: the conflicting regions of ours, the base and theirs ("⋯" between two
   * regions), from the index stages — the working copy's own markers lack the base and change as the user edits.
   * `deleted`: one side removed the file; `binary`: nothing to show, only a side to take. Null: not conflicted.
   */
  async conflictOf(file: string): Promise<NonNullable<FileChange['conflict']> | null> {
    const st = await this.stages(file);
    if (!st[1] && !st[2] && !st[3]) return null;
    if (!st[2] || !st[3]) return { ours: [], base: [], theirs: [], deleted: !st[2] ? 'ours' : 'theirs' };
    const merged = await this.mergeStages(st, 'diff3');
    if (!merged) return { ours: [], base: [], theirs: [], binary: true };
    const out: Record<'ours' | 'base' | 'theirs', string[]> = { ours: [], base: [], theirs: [] };
    let side: 'none' | 'ours' | 'base' | 'theirs' = 'none';
    let regions = 0;
    for (const l of merged.toString('utf8').split('\n')) {
      if (side === 'none' && l.startsWith('<<<<<<< ours')) {
        if (regions++) for (const k of ['ours', 'base', 'theirs'] as const) out[k].push('⋯');
        side = 'ours';
      } else if (side === 'ours' && l.startsWith('||||||| base')) side = 'base';
      else if ((side === 'ours' || side === 'base') && l === '=======') side = 'theirs';
      else if (side === 'theirs' && l.startsWith('>>>>>>> theirs')) side = 'none';
      else if (side !== 'none') out[side].push(l);
    }
    return out;
  }

  /**
   * Resolves a conflicted file and marks it resolved (staged): `ours` / `theirs` take that side whole (a side that
   * deleted the file deletes it), `both` keeps both sides of every conflict, ours first.
   */
  async resolveConflict(file: string, take: 'ours' | 'theirs' | 'both') {
    const st = await this.stages(file);
    if (take === 'both') {
      if (!st[2] || !st[3]) throw new Error(`${file} was deleted on one side: take ours or theirs`);
      const merged = await this.mergeStages(st, 'union');
      if (!merged) throw new Error(`${file} is binary: take ours or theirs`);
      writeFileSync(path.join(this.dir, file), merged);
      await this.git(['add', '--', file]);
      return;
    }
    if ((take === 'ours' && st[1] && !st[2]) || (take === 'theirs' && st[1] && !st[3])) {
      await this.git(['rm', '-q', '--', file]);
      return;
    }
    await this.git(['checkout', `--${take}`, '--', file]);
    await this.git(['add', '--', file]);
  }

  // ---------- commits ----------

  async commit(message: string, opts: { amend?: boolean; allowEmpty?: boolean } = {}): Promise<Sha> {
    const args = ['commit', '-m', message];
    if (opts.amend) args.push('--amend');
    if (opts.allowEmpty) args.push('--allow-empty');
    await this.git(args);
    return this.head();
  }

  // ---------- remote ----------

  /**
   * `tags`: every tag of the remote, not only those on fetched commits (`--tags`; git never prunes tags fetched that
   * way, so local-only tags stay even with `prune`).
   */
  async fetch(remote = '--all', prune = true, onProgress?: Progress, opts: { tags?: boolean } = {}) {
    const args = ['fetch', '--progress', ...(prune ? ['--prune'] : []), ...(opts.tags ? ['--tags'] : []), ...(remote === '--all' ? ['--all'] : [remote])];
    await this.withoutGoneBranches(() => this.net(args, { onLine: (l) => onProgress?.(l, progressOf(l)) }), onProgress);
  }
  /**
   * Into the current branch: its upstream, or `branch` of `remote` (as Fork's Pull picks them). `autostash`: local
   * changes are stashed before and put back after (`--autostash`); `tags`: every tag of the remote too.
   */
  async pull(strategy: 'merge' | 'rebase' | 'ff' = 'merge', onProgress?: Progress, opts: { remote?: string; branch?: string; autostash?: boolean; tags?: boolean } = {}) {
    const flag = strategy === 'rebase' ? '--rebase' : strategy === 'ff' ? '--ff-only' : '--no-rebase';
    const args = ['pull', '--progress', flag, ...(opts.autostash ? ['--autostash'] : []), ...(opts.tags ? ['--tags'] : []), ...(opts.remote ? [opts.remote, ...(opts.branch ? [opts.branch] : [])] : [])];
    await this.withoutGoneBranches(() => this.net(args, { onLine: (l) => onProgress?.(l, progressOf(l)) }), onProgress);
  }
  /**
   * Completes a shallow clone: `git fetch --unshallow` brings the history `clone --depth` left out, so blame,
   * `log` of old files and rebases onto old commits work again. Such a clone also follows a single branch (git
   * implies --single-branch with --depth), so `allBranches` widens the remote's fetch list first; without that the
   * full history would arrive for one branch only.
   */
  async unshallow(remote?: string, allBranches = true, onProgress?: Progress) {
    if (!(await this.isShallow())) throw new Error('This repository is not a shallow clone: its history is already complete.');
    const names = (await this.git(['remote'])).stdout.split('\n').filter(Boolean);
    const name = remote ?? (names.includes('origin') ? 'origin' : names[0]);
    if (!name) throw new Error('No remote to fetch the missing history from.');
    if (!names.includes(name)) throw new Error(`No remote named ${name}.`);
    if (allBranches && !(await this.fetchesAllBranches(name))) {
      await this.git(['remote', 'set-branches', name, '*']);
      onProgress?.(`${name} follows every branch from now on`, null);
    }
    await this.net(['fetch', '--unshallow', '--tags', '--progress', name], { onLine: (l) => onProgress?.(l, progressOf(l)) });
  }
  /**
   * Widens a narrow clone: `git remote set-branches <remote> '*'` puts the wildcard refspec back and fetches, so every
   * branch of the remote arrives. A `--single-branch` clone (also what `--depth` leaves behind) follows one branch
   * only, which is why origin shows a single branch however often it is fetched; the history stays as deep as it is.
   */
  async followAllBranches(remote?: string, onProgress?: Progress) {
    const names = (await this.git(['remote'])).stdout.split('\n').filter(Boolean);
    const name = remote ?? (names.includes('origin') ? 'origin' : names[0]);
    if (!name) throw new Error('No remote to fetch the branches from.');
    if (!names.includes(name)) throw new Error(`No remote named ${name}.`);
    if (await this.fetchesAllBranches(name)) throw new Error(`${name} already follows every branch: a plain fetch brings them all.`);
    await this.git(['remote', 'set-branches', name, '*']);
    onProgress?.(`${name} follows every branch from now on`, null);
    await this.net(['fetch', '--tags', '--progress', name], { onLine: (l) => onProgress?.(l, progressOf(l)) });
  }
  /** does the remote's fetch list cover every branch (a wildcard refspec), or only the cloned one? */
  async fetchesAllBranches(remote: string) {
    const specs = (await this.git(['config', '--get-all', `remote.${remote}.fetch`], { allowFail: true })).stdout.split('\n').filter(Boolean);
    return specs.some((s) => s.replace(/^\+/, '').split(':')[0] === 'refs/heads/*');
  }
  /**
   * A single-branch clone fetches its extra branches by name (Prong adds one when a branch is published from such a
   * clone). Once the remote deletes one of them, git fails every fetch and pull with "couldn't find remote ref". Such
   * a branch leaves the remote's fetch list and its stale remote copy goes (what --prune does for the rest), and the
   * command runs again; its log says which.
   */
  private async withoutGoneBranches(run: () => Promise<unknown>, onProgress?: Progress) {
    try {
      await run();
    } catch (e) {
      const dropped = await this.dropGoneBranches(String((e as Error)?.message ?? e));
      if (!dropped.length) throw e;
      await run();
      onProgress?.(`Deleted on the remote, no longer fetched: ${dropped.join(', ')}`, null);
    }
  }
  /** the named fetch refspecs whose branch the remote no longer has (checked with ls-remote); what was dropped */
  async dropGoneBranches(message: string): Promise<string[]> {
    const gone = new Set([...message.matchAll(/couldn't find remote ref (refs\/heads\/\S+)/g)].map((m) => m[1]));
    if (!gone.size) return [];
    const dropped: string[] = [];
    for (const remote of (await this.git(['remote'])).stdout.split('\n').filter(Boolean)) {
      const specs = (await this.git(['config', '--get-all', `remote.${remote}.fetch`], { allowFail: true })).stdout.split('\n').filter(Boolean);
      for (const spec of specs) {
        const [src, dst] = spec.replace(/^\+/, '').split(':');
        // a remote whose only refspec is that branch is left alone: without one it would fetch nothing
        if (!gone.has(src) || specs.length < 2) continue;
        // another remote may still have a branch of that name: only the one that lost it
        const there = await this.net(['ls-remote', '--exit-code', remote, src], { allowFail: true, timeoutMs: 30000 });
        if (there.code !== 2) continue;
        await this.git(['config', '--fixed-value', '--unset', `remote.${remote}.fetch`, spec]);
        if (dst?.startsWith('refs/remotes/')) await this.git(['update-ref', '-d', dst], { allowFail: true });
        dropped.push(`${remote}/${src.slice('refs/heads/'.length)}`);
      }
    }
    return dropped;
  }
  /**
   * `branch` (any local branch, not only the current one) to `remoteBranch` of `remote` — the same name unless given,
   * as in Fork's Push. `setUpstream`: the local branch tracks it afterwards; `tags`: every tag goes along.
   */
  async push(opts: { remote?: string; branch?: string; remoteBranch?: string; force?: boolean; tags?: boolean; setUpstream?: boolean } = {}, onProgress?: Progress) {
    const args = ['push', '--progress'];
    if (opts.force) args.push('--force-with-lease');
    if (opts.tags) args.push('--tags');
    if (opts.setUpstream) args.push('-u');
    const target = opts.remoteBranch || opts.branch;
    if (opts.remote) {
      args.push(opts.remote);
      if (opts.branch) args.push(target && target !== opts.branch ? `${opts.branch}:refs/heads/${target}` : opts.branch);
    }
    // a branch published with -u must be one the clone fetches, or git keeps no origin/<branch> and the upstream
    // never resolves (single-branch and narrow clones fetch only master)
    const tracked = opts.setUpstream && opts.remote && target ? await this.fetchesBranch(opts.remote, target) : true;
    if (!tracked) await this.git(['remote', 'set-branches', '--add', opts.remote!, target!]);
    await this.net(args, { onLine: (l) => onProgress?.(l, progressOf(l)) });
    if (opts.setUpstream && opts.remote && target) {
      // pushed before the branch was fetched (nothing new to send this time): read its remote copy once
      const has = await this.git(['rev-parse', '--verify', '-q', `refs/remotes/${opts.remote}/${target}`], { allowFail: true });
      if (has.code !== 0) await this.net(['fetch', opts.remote, target], { allowFail: true });
    }
  }
  /** does `git fetch <remote>` bring refs/heads/<branch>? (its fetch refspecs, wildcards included) */
  async fetchesBranch(remote: string, branch: string) {
    const specs = (await this.git(['config', '--get-all', `remote.${remote}.fetch`], { allowFail: true })).stdout.split('\n').filter(Boolean);
    const ref = `refs/heads/${branch}`;
    return specs.some((s) => {
      const src = s.replace(/^\+/, '').split(':')[0];
      if (!src.includes('*')) return src === ref;
      const [pre, post] = src.split('*');
      return ref.startsWith(pre) && ref.endsWith(post) && ref.length >= pre.length + post.length;
    });
  }

  // ---------- branches / tags ----------

  async checkout(ref: string) {
    await this.git(['switch', ref], { allowFail: false }).catch(() => this.git(['checkout', ref]));
  }
  /**
   * Fork's "stash and reapply": local changes that would be overwritten are stashed, the branch is checked out,
   * the changes come back. If they do not apply cleanly the stash stays (nothing is lost) and that is reported.
   * `start`: `ref` is a new branch from there (a remote branch's local branch, tracking it).
   */
  async checkoutWithStash(ref: string, start?: string): Promise<{ stashed: boolean; reapplied: boolean; output: string }> {
    const s = await this.git(['stash', 'push', '--include-untracked', '-m', `Prong: before switching to ${ref}`]);
    const stashed = !/No local changes to save/.test(s.stdout + s.stderr);
    try {
      await (start ? this.createBranch(ref, start, true) : this.checkout(ref));
    } catch (e) {
      if (stashed) await this.git(['stash', 'pop'], { allowFail: true });
      throw e;
    }
    if (!stashed) return { stashed, reapplied: false, output: '' };
    const p = await this.git(['stash', 'pop'], { allowFail: true });
    return { stashed, reapplied: p.code === 0, output: (p.stdout + p.stderr).trim() };
  }
  /** the name it got (see storedBranchName) */
  async createBranch(name: string, start: string, checkout: boolean): Promise<{ name: string }> {
    const stored = await this.storedBranchName(name);
    if (checkout) await this.git(['switch', '-c', stored, start]);
    else await this.git(['branch', stored, start]);
    return { name: stored };
  }
  /** a local branch; with `remote`, also the branch it tracks there (or the same-named one) */
  async deleteBranch(name: string, force = false, remote?: string) {
    const upstream = remote ? (await this.git(['rev-parse', '--abbrev-ref', `${name}@{upstream}`], { allowFail: true })).stdout.trim() : '';
    await this.git(['branch', force ? '-D' : '-d', name]);
    if (remote) await this.deleteRemoteBranch(remote, upstream.startsWith(remote + '/') ? upstream.slice(remote.length + 1) : name);
  }
  /** a branch on a remote; when the remote no longer has it, the stale remote-tracking ref is dropped */
  async deleteRemoteBranch(remote: string, branch: string) {
    const r = await this.net(['push', remote, '--delete', branch], { allowFail: true });
    if (r.code === 0) return;
    if (/remote ref does not exist|unable to delete/i.test(r.stderr)) {
      await this.git(['branch', '-d', '-r', `${remote}/${branch}`], { allowFail: true });
      return;
    }
    throw new Error(r.stderr.trim().split('\n').slice(-2).join(' ') || `git push ${remote} --delete ${branch} failed`);
  }
  /**
   * Several local branches at once. With `withRemote`, the remote branches they track go too (one push per
   * remote), but only for the branches that were deleted here. Each failure is reported, the rest go through.
   */
  async deleteBranches(names: string[], force: boolean, withRemote: boolean): Promise<BatchResult> {
    const ups = new Map<string, string>();
    if (withRemote)
      for (const n of names) {
        const u = await this.git(['rev-parse', '--abbrev-ref', `${n}@{upstream}`], { allowFail: true });
        if (u.code === 0 && u.stdout.trim()) ups.set(n, u.stdout.trim());
      }
    const out: BatchResult = { done: [], failed: [] };
    for (const n of names) {
      const r = await this.git(['branch', force ? '-D' : '-d', n], { allowFail: true });
      if (r.code === 0) out.done.push(n);
      else out.failed.push({ name: n, error: (r.stderr || r.stdout).trim() });
    }
    const twins = out.done.map((n) => ups.get(n)).filter((u): u is string => !!u);
    if (twins.length) {
      const rr = await this.deleteRemoteBranches(twins);
      out.done.push(...rr.done);
      out.failed.push(...rr.failed);
    }
    return out;
  }

  /** the remote a "origin/x" style name belongs to, and the branch on it */
  private async splitRemoteRef(full: string, remotes?: string[]) {
    const names = remotes ?? (await this.git(['remote'], { allowFail: true })).stdout.split('\n').filter(Boolean);
    const remote = names.filter((r) => full.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
    return remote ? { remote, branch: full.slice(remote.length + 1) } : null;
  }

  /**
   * Remote branches ("origin/x") at once: one `git push <remote> --delete …` per remote. A branch the remote no
   * longer has only loses its stale remote-tracking ref.
   */
  async deleteRemoteBranches(refs: string[]): Promise<BatchResult> {
    const remotes = (await this.git(['remote'], { allowFail: true })).stdout.split('\n').filter(Boolean);
    const byRemote = new Map<string, string[]>();
    const out: BatchResult = { done: [], failed: [] };
    for (const full of refs) {
      const s = await this.splitRemoteRef(full, remotes);
      if (!s) {
        out.failed.push({ name: full, error: 'not a remote branch' });
        continue;
      }
      byRemote.set(s.remote, [...(byRemote.get(s.remote) ?? []), s.branch]);
    }
    for (const [remote, branches] of byRemote) {
      let r = await this.net(['push', '--porcelain', remote, '--delete', ...branches], { allowFail: true });
      // git refuses the whole push when one of them is already gone there: those only lose their stale
      // remote-tracking ref, the rest are sent again
      const gone = new Set([...r.stderr.matchAll(/unable to delete '([^']+)': remote ref does not exist/g)].map((m) => m[1]));
      for (const b of gone) {
        await this.git(['branch', '-d', '-r', `${remote}/${b}`], { allowFail: true });
        out.done.push(`${remote}/${b}`);
      }
      const rest = branches.filter((b) => !gone.has(b));
      if (gone.size && rest.length) r = await this.net(['push', '--porcelain', remote, '--delete', ...rest], { allowFail: true });
      const status = parsePushPorcelain(r.stdout);
      for (const b of rest) {
        const st = status.get(`refs/heads/${b}`);
        if (st?.ok) out.done.push(`${remote}/${b}`);
        else out.failed.push({ name: `${remote}/${b}`, error: st?.summary || r.stderr.trim() || 'not deleted' });
      }
    }
    return out;
  }

  /** several local branches to a remote in one push; each gets it as its upstream and is tracked (see push) */
  async pushBranches(names: string[], remote: string, onProgress?: Progress): Promise<BatchResult> {
    for (const n of names) if (!(await this.fetchesBranch(remote, n))) await this.git(['remote', 'set-branches', '--add', remote, n]);
    const r = await this.net(['push', '--porcelain', '--progress', '-u', remote, ...names], { allowFail: true, onLine: (l) => onProgress?.(l, progressOf(l)) });
    const status = parsePushPorcelain(r.stdout);
    const out: BatchResult = { done: [], failed: [] };
    for (const n of names) {
      const st = status.get(`refs/heads/${n}`);
      if (st?.ok) out.done.push(n);
      else out.failed.push({ name: n, error: st?.summary || r.stderr.trim() || 'not pushed' });
    }
    if (out.done.length) await this.net(['fetch', remote, ...out.done], { allowFail: true });
    return out;
  }

  async renameBranch(oldName: string, newName: string): Promise<{ name: string }> {
    // only the case changes: on a case-insensitive disk git takes the new name for the old one ("already exists"),
    // so through a temporary name
    if (oldName !== newName && oldName.toLowerCase() === newName.toLowerCase()) {
      const tmp = `${newName}-prong-rename-${Date.now().toString(36)}`;
      await this.git(['branch', '-m', oldName, tmp]);
      await this.git(['branch', '-m', tmp, newName]);
      return { name: newName };
    }
    const stored = await this.storedBranchName(newName);
    await this.git(['branch', '-m', oldName, stored]);
    return { name: stored };
  }
  async setUpstream(branch: string, upstream: string) {
    await this.git(['branch', `--set-upstream-to=${upstream}`, branch]);
  }
  async createTag(name: string, sha: string, message?: string) {
    if (message) await this.git(['tag', '-a', name, '-m', message, sha]);
    else await this.git(['tag', name, sha]);
  }
  /** the tag's object (an annotated tag's too), for Undo */
  async deleteTag(name: string): Promise<{ sha: string }> {
    const sha = (await this.git(['rev-parse', `refs/tags/${name}`])).stdout.trim();
    await this.git(['tag', '-d', name]);
    return { sha };
  }

  // ---------- integration ----------

  async merge(source: string, opts: { noFf?: boolean; squash?: boolean } = {}) {
    const args = ['merge', '--no-edit'];
    if (opts.noFf) args.push('--no-ff');
    if (opts.squash) args.push('--squash');
    args.push(source);
    const r = await this.git(args, { allowFail: true });
    if (r.code !== 0 && !/CONFLICT/.test(r.stdout + r.stderr)) throw new Error(r.stderr || r.stdout);
    return { conflicts: /CONFLICT/.test(r.stdout + r.stderr) };
  }

  /** Non-interactive rebase of the current branch onto `onto`; returns whether conflicts stopped it. */
  async rebase(onto: string, opts: { preserveMerges?: boolean; autostash?: boolean } = {}) {
    const args = ['rebase'];
    if (opts.preserveMerges) args.push('--rebase-merges');
    if (opts.autostash) args.push('--autostash');
    args.push(onto);
    const r = await this.git(args, { allowFail: true });
    if (r.code !== 0 && !/CONFLICT/.test(r.stdout + r.stderr)) throw new Error(r.stderr || r.stdout);
    return { conflicts: /CONFLICT/.test(r.stdout + r.stderr) };
  }

  /**
   * Interactive rebase driven by a todo list built in the UI. `reword` becomes pick + an exec that
   * amends the message, so no editor is ever opened.
   */
  async rebaseInteractive(onto: string, todo: RebaseTodoItem[], opts: { autostash?: boolean } = {}) {
    const lines: string[] = [];
    for (const t of todo) {
      if (t.action === 'drop') continue;
      if (t.action === 'reword') {
        lines.push(`pick ${t.sha}`);
        lines.push(`exec git commit --amend --no-edit -m ${shellQuote(t.message ?? '')}`);
      } else lines.push(`${t.action} ${t.sha}`);
    }
    const tmp = mkdtempSync(path.join(tmpdir(), 'prong-rebase-'));
    const todoPath = path.join(tmp, 'todo');
    writeFileSync(todoPath, lines.join('\n') + '\n');
    try {
      const r = await this.git(['rebase', '-i', ...(opts.autostash ? ['--autostash'] : []), onto], { env: { GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todoPath)}`, GIT_EDITOR: 'true' }, allowFail: true });
      if (r.code !== 0 && !/CONFLICT/.test(r.stdout + r.stderr)) throw new Error(r.stderr || r.stdout);
      return { conflicts: /CONFLICT/.test(r.stdout + r.stderr) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  async rebaseContinue() {
    await this.git(['rebase', '--continue'], { env: { GIT_EDITOR: 'true' } });
  }
  async rebaseAbort() {
    await this.git(['rebase', '--abort']);
  }
  /**
   * Abort of the operation that stopped on conflicts: a merge, and also a cherry-pick or a revert (the conflict bar
   * and the status panel offer one Abort; `git merge --abort` there failed with "There is no merge to abort").
   */
  async mergeAbort() {
    const op = await this.opState();
    if (op.kind === 'cherry-pick') await this.git(['cherry-pick', '--abort']);
    else if (op.kind === 'revert') await this.git(['revert', '--abort']);
    else if (op.kind === 'rebase') await this.git(['rebase', '--abort']);
    else await this.git(['merge', '--abort']);
  }
  /**
   * Goes on with the rebase, cherry-pick or revert that stopped (on conflicts the user resolved and staged); stopping
   * again on the next commit's conflicts is not a failure. A merge goes on with a commit (`merge --continue`).
   */
  async continueOp(): Promise<{ kind: OpState['kind']; conflicts: boolean }> {
    const { kind } = await this.opState();
    if (kind === 'none') throw new Error('No merge, rebase, cherry-pick or revert is in progress.');
    const cmd = kind === 'merge' ? ['merge', '--continue'] : [kind, '--continue'];
    const r = await this.git(cmd, { env: { GIT_EDITOR: 'true' }, allowFail: true });
    const out = r.stdout + r.stderr;
    if (r.code !== 0 && !/CONFLICT/.test(out)) throw new Error(r.stderr.trim() || r.stdout.trim());
    return { kind, conflicts: r.code !== 0 };
  }

  /** a merge commit takes its first parent as the mainline (`-m 1`, Fork's default): what the merge brought in */
  private async mainline(sha: string): Promise<string[]> {
    const p = await this.git(['rev-list', '--parents', '-n1', sha, '--'], { allowFail: true });
    return p.stdout.trim().split(/\s+/).length > 2 ? ['-m', '1'] : [];
  }
  async cherryPick(sha: string) {
    const r = await this.git(['cherry-pick', ...(await this.mainline(sha)), sha], { allowFail: true });
    if (r.code !== 0 && !/CONFLICT/.test(r.stdout + r.stderr)) throw new Error(r.stderr || r.stdout);
    return { conflicts: /CONFLICT/.test(r.stdout + r.stderr) };
  }
  async revert(sha: string) {
    const r = await this.git(['revert', '--no-edit', ...(await this.mainline(sha)), sha], { allowFail: true });
    if (r.code !== 0 && !/CONFLICT/.test(r.stdout + r.stderr)) throw new Error(r.stderr || r.stdout);
    return { conflicts: /CONFLICT/.test(r.stdout + r.stderr) };
  }
  /** `keep`: moves the branch back and keeps local changes, refusing when one would be lost (what Undo uses) */
  async reset(sha: string, mode: 'soft' | 'mixed' | 'hard' | 'keep') {
    await this.git(['reset', `--${mode}`, sha]);
  }
  /** the index as a tree (Undo of staging puts it back with readTree); null while files are in conflict */
  async writeTree(): Promise<string | null> {
    const r = await this.git(['write-tree'], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async readTree(tree: string) {
    await this.git(['read-tree', tree]);
  }
  /** a deleted branch or tag back where it was (only when nothing of that name exists meanwhile) */
  async restoreRef(ref: string, sha: string) {
    await this.git(['update-ref', ref, sha, '']);
  }
  /** a branch or tag removed only while it still points at `sha` (Undo never deletes one that moved on) */
  async deleteRefAt(ref: string, sha: string) {
    await this.git(['update-ref', '-d', ref, sha]);
  }
  /**
   * The submodules whose recorded commit differs between two commits of this repository, and whether each is
   * checked out and still at the commit `from` recorded — only those may be moved for the user: a submodule they
   * moved themselves, or never initialized, is left alone.
   */
  async changedSubmodules(from: string, to: string): Promise<{ path: string; from: string; to: string; initialized: boolean; inSync: boolean }[]> {
    const listed = await this.git(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], { allowFail: true });
    const paths = listed.stdout.split('\n').map((l) => l.slice(l.indexOf(' ') + 1).trim()).filter(Boolean);
    if (!paths.length || from === to) return [];
    const d = await this.git(['diff', '--raw', '--no-abbrev', '-z', from, to, '--', ...paths], { allowFail: true });
    const out: { path: string; from: string; to: string; initialized: boolean; inSync: boolean }[] = [];
    const parts = d.stdout.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(parts[i]);
      if (!m || m[2] !== '160000' || m[1] !== '160000') continue;
      const p = parts[i + 1];
      const dir = path.join(this.dir, p);
      const initialized = existsSync(path.join(dir, '.git'));
      const head = initialized ? (await runGit(['rev-parse', 'HEAD'], { cwd: dir, allowFail: true })).stdout.trim() : '';
      out.push({ path: p, from: m[3], to: m[4], initialized, inSync: initialized && head === m[3] });
    }
    return out;
  }

  // ---------- stash ----------

  /** the new stash's commit (null when there was nothing to stash): Undo pops exactly that one */
  async stashPush(message: string, keepIndex: boolean, includeUntracked: boolean): Promise<{ sha: string | null }> {
    const top = async () => (await this.git(['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true })).stdout.trim();
    const before = await top();
    const args = ['stash', 'push'];
    if (keepIndex) args.push('--keep-index');
    if (includeUntracked) args.push('-u');
    if (message) args.push('-m', message);
    await this.git(args);
    const after = await top();
    return { sha: after && after !== before ? after : null };
  }
  /** pops the stash with that commit, wherever it is in the list now */
  async stashPopCommit(sha: string) {
    const list = (await this.git(['stash', 'list', '--format=%H'])).stdout.split('\n').filter(Boolean);
    const i = list.indexOf(sha);
    if (i < 0) throw new Error('That stash is no longer in the list.');
    await this.git(['stash', 'pop', `stash@{${i}}`]);
  }
  /** a dropped stash back into the list (its commit is kept by git for a while) */
  async stashStore(sha: string, message: string) {
    await this.git(['stash', 'store', '-m', message || 'Restored by Prong', sha]);
  }
  async stashApply(index: number, pop: boolean) {
    await this.git(['stash', pop ? 'pop' : 'apply', `stash@{${index}}`]);
  }
  /**
   * `git stash branch`: a new branch at the commit the stash was made on, checked out, the stash applied there and
   * dropped (kept when it does not apply cleanly). The name it got (see storedBranchName).
   */
  async stashBranch(name: string, index: number): Promise<{ name: string }> {
    const stored = await this.storedBranchName(name);
    await this.git(['stash', 'branch', stored, `stash@{${index}}`]);
    return { name: stored };
  }
  /** what was dropped (its commit and message), for Undo */
  async stashDrop(index: number): Promise<{ sha: string; message: string }> {
    const sha = (await this.git(['rev-parse', `stash@{${index}}`])).stdout.trim();
    const message = (await this.git(['log', '-1', '--format=%gs', '-g', `stash@{${index}}`], { allowFail: true })).stdout.trim();
    await this.git(['stash', 'drop', `stash@{${index}}`]);
    return { sha, message };
  }

  // ---------- repository lifecycle ----------

  /**
   * `net`: the connection to clone with (an SSH key, an account): the submodules cloned with it use it too — their
   * git processes inherit its environment and `-c` settings.
   */
  static async clone(url: string, dest: string, recursive: boolean, onProgress?: Progress, net?: { env: Record<string, string>; config: string[] } | null, opts: { partial?: boolean } = {}) {
    const cfg = (net?.config ?? []).flatMap((c) => ['-c', c]);
    // partial: the history without the contents of old file versions (fetched when needed) — a large repository
    // arrives in a fraction of the time, and a broken connection costs less
    const partial = opts.partial ? ['--filter=blob:none', ...(recursive ? ['--also-filter-submodules'] : [])] : [];
    const args = [...cfg, 'clone', '--progress', ...partial, ...(recursive ? ['--recurse-submodules'] : []), '--', url, dest];
    await runGit(args, { cwd: path.dirname(dest), onLine: (l) => onProgress?.(l, progressOf(l)), env: net?.env });
    return new Repo(dest);
  }
  /** can this address be read with that connection? (`git ls-remote <url> HEAD`, read-only, nothing is written) */
  static async testClone(url: string, net?: { env: Record<string, string>; config: string[] } | null) {
    const cfg = (net?.config ?? []).flatMap((c) => ['-c', c]);
    // outside any repository: in the engine's own folder git would read (or choke on) that folder's .git
    const r = await runGit([...cfg, 'ls-remote', url, 'HEAD'], { cwd: homedir(), allowFail: true, timeoutMs: 30000, env: net?.env });
    return { ok: r.code === 0, output: (r.stderr || r.stdout).trim() };
  }
  static async init(dir: string, initialBranch = 'main') {
    await runGit(['init', '-b', initialBranch, dir], { cwd: path.dirname(dir) });
    return new Repo(dir);
  }

  async config(key: string): Promise<string | null> {
    const r = await this.git(['config', '--get', key], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async setConfig(key: string, value: string) {
    await this.git(['config', key, value]);
  }
}

function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export { kindOf };
