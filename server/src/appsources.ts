import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { runGit, RunOptions } from './git/run.js';

/**
 * Prong's own sources as the agent sees them: a version log of the agent's edits and the interface build the
 * desktop app serves.
 *
 * Version log. If the sources folder is a git repository of its own, versions are commits there. Otherwise (a
 * plain folder, e.g. inside a larger checkout) Prong keeps a shadow repository under
 * ~/.prong/app-sources/<hash>.git whose work tree is the folder, so nothing is written into the folder and the
 * enclosing repository never sees a nested one. Only files the agent changed during a run go into its version:
 * edits the user had in progress stay out.
 *
 * Interface build. `expo export` of the sources into ~/.prong/ui/builds/<stamp>; the pointer ~/.prong/ui/current
 * selects what the engine serves instead of the factory build inside the app. Reset to factory removes the pointer.
 */

const stateDir = () => process.env.PRONG_STATE_DIR ?? path.join(homedir(), '.prong');
const AGENT_PREFIX = 'agent: ';
const EXCLUDES = ['node_modules/', '.expo/', 'dist/', 'web-build/', 'macos/build/', 'macos/vendor/', 'server/dist/', '*.log', '.DS_Store'];

export interface AppVersionInfo {
  sha: string;
  n: number;
  title: string;
  prompt: string;
  time: number;
  files: { path: string; status: string; additions: number; deletions: number }[];
  status: 'applied' | 'reverted';
  /** the commit that reverted this version (when reverted) */
  revertSha?: string;
}

export class AppSources {
  readonly dir: string;
  readonly own: boolean;
  readonly gitDir: string;
  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.own = existsSync(path.join(this.dir, '.git'));
    this.gitDir = this.own ? path.join(this.dir, '.git') : path.join(stateDir(), 'app-sources', createHash('sha1').update(this.dir).digest('hex').slice(0, 16) + '.git');
  }

  git(args: string[], opts: Partial<RunOptions> = {}) {
    return runGit(this.own ? args : [`--git-dir=${this.gitDir}`, `--work-tree=${this.dir}`, ...args], { cwd: this.dir, ...opts });
  }

  /** Creates the shadow repository with the current folder as its first commit (the baseline). */
  async ensure() {
    if (!existsSync(this.dir) || !statSync(this.dir).isDirectory()) throw new Error(`App sources folder not found: ${this.dir}`);
    if (this.own || existsSync(path.join(this.gitDir, 'HEAD'))) return;
    mkdirSync(path.dirname(this.gitDir), { recursive: true });
    await runGit(['init', '--bare', '-q', this.gitDir], { cwd: this.dir });
    for (const [k, v] of [
      ['core.bare', 'false'],
      ['core.worktree', this.dir],
      ['user.name', 'Prong agent'],
      ['user.email', 'agent@prong.local'],
      ['commit.gpgsign', 'false'],
    ])
      await runGit(['--git-dir=' + this.gitDir, 'config', k, v], { cwd: this.dir });
    mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
    writeFileSync(path.join(this.gitDir, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
    await this.git(['add', '-A']);
    await this.git(['commit', '-q', '--allow-empty', '-m', 'Baseline: sources before the first agent change']);
  }

  /** path → content id of every file that differs from HEAD (tracked changes and untracked files) */
  async dirty(): Promise<Map<string, string>> {
    const r = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const out = new Map<string, string>();
    const parts = r.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i];
      if (rec.length < 4) continue;
      const code = rec.slice(0, 2);
      const file = rec.slice(3);
      if (code[0] === 'R' || code[0] === 'C') i++; // the source path follows a rename
      const full = path.join(this.dir, file);
      let id = 'deleted';
      try {
        if (statSync(full).isFile()) id = createHash('sha1').update(readFileSync(full)).digest('hex');
      } catch {
        /* deleted */
      }
      out.set(file, id);
    }
    return out;
  }

  /**
   * Edits made outside the agent. In the shadow log they are committed as "Manual changes" (the log belongs to
   * Prong, so this is safe and keeps versions and reverts clean); a folder's own repository is never touched.
   */
  async commitManualChanges(): Promise<boolean> {
    if (this.own) return false;
    if ((await this.dirty()).size === 0) return false;
    await this.git(['add', '-A']);
    await this.git(['commit', '-q', '-m', 'Manual changes']);
    return true;
  }

  /** before an agent run: the baseline to tell the agent's edits from edits already in progress */
  async prepare(): Promise<Record<string, string>> {
    await this.ensure();
    await this.commitManualChanges();
    return Object.fromEntries(await this.dirty());
  }

  /** after an agent run: commits what the agent changed as a version; null when it changed nothing */
  async record(message: string, before: Record<string, string>): Promise<{ sha: string; files: string[] } | null> {
    await this.ensure();
    const now = await this.dirty();
    const changed = [...now.entries()].filter(([f, id]) => before[f] !== id).map(([f]) => f);
    // a file the user had changed and the agent restored to HEAD is a change too
    for (const f of Object.keys(before)) if (!now.has(f)) changed.push(f);
    if (!changed.length) return null;
    await this.git(['add', '-A', '--', ...changed]);
    const subject = AGENT_PREFIX + message.replace(/\s+/g, ' ').trim().slice(0, 100);
    await this.git(['commit', '-q', '-m', subject, '-m', message.slice(0, 4000), '--', ...changed]);
    const sha = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    return { sha, files: changed.sort() };
  }

  /** git revert of one commit (a version, or a revert to re-apply it); returns the new commit */
  async revert(sha: string): Promise<string> {
    await this.ensure();
    // edits since the last version would block git revert in the shadow log
    await this.commitManualChanges();
    const r = await this.git(['revert', '--no-edit', sha], { allowFail: true });
    if (r.code !== 0) {
      await this.git(['revert', '--abort'], { allowFail: true });
      throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ') || 'revert failed');
    }
    return (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** Agent versions in order, with their state after every later revert / re-apply. */
  async versions(): Promise<AppVersionInfo[]> {
    if (!this.own && !existsSync(path.join(this.gitDir, 'HEAD'))) return [];
    const r = await this.git(['log', '--reverse', '--format=%H%x1f%at%x1f%s%x1f%b%x1e'], { allowFail: true });
    if (r.code !== 0) return [];
    const commits = r.stdout
      .split('\x1e')
      .map((x) => x.replace(/^\n/, ''))
      .filter(Boolean)
      .map((x) => {
        const [sha, at, subject, body] = x.split('\x1f');
        return { sha, time: parseInt(at, 10) * 1000, subject, body: body ?? '' };
      });
    const versions: AppVersionInfo[] = [];
    const bySha = new Map<string, AppVersionInfo>();
    // a revert commit's target: the version it reverts or the revert it undoes (re-apply)
    const revertOf = new Map<string, string>();
    for (const c of commits) {
      const target = c.body.match(/This reverts commit ([0-9a-f]{40})/)?.[1];
      if (target) {
        revertOf.set(c.sha, target);
        const v = bySha.get(target);
        if (v) {
          v.status = 'reverted';
          v.revertSha = c.sha;
          continue;
        }
        const undone = revertOf.get(target);
        const v2 = undone ? bySha.get(undone) : undefined;
        if (v2) {
          v2.status = 'applied';
          v2.revertSha = undefined;
        }
        continue;
      }
      if (!c.subject.startsWith(AGENT_PREFIX)) continue;
      const v: AppVersionInfo = { sha: c.sha, n: versions.length + 1, title: c.subject.slice(AGENT_PREFIX.length), prompt: c.body.trim() || c.subject.slice(AGENT_PREFIX.length), time: c.time, files: [], status: 'applied' };
      versions.push(v);
      bySha.set(c.sha, v);
    }
    for (const v of versions) {
      const s = await this.git(['show', '--numstat', '--format=', '--no-renames', v.sha], { allowFail: true });
      const names = await this.git(['show', '--name-status', '--format=', '--no-renames', v.sha], { allowFail: true });
      const status = new Map(names.stdout.split('\n').filter(Boolean).map((l) => [l.slice(2).trim(), l[0]]));
      v.files = s.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [a, d, p] = l.split('\t');
          return { path: p, status: status.get(p) ?? 'M', additions: parseInt(a, 10) || 0, deletions: parseInt(d, 10) || 0 };
        });
    }
    return versions;
  }
}

// ---------- interface build ----------

const uiDir = () => path.join(stateDir(), 'ui');
const pointer = () => path.join(uiDir(), 'current');

/**
 * The build the engine serves, or null for the factory build inside the app. A factory build newer than the
 * agent's (the app was rebuilt from the same sources since) wins: it already contains the agent's changes.
 */
export function currentUiBuild(factory = process.env.PRONG_WEB_DIR): string | null {
  try {
    const dir = readFileSync(pointer(), 'utf8').trim();
    if (!dir || !existsSync(path.join(dir, 'index.html'))) return null;
    if (factory && existsSync(path.join(factory, 'index.html')) && statSync(path.join(factory, 'index.html')).mtimeMs > statSync(path.join(dir, 'index.html')).mtimeMs) return null;
    return dir;
  } catch {
    return null;
  }
}

export function resetUiToFactory() {
  rmSync(pointer(), { force: true });
}

/**
 * Builds the interface from the sources into a new folder and points the engine at it. The command is
 * `node <sources>/node_modules/expo/bin/cli export --platform web --output-dir <out>` run by the engine's own
 * Node; PRONG_UI_BUILD_CMD overrides it (tests), with {out} replaced by the output folder.
 */
export async function buildUi(sources: string, onLine: (l: string) => void = () => {}, signal?: AbortSignal): Promise<string> {
  const out = path.join(uiDir(), 'builds', String(Date.now()));
  mkdirSync(path.dirname(out), { recursive: true });
  const custom = process.env.PRONG_UI_BUILD_CMD;
  const [cmd, args] = custom ? ['/bin/sh', ['-c', custom.replaceAll('{out}', JSON.stringify(out))]] : [process.execPath, [path.join(sources, 'node_modules/expo/bin/cli'), 'export', '--platform', 'web', '--output-dir', out]];
  if (!custom && !existsSync(path.join(sources, 'node_modules/expo/bin/cli'))) throw new Error(`Cannot build the interface: ${sources} has no node_modules (run npm install there)`);
  const tail: string[] = [];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args as string[], { cwd: sources, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const feed = (b: Buffer) => {
      for (const l of b.toString().split(/\r?\n/)) {
        if (!l.trim()) continue;
        tail.push(l);
        if (tail.length > 20) tail.shift();
        onLine(l);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? -1));
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
  if (code !== 0 || !existsSync(path.join(out, 'index.html'))) {
    rmSync(out, { recursive: true, force: true });
    throw new Error(`Interface build failed: ${tail.slice(-4).join(' ').slice(0, 400) || `exit ${code}`}`);
  }
  // the bundled file icons are generated assets the export may not carry: keep the factory ones available
  const factory = process.env.PRONG_WEB_DIR;
  if (factory && !existsSync(path.join(out, 'file-icons')) && existsSync(path.join(factory, 'file-icons'))) cpSync(path.join(factory, 'file-icons'), path.join(out, 'file-icons'), { recursive: true });
  const tmp = pointer() + '.tmp';
  writeFileSync(tmp, out);
  renameSync(tmp, pointer());
  pruneBuilds(out);
  return out;
}

/** keeps the newest three builds and the current one */
function pruneBuilds(keep: string) {
  const dir = path.join(uiDir(), 'builds');
  const all = readdirSync(dir)
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => Number(b) - Number(a));
  for (const d of all.slice(3)) {
    const full = path.join(dir, d);
    if (full !== keep) rmSync(full, { recursive: true, force: true });
  }
}
