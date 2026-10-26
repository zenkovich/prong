import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { mimeOf, Repo, RebaseTodoItem, safeRelPath, WORKTREE } from './git/repo.js';
import { accountAuth, NetAuth, RepoAuth, resolveAuth, sshAuth, sshDir, validKeyPath } from './auth.js';
import { allQueues, cancelQueued, LOCK_FILES, onQueueChange, QueueItem, queueFor } from './queue.js';
import { restoreFromUndo, saveForUndo } from './undo.js';
import { serveFile } from './http-file.js';
import { systemFileIcon } from './fileicons.js';
import { runGit } from './git/run.js';
import { scanRepos } from './scan.js';
import { loadSession, loadSettings, loadWorkspaces, readJson as readState, saveSession, saveSettings, saveWorkspaces, writeJson, Workspace } from './state.js';
import { addKeyToAgent, deleteSecret, generateSshKey, getSecret, listSshKeys, openTerminal, openWith, reveal, setSecret, testSsh, which } from './system.js';
import * as github from './github.js';
import { accountToken, serializeStored, SignInExpired, storedFrom, type TokenAccount } from './tokens.js';
import { checkClaude, runAgent } from './agent.js';
import { getAvatar } from './avatars.js';
import { checkIncoming } from './origin.js';
import { AppSources, buildUi, currentUiBuild, resetUiToFactory } from './appsources.js';
import type { FileChange, Hunk } from './types.js';

/**
 * Local HTTP API for the Prong UI.
 *
 *   GET  /api/health                      → { ok, git, version }
 *   GET  /api/events                      → SSE stream of operation progress
 *   GET  /api/repos                       → known repositories (persisted in ~/.prong/repos.json)
 *   POST /api/repos/open   { path }       → validates and registers a repository
 *   POST /api/repos/clone  { url, dir, recursive } → long operation (opId)
 *   POST /api/repos/init   { path }
 *   POST /api/repos/forget { path }; POST /api/repos/move { path, workspace }
 *   POST /api/repo/<op>    { path, ...args } → see OPS below; long ops return { opId }
 *   GET/PUT /api/workspaces, /api/settings; POST /api/scan { path, depth }
 *   POST /api/system/{open,reveal,terminal}; /api/ssh/{keys,generate,agentAdd,test}
 *   GET/POST/DELETE /api/accounts (GitHub, tokens in Keychain); POST /api/github/{repos,addKey,deviceStart,devicePoll}
 *   GET /api/agent/check; POST /api/agent/run { prompt, cwd, mode } → long op streaming text; POST /api/ops/cancel { opId }
 *   GET  /api/blob?repo&rev&file   → file content at a revision (WORKTREE, :0 or any rev), byte ranges
 *   GET  /api/fileicon?ext         → the OS icon for a file extension (png/svg)
 *   POST /api/app/{prepare,record,revert,versions,rebuild,factory} { sources } → agent versions of Prong's own
 *        sources (shadow git repository) and the interface build the desktop app serves
 *   GET  /*                  → static web build when PRONG_WEB_DIR is set (desktop app shell)
 */

export interface OpEvent {
  opId: string;
  label: string;
  /** broadcast notices that are not tied to an operation the client started */
  event?: 'ui-updated' | 'queue';
  /** `queue`: the repository and its action queue */
  repo?: string;
  items?: QueueItem[];
  line?: string;
  progress?: number | null;
  done?: boolean;
  error?: string;
}

const WEB_DIR = process.env.PRONG_WEB_DIR ? path.resolve(process.env.PRONG_WEB_DIR) : null;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.map': 'application/json' };
// resolved per call so tests can point PRONG_STATE_DIR at a temp folder after this module is loaded
const STATE_DIR = () => process.env.PRONG_STATE_DIR ?? path.join(homedir(), '.prong');
const REPOS_FILE = () => path.join(STATE_DIR(), 'repos.json');

interface KnownRepo {
  path: string;
  name: string;
  /** where the user put it (Open / Clone / Move); scans never change it */
  workspace: string;
  /** workspaces whose folder scans find it — membership derived from scan roots, maintained by /api/scan */
  workspaces?: string[];
  lastOpened: number;
  pinned?: boolean;
  /** how git signs in to its remotes; submodules and nested repositories inherit it (see auth.ts) */
  auth?: RepoAuth;
}

function loadRepos(): KnownRepo[] {
  try {
    return JSON.parse(readFileSync(REPOS_FILE(), 'utf8'));
  } catch {
    return [];
  }
}
function saveRepos(list: KnownRepo[]) {
  mkdirSync(STATE_DIR(), { recursive: true });
  writeFileSync(REPOS_FILE(), JSON.stringify(list, null, 2));
}

function expandHome(p: string) {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const tokenDeps = { getSecret, setSecret, refresh: github.refreshUserToken, now: Date.now };

/** the account's token, renewed when it has expired; a sign-in that is gone is the user's to redo */
async function signedInToken(acc: TokenAccount): Promise<string> {
  try {
    return await accountToken(acc, tokenDeps);
  } catch (e) {
    if (e instanceof SignInExpired) throw new HttpError(400, e.message);
    throw e;
  }
}

/** a GitHub request of the account; a token GitHub refuses (revoked, or expired) is reported as a sign-in to redo */
async function asAccount<T>(acc: TokenAccount, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(await signedInToken(acc));
  } catch (e) {
    if (e instanceof github.GhUnauthorized) throw new HttpError(400, new SignInExpired(acc.login, acc.host, 'was refused by GitHub: revoked or expired').message);
    throw e;
  }
}

/**
 * Operations that do not go through the repository's action queue: reads, the long ones (they queue their work
 * themselves, see longOp), and removing a stale lock (the queue is what waits for it).
 */
const UNQUEUED = new Set([
  'snapshot', 'snapshotCached', 'status', 'log', 'commitFiles', 'commitFileDiff', 'logUntil', 'logPosition', 'stashFiles', 'fileDiff', 'mediaSides', 'blobFile', 'blame',
  'config', 'globalConfig', 'logPage', 'logFile', 'fileAt', 'submodules', 'submoduleCommits', 'submoduleRange', 'changedSubmodules', 'authInfo', 'setAuth', 'testAuth',
  'fetch', 'unshallow', 'followAllBranches', 'pull', 'push', 'pushTag', 'submoduleUpdate', 'pushBranches', 'removeLock',
]);
/** what the queue shows for an operation: "Checkout ver/925", "Stage hunk" */
function opLabel(op: string, b: any): string {
  const words = op.replace(/([A-Z])/g, ' $1').toLowerCase();
  const what = b?.ref ?? b?.name ?? b?.branch ?? (Array.isArray(b?.paths) && b.paths.length === 1 ? b.paths[0] : Array.isArray(b?.paths) ? `${b.paths.length} files` : Array.isArray(b?.names) ? `${b.names.length} branches` : '');
  return `${words[0].toUpperCase()}${words.slice(1)}${what ? ` ${String(what)}` : ''}`;
}

/**
 * A connection (SSH key, account) as environment for git processes Prong does not start itself: its `-c` settings
 * become GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n, which every git command reads.
 */
export function gitEnvOf(a: { env: Record<string, string>; config: string[] } | null): Record<string, string> | undefined {
  if (!a) return undefined;
  const env: Record<string, string> = { ...a.env };
  a.config.forEach((c, i) => {
    const eq = c.indexOf('=');
    env[`GIT_CONFIG_KEY_${i}`] = eq < 0 ? c : c.slice(0, eq);
    env[`GIT_CONFIG_VALUE_${i}`] = eq < 0 ? 'true' : c.slice(eq + 1);
  });
  if (a.config.length) env.GIT_CONFIG_COUNT = String(a.config.length);
  return env;
}

/** Prong's test stand-in for Claude Code (tools/fake-claude.sh) */
const isTestAgent = (p: unknown) => typeof p === 'string' && /(^|\/)fake-claude\.sh$/.test(p);

/** branch names from the client: strings that git cannot read as options */
function refNames(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 1000) throw new HttpError(400, 'bad branch list');
  for (const n of v) if (typeof n !== 'string' || !n || n.startsWith('-') || /[\0\s~^:?*[\\]/.test(n)) throw new HttpError(400, `bad branch name ${String(n)}`);
  return v as string[];
}

/** a remote's name from the client: one git cannot read as an option or a path outside */
function remoteName(v: unknown): string {
  const s = String(v ?? '');
  if (!/^[A-Za-z0-9._/-]+$/.test(s) || s.startsWith('-') || s.includes('..')) throw new HttpError(400, `bad remote ${s}`);
  return s;
}

/** revisions for log commands: ref names and commit ids, plus the few set flags the history filter uses */
function safeRevs(revs: unknown): string[] {
  if (!Array.isArray(revs) || revs.length === 0) return ['--all'];
  const flags = new Set(['--all', '--branches', '--tags', '--remotes', 'HEAD']);
  for (const r of revs) if (typeof r !== 'string' || (r.startsWith('-') && !flags.has(r)) || r.includes('\0')) throw new HttpError(400, `bad revision ${String(r)}`);
  return revs as string[];
}

export function createApi(opts: { log?: (s: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const clients = new Set<ServerResponse>();
  let opSeq = 0;

  const emit = (e: OpEvent) => {
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(data);
  };
  // the action queue of every repository, as it changes (queued, waiting for a lock, running)
  onQueueChange((dir, items) => emit({ opId: 'queue', label: 'queue', event: 'queue', repo: dir, items }));

  /** Runs a long git operation in the background and streams its progress. */
  const running = new Map<string, AbortController>();
  /** `dir`: the operation changes that repository, so it waits its turn in the repository's queue */
  const longOp = (label: string, fn: (progress: (line: string, p: number | null) => void, signal: AbortSignal) => Promise<unknown>, dir?: string) => {
    const opId = `op${++opSeq}-${Date.now().toString(36)}`;
    const ctl = new AbortController();
    running.set(opId, ctl);
    emit({ opId, label, progress: 0 });
    const work = () => fn((line, p) => emit({ opId, label, line, progress: p }), ctl.signal);
    (dir ? queueFor(dir).run(label, work) : work())
      .then(() => emit({ opId, label, done: true, progress: 1 }))
      .catch((err: Error) => emit({ opId, label, done: true, error: ctl.signal.aborted ? 'Stopped' : err.message }))
      .finally(() => running.delete(opId));
    return { opId };
  };

  /** a connection setting as git needs it; a key or account that is gone is an error, not a silent fallback */
  const netAuthOf = async (auth: RepoAuth | null | undefined, where: string): Promise<NetAuth | null> => {
    if (!auth || auth.kind === 'default') return null;
    if (auth.kind === 'ssh') {
      const key = validKeyPath(auth.key);
      if (!key) throw new HttpError(400, `The SSH key ${auth.key} chosen for ${where} is not in ${sshDir()} any more. Pick another one in Connection settings.`);
      return sshAuth(key);
    }
    const acc = readState<any[]>('accounts.json', []).find((a) => a.id === auth.account);
    if (!acc) throw new HttpError(400, `The account ${auth.account} chosen for ${where} is not signed in any more. Sign in under Accounts, or pick another one in Connection settings.`);
    return accountAuth(acc.host, acc.login, await signedInToken(acc));
  };
  // every network command of a repository (and of anything inside it) signs in the way its settings say
  Repo.auth = async (dir) => {
    const r = resolveAuth(loadRepos(), dir);
    return r ? netAuthOf(r.auth, path.basename(r.from)) : null;
  };
  const checkAuth = (a: unknown): RepoAuth | null => {
    if (a === null || a === undefined) return null;
    const x = a as RepoAuth;
    if (x.kind === 'default') return { kind: 'default' };
    if (x.kind === 'ssh' && validKeyPath(String(x.key))) return { kind: 'ssh', key: path.basename(validKeyPath(String(x.key))!) };
    if (x.kind === 'account' && readState<any[]>('accounts.json', []).some((acc) => acc.id === x.account)) return { kind: 'account', account: String(x.account) };
    throw new HttpError(400, 'unknown SSH key or account');
  };

  const repoOf = (body: any): Repo => {
    const p = expandHome(String(body?.path ?? ''));
    if (!p || !Repo.isRepo(p)) throw new HttpError(400, `Not a git repository: ${p}`);
    return new Repo(p);
  };

  type Handler = (body: any) => Promise<unknown>;
  const OPS: Record<string, Handler> = {
    snapshot: async (b) => repoOf(b).snapshot(b.limit ?? 300),
    snapshotCached: async (b) => repoOf(b).cachedSnapshot(),
    status: async (b) => repoOf(b).status(),
    log: async (b) => repoOf(b).log(b.limit ?? 500, b.revs ?? ['--all']),
    commitFiles: async (b) => repoOf(b).commitFiles(b.sha),
    commitFileDiff: async (b) => {
      if (!safeRelPath(String(b.file)) || (b.oldPath && !safeRelPath(String(b.oldPath)))) throw new HttpError(400, 'bad path');
      if (!/^([0-9a-f]{4,64}|stash@\{\d+\})$/.test(String(b.rev))) throw new HttpError(400, 'bad revision');
      return repoOf(b).commitFileDiff(String(b.rev), String(b.file), b.oldPath ? String(b.oldPath) : undefined, !!b.force);
    },
    logUntil: async (b) => {
      if (!/^[0-9a-f]{40,64}$/.test(String(b.sha))) throw new HttpError(400, 'bad commit id');
      return repoOf(b).logUntil(String(b.sha), Math.max(0, Number(b.skip) || 0), Math.min(Math.max(0, Number(b.after) || 0), 5000), safeRevs(b.revs), Math.min(Number(b.max) || 200000, 1000000));
    },
    logPosition: async (b) => {
      if (!/^[0-9a-f]{40,64}$/.test(String(b.sha))) throw new HttpError(400, 'bad commit id');
      return repoOf(b).logPosition(String(b.sha), safeRevs(b.revs), Math.min(Number(b.max) || 200000, 1000000));
    },
    stashFiles: async (b) => repoOf(b).stashFiles(b.index),
    fileDiff: async (b) => repoOf(b).fileDiff(b.file, b.area, !!b.force),
    mediaSides: async (b) => repoOf(b).mediaSides(String(b.file), String(b.area), b.oldPath ? String(b.oldPath) : undefined),
    blobFile: async (b) => {
      const f = await repoOf(b).materializeBlob(String(b.rev), String(b.file));
      if (!f) throw new HttpError(404, `${b.file} does not exist at ${b.rev}`);
      return f;
    },
    blame: async (b) => {
      if (b.rev !== undefined && !/^[0-9a-f]{40,64}$/.test(String(b.rev))) throw new HttpError(400, 'bad revision');
      return repoOf(b).blame(b.file, b.rev);
    },
    stage: async (b) => repoOf(b).stage(b.paths),
    stageAll: async (b) => repoOf(b).stageAll(),
    unstage: async (b) => repoOf(b).unstage(b.paths),
    unstageAll: async (b) => repoOf(b).unstageAll(),
    // discarding keeps copies first: the result's `undo` token puts the files back (undoDiscard)
    discard: async (b) => {
      const r = repoOf(b);
      const undo = await saveForUndo(r, b.paths);
      await r.discard(b.paths);
      return { undo };
    },
    discardAll: async (b) => {
      const r = repoOf(b);
      const undo = await saveForUndo(r, null);
      await r.discardAll();
      return { undo };
    },
    undoDiscard: async (b) => restoreFromUndo(repoOf(b), String(b.token ?? '')),
    stageHunk: async (b) => repoOf(b).stageHunk(b.file as FileChange, b.hunk as Hunk),
    unstageHunk: async (b) => repoOf(b).unstageHunk(b.file as FileChange, b.hunk as Hunk),
    discardHunk: async (b) => {
      const r = repoOf(b);
      const f = b.file as FileChange;
      if (!safeRelPath(String(f?.path))) throw new HttpError(400, 'bad path');
      const undo = await saveForUndo(r, [f.path]);
      await r.discardHunk(f, b.hunk as Hunk);
      return { undo };
    },
    resolveConflict: async (b) => repoOf(b).resolveConflict(b.file, b.take),
    commit: async (b) => ({ sha: await repoOf(b).commit(b.message, { amend: !!b.amend }) }),
    checkout: async (b) => repoOf(b).checkout(refNames([b.ref])[0]),
    checkoutWithStash: async (b) => repoOf(b).checkoutWithStash(refNames([b.ref])[0], b.start ? refNames([b.start])[0] : undefined),
    /** a lock file left by a git process that crashed: only one of git's lock files, unchanged for a minute */
    removeLock: async (b) => {
      const r = repoOf(b);
      const gd = (await r.git(['rev-parse', '--absolute-git-dir'])).stdout.trim();
      const name = String(b.lock ?? '');
      if (!LOCK_FILES.includes(name)) throw new HttpError(400, 'not a git lock file');
      const file = path.join(gd, name);
      if (!existsSync(file)) return { removed: false };
      if (Date.now() - statSync(file).mtimeMs < 60_000) throw new HttpError(409, `${name} changed less than a minute ago: a git process is probably still working`);
      unlinkSync(file);
      return { removed: true };
    },
    createBranch: async (b) => repoOf(b).createBranch(b.name, b.start ?? 'HEAD', !!b.checkout),
    deleteBranch: async (b) => repoOf(b).deleteBranch(b.name, !!b.force, b.remote),
    deleteRemoteBranch: async (b) => repoOf(b).deleteRemoteBranch(String(b.remote), String(b.branch)),
    deleteBranches: async (b) => repoOf(b).deleteBranches(refNames(b.names), !!b.force, !!b.withRemote),
    deleteRemoteBranches: async (b) => repoOf(b).deleteRemoteBranches(refNames(b.refs)),
    pushBranches: async (b) => {
      const r = repoOf(b);
      const names = refNames(b.names);
      const remote = refNames([b.remote ?? 'origin'])[0];
      return longOp(`Pushing ${names.length} branches`, async (p) => {
        const res = await r.pushBranches(names, remote, p);
        if (res.failed.length) throw new Error(`${res.failed.length} of ${names.length} not pushed:\n${res.failed.map((f) => `${f.name}: ${f.error}`).join('\n')}`);
      }, r.dir);
    },
    renameBranch: async (b) => repoOf(b).renameBranch(b.oldName, b.newName),
    setUpstream: async (b) => repoOf(b).setUpstream(b.branch, b.upstream),
    createTag: async (b) => repoOf(b).createTag(b.name, b.sha ?? 'HEAD', b.message),
    deleteTag: async (b) => repoOf(b).deleteTag(b.name),
    merge: async (b) => repoOf(b).merge(b.source, { noFf: !!b.noFf, squash: !!b.squash }),
    rebase: async (b) => repoOf(b).rebase(b.onto, { preserveMerges: !!b.preserveMerges, autostash: !!b.autostash }),
    rebaseInteractive: async (b) => repoOf(b).rebaseInteractive(b.onto, b.todo as RebaseTodoItem[]),
    rebaseContinue: async (b) => repoOf(b).rebaseContinue(),
    rebaseAbort: async (b) => repoOf(b).rebaseAbort(),
    mergeAbort: async (b) => repoOf(b).mergeAbort(),
    cherryPick: async (b) => repoOf(b).cherryPick(b.sha),
    revert: async (b) => repoOf(b).revert(b.sha),
    reset: async (b) => {
      const mode = ['soft', 'mixed', 'hard', 'keep'].includes(b.mode) ? b.mode : 'mixed';
      if (!/^[0-9a-f]{4,64}$/.test(String(b.sha)) && !/^HEAD[~^]?\d*$/.test(String(b.sha))) throw new HttpError(400, 'bad commit');
      return repoOf(b).reset(String(b.sha), mode);
    },
    writeTree: async (b) => ({ tree: await repoOf(b).writeTree() }),
    readTree: async (b) => {
      if (!/^[0-9a-f]{40,64}$/.test(String(b.tree))) throw new HttpError(400, 'bad tree');
      return repoOf(b).readTree(String(b.tree));
    },
    restoreRef: async (b) => {
      const ref = String(b.ref ?? '');
      if (!/^refs\/(heads|tags)\/[^\s~^:?*[\\]+$/.test(ref) || ref.includes('..')) throw new HttpError(400, 'bad ref');
      if (!/^[0-9a-f]{40,64}$/.test(String(b.sha))) throw new HttpError(400, 'bad object');
      return repoOf(b).restoreRef(ref, String(b.sha));
    },
    deleteRefAt: async (b) => {
      const ref = String(b.ref ?? '');
      if (!/^refs\/(heads|tags)\/[^\s~^:?*[\\]+$/.test(ref) || ref.includes('..')) throw new HttpError(400, 'bad ref');
      if (!/^[0-9a-f]{40,64}$/.test(String(b.sha))) throw new HttpError(400, 'bad object');
      return repoOf(b).deleteRefAt(ref, String(b.sha));
    },
    stashPopCommit: async (b) => {
      if (!/^[0-9a-f]{40,64}$/.test(String(b.sha))) throw new HttpError(400, 'bad stash');
      return repoOf(b).stashPopCommit(String(b.sha));
    },
    stashStore: async (b) => {
      if (!/^[0-9a-f]{40,64}$/.test(String(b.sha))) throw new HttpError(400, 'bad stash');
      return repoOf(b).stashStore(String(b.sha), String(b.message ?? ''));
    },
    changedSubmodules: async (b) => {
      const rev = (v: unknown) => {
        if (!/^[0-9a-f]{40,64}$/.test(String(v))) throw new HttpError(400, 'bad commit');
        return String(v);
      };
      return repoOf(b).changedSubmodules(rev(b.from), rev(b.to));
    },
    stashPush: async (b) => repoOf(b).stashPush(b.message ?? '', !!b.keepIndex, b.includeUntracked !== false),
    stashApply: async (b) => repoOf(b).stashApply(b.index, !!b.pop),
    stashDrop: async (b) => repoOf(b).stashDrop(b.index),
    config: async (b) => ({ value: await repoOf(b).config(b.key) }),
    setConfig: async (b) => repoOf(b).setConfig(b.key, b.value),
    logPage: async (b) => repoOf(b).logPage(b.skip ?? 0, b.limit ?? 300, safeRevs(b.revs)),
    logFile: async (b) => {
      if (b.from !== undefined && !/^[0-9a-f]{40,64}$/.test(String(b.from))) throw new HttpError(400, 'bad revision');
      return repoOf(b).logFile(b.file, b.limit ?? 200, b.from ?? 'HEAD');
    },
    fileAt: async (b) => ({ content: await repoOf(b).fileAt(b.rev, b.file) }),
    submodules: async (b) => repoOf(b).submodules(),
    submoduleSync: async (b) => repoOf(b).submoduleSync(),
    submoduleCommits: async (b) => {
      if (!safeRelPath(String(b.sub))) throw new HttpError(400, 'bad submodule path');
      return repoOf(b).submoduleCommits(String(b.sub), (b.shas ?? []).filter((s: unknown) => typeof s === 'string' && /^[0-9a-f]{4,64}$/.test(s)));
    },
    submoduleRange: async (b) => {
      if (!safeRelPath(String(b.sub))) throw new HttpError(400, 'bad submodule path');
      const sha = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{4,64}$/.test(v) ? v : '');
      return repoOf(b).submoduleRange(String(b.sub), sha(b.before), sha(b.after), Math.min(Math.max(1, Number(b.limit) || 100), 1000));
    },
    submoduleUpdate: async (b) => {
      const r = repoOf(b);
      return longOp(`Updating submodules${b.paths?.length ? ` (${b.paths.length})` : ''}`, (p) => r.submoduleUpdate(b.paths, !!b.recursive, p), r.dir);
    },
    /** this repository's own connection setting, the one it inherits, and what applies */
    authInfo: async (b) => {
      const dir = repoOf(b).dir;
      const repos = loadRepos();
      const own = repos.find((r) => r.path === dir)?.auth ?? null;
      const inherited = resolveAuth(repos.filter((r) => r.path !== dir), dir);
      const effective = own ?? inherited?.auth ?? null;
      const describe = effective && effective.kind !== 'default' ? (effective.kind === 'ssh' ? `SSH key ${effective.key}` : `account ${effective.account}`) : 'system default (ssh-agent, ~/.ssh/config, credential helpers)';
      return { own, inherited: inherited ? { auth: inherited.auth, from: inherited.from, name: path.basename(inherited.from) } : null, describe, sshDir: sshDir() };
    },
    /** set (or clear: null) this repository's connection; registers the folder if it is not known yet */
    setAuth: async (b) => {
      const dir = repoOf(b).dir;
      const auth = checkAuth(b.auth);
      const list = loadRepos();
      const at = list.findIndex((r) => r.path === dir);
      if (at >= 0) list[at] = { ...list[at], auth: auth ?? undefined };
      else list.push({ path: dir, name: path.basename(dir), workspace: 'work', lastOpened: Date.now(), auth: auth ?? undefined });
      saveRepos(list);
      return { ok: true };
    },
    /** try a connection (the saved one, or one being chosen) against a remote, read-only */
    testAuth: async (b) => {
      const r = repoOf(b);
      const remote = String(b.remote ?? 'origin');
      if (!/^[A-Za-z0-9._\/-]+$/.test(remote) || remote.startsWith('-')) throw new HttpError(400, 'bad remote');
      const net = 'auth' in b ? await netAuthOf(checkAuth(b.auth), path.basename(r.dir)) : undefined;
      return { ...(await r.testConnection(remote, net)), describe: net === undefined ? 'saved setting' : net?.describe ?? 'system default' };
    },
    addRemote: async (b) => repoOf(b).addRemote(b.name, b.url),
    setRemoteUrl: async (b) => repoOf(b).setRemoteUrl(b.name, b.url),
    removeRemote: async (b) => repoOf(b).removeRemote(b.name),
    pruneRemote: async (b) => repoOf(b).pruneRemote(b.name),
    pushTag: async (b) => {
      const r = repoOf(b);
      return longOp(`Pushing tag ${b.tag}`, async () => r.pushTag(b.remote ?? 'origin', b.tag), r.dir);
    },
    checkoutDetached: async (b) => repoOf(b).checkoutDetached(b.sha),
    appendIgnore: async (b) => repoOf(b).appendIgnore(b.pattern),
    globalConfig: async (b) => ({ value: await repoOf(b).globalConfig(b.key) }),
    setGlobalConfig: async (b) => repoOf(b).setGlobalConfig(b.key, b.value),
    // long operations
    fetch: async (b) => {
      const r = repoOf(b);
      const remote = b.remote && b.remote !== '--all' ? remoteName(b.remote) : '--all';
      return longOp(`Fetching ${remote === '--all' ? 'all remotes' : remote}`, (p) => r.fetch(remote, b.prune !== false, p, { tags: !!b.tags }), r.dir);
    },
    /** widen a narrow (--single-branch) clone: follow and fetch every branch of the remote */
    followAllBranches: async (b) => {
      const r = repoOf(b);
      const remote = b.remote === undefined || b.remote === null ? undefined : String(b.remote);
      if (remote !== undefined && (!/^[A-Za-z0-9._\/-]+$/.test(remote) || remote.startsWith('-'))) throw new HttpError(400, 'bad remote');
      return longOp(`Fetching every branch${remote ? ` of ${remote}` : ''}`, (p) => r.followAllBranches(remote, p), r.dir);
    },
    /** complete a shallow clone: the history `clone --depth` left out */
    unshallow: async (b) => {
      const r = repoOf(b);
      const remote = b.remote === undefined || b.remote === null ? undefined : String(b.remote);
      if (remote !== undefined && (!/^[A-Za-z0-9._\/-]+$/.test(remote) || remote.startsWith('-'))) throw new HttpError(400, 'bad remote');
      return longOp(`Fetching the full history${remote ? ` from ${remote}` : ''}`, (p) => r.unshallow(remote, b.allBranches !== false, p), r.dir);
    },
    pull: async (b) => {
      const r = repoOf(b);
      const strategy = b.strategy === 'rebase' || b.strategy === 'ff' ? b.strategy : 'merge';
      const remote = b.remote ? remoteName(b.remote) : undefined;
      const branch = remote && b.branch ? refNames([b.branch])[0] : undefined;
      return longOp(`Pulling${branch ? ` ${remote}/${branch}` : ''} (${strategy})`, (p) => r.pull(strategy, p, { remote, branch, autostash: !!b.autostash, tags: !!b.tags }), r.dir);
    },
    push: async (b) => {
      const r = repoOf(b);
      const remote = b.remote ? remoteName(b.remote) : undefined;
      const branch = b.branch ? refNames([b.branch])[0] : undefined;
      const remoteBranch = b.remoteBranch ? refNames([b.remoteBranch])[0] : undefined;
      const to = remote && branch ? ` to ${remote}/${remoteBranch ?? branch}` : '';
      return longOp(`Pushing ${branch ?? 'current branch'}${to}`, (p) => r.push({ remote, branch, remoteBranch, force: !!b.force, tags: !!b.tags, setUpstream: !!b.setUpstream }, p), r.dir);
    },
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // only the Prong UI may call the engine: see origin.ts (no wildcard CORS, loopback Host only)
    const verdict = checkIncoming(req);
    if (!verdict.ok) {
      log(`refused ${req.method} ${url.pathname}: ${verdict.reason}`);
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `Forbidden: ${verdict.reason}` }));
      return;
    }
    if (verdict.allowOrigin) {
      res.setHeader('Access-Control-Allow-Origin', verdict.allowOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, range');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'content-range, content-length, accept-ranges');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? null));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const v = await runGit(['--version'], { cwd: homedir(), allowFail: true });
        // ui: 'static' when the engine serves the interface (desktop app), 'dev' behind a Metro dev server
        return json(200, { ok: true, git: v.stdout.trim(), version: '0.1.0', ui: WEB_DIR ? 'static' : 'dev', uiBuild: WEB_DIR && currentUiBuild(WEB_DIR) ? 'agent' : 'factory' });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/repos') return json(200, loadRepos());
      if (req.method === 'GET' && url.pathname === '/api/workspaces') return json(200, loadWorkspaces());
      if (req.method === 'GET' && url.pathname === '/api/session') return json(200, loadSession());
      if (req.method === 'GET' && url.pathname === '/api/settings') return json(200, loadSettings());
      if (req.method === 'GET' && url.pathname === '/api/ssh/keys') return json(200, await listSshKeys());
      if (req.method === 'GET' && url.pathname === '/api/accounts') return json(200, readState<any[]>('accounts.json', []));
      if (req.method === 'GET' && url.pathname === '/api/agent/check') return json(200, await checkClaude(loadSettings().agent.cliPath));
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/blob') {
        // a file at a revision (or the working copy), with byte ranges for <video>/<audio>
        const repo = expandHome(url.searchParams.get('repo') ?? '');
        const file = url.searchParams.get('file') ?? '';
        const rev = url.searchParams.get('rev') ?? WORKTREE;
        if (!repo || !Repo.isRepo(repo)) throw new HttpError(400, `Not a git repository: ${repo}`);
        if (!safeRelPath(file)) throw new HttpError(400, 'Bad path');
        const blob = await new Repo(repo).materializeBlob(rev, file);
        if (!blob) throw new HttpError(404, `${file} does not exist at ${rev}`);
        serveFile(req, res, blob.path, mimeOf(file));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/fileicon') {
        const icon = await systemFileIcon(url.searchParams.get('ext') ?? '');
        if (!icon) return json(404, { error: 'no system icon' });
        res.writeHead(200, { 'content-type': icon.mime, 'cache-control': 'private, max-age=604800', 'content-length': icon.data.length });
        res.end(icon.data);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/avatar') {
        if (!loadSettings().avatars) return json(404, { error: 'avatars disabled' });
        const a = await getAvatar(url.searchParams.get('email') ?? '');
        if (!a.data) return json(404, { error: 'no avatar' });
        res.writeHead(200, { 'content-type': a.mime, 'cache-control': 'private, max-age=86400', 'content-length': a.data.length });
        res.end(a.data);
        return;
      }
      const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' ? await readJson(req) : {};
      if (req.method === 'PUT' && url.pathname === '/api/session') {
        // tabs and branch filters for the next launch: a plain object of bounded size
        if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 512 * 1024) return json(400, { error: 'bad session' });
        saveSession(body);
        return json(200, { ok: true });
      }
      if (req.method === 'PUT' && url.pathname === '/api/workspaces') {
        saveWorkspaces(body as Workspace[]);
        const ids = new Set((body as Workspace[]).map((w) => w.id));
        saveRepos(loadRepos().map((r) => (r.workspaces?.some((w) => !ids.has(w)) ? { ...r, workspaces: r.workspaces.filter((w) => ids.has(w)) } : r)));
        return json(200, loadWorkspaces());
      }
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        // the tests' stand-in for Claude Code never becomes the agent of a real Prong (it answers without doing
        // anything); only an engine started for tests (PRONG_TEST_MODE) accepts it
        if (isTestAgent(body?.agent?.cliPath) && !process.env.PRONG_TEST_MODE) throw new HttpError(400, 'That is the test stand-in for Claude Code, not an agent. Leave the path empty to use the installed claude.');
        const cur = loadSettings();
        saveSettings({ ...cur, ...body, agent: { ...cur.agent, ...(body.agent ?? {}) }, ui: { ...cur.ui, ...(body.ui ?? {}) } });
        return json(200, loadSettings());
      }
      if (req.method === 'POST' && url.pathname === '/api/scan') {
        const root = expandHome(String(body.path ?? ''));
        const found = scanRepos(root, body.depth ?? 3);
        if (body.register) {
          // membership follows the scan: every entry under this root is in the scanning workspace iff the scan
          // found it; entries nobody scans any more and nobody opened or pinned are dropped
          const inRoot = (p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
          const ws = String(body.workspace ?? 'work');
          const top = new Set(found.filter((f) => !f.nested).map((f) => f.path));
          const list = loadRepos()
            .map((r) => {
              if (!inRoot(r.path)) return r;
              const set = new Set(r.workspaces ?? []);
              if (top.has(r.path)) set.add(ws);
              else set.delete(ws);
              return { ...r, workspaces: [...set] };
            })
            .filter((r) => !(inRoot(r.path) && !top.has(r.path) && (r.workspaces ?? []).length === 0 && !r.lastOpened && !r.pinned && !r.auth && (r.workspace === ws || !r.workspace)));
          const known = new Set(list.map((r) => r.path));
          const fresh = found.filter((f) => !known.has(f.path) && !f.nested).map((f) => ({ path: f.path, name: f.name, workspace: ws, workspaces: [ws], lastOpened: 0 }));
          saveRepos([...list, ...fresh]);
        }
        return json(200, found);
      }
      if (req.method === 'POST' && url.pathname === '/api/system/open') {
        await openWith(String(body.app ?? ''), expandHome(String(body.path ?? '')));
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/system/reveal') {
        await reveal(expandHome(String(body.path ?? '')));
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/system/terminal') {
        await openTerminal(String(body.app ?? loadSettings().terminal), expandHome(String(body.path ?? '')));
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/system/which') return json(200, { path: await which(String(body.bin ?? '')) });
      if (req.method === 'POST' && url.pathname === '/api/ssh/generate') return json(200, await generateSshKey(String(body.name), body.type ?? 'ed25519', String(body.passphrase ?? ''), String(body.comment ?? '')));
      if (req.method === 'POST' && url.pathname === '/api/ssh/agentAdd') {
        await addKeyToAgent(String(body.name), body.keychain !== false);
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/ssh/test') {
        const host = String(body.host ?? 'github.com');
        return json(200, longOp(`Testing ssh to ${host}`, async (p) => {
          const r = await testSsh(host, (l) => p(l, null));
          if (!r.ok) throw new Error(r.output || 'no greeting from the host');
        }));
      }
      if (url.pathname === '/api/accounts' && req.method === 'POST') {
        const host = String(body.host ?? 'github.com');
        const token = String(body.token ?? '');
        const info = await github.validateToken(host, token);
        const id = `${host}:${info.login}`;
        await setSecret(id, token);
        const list = readState<any[]>('accounts.json', []).filter((a) => a.id !== id);
        const entry = { id, host, login: info.login, name: info.name, avatar: info.avatar, orgs: info.orgs };
        writeJson('accounts.json', [...list, entry]);
        return json(200, entry);
      }
      if (url.pathname === '/api/accounts' && req.method === 'DELETE') {
        await deleteSecret(String(body.id));
        writeJson('accounts.json', readState<any[]>('accounts.json', []).filter((a) => a.id !== body.id));
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/github/')) {
        const op = url.pathname.slice('/api/github/'.length);
        const acc = readState<any[]>('accounts.json', []).find((a) => a.id === body.accountId);
        if (op === 'deviceStart') return json(200, await github.deviceStart(String(body.clientId || loadSettings().githubClientId), body.host));
        if (op === 'devicePoll') {
          const clientId = String(body.clientId || loadSettings().githubClientId);
          const r = await github.devicePoll(clientId, String(body.deviceCode), body.host);
          if (r.access_token) {
            const host = String(body.host ?? 'github.com');
            const info = await github.validateToken(host, r.access_token);
            const id = `${host}:${info.login}`;
            await setSecret(id, serializeStored(storedFrom(r, clientId, Date.now())));
            const entry = { id, host, login: info.login, name: info.name, avatar: info.avatar, orgs: info.orgs };
            writeJson('accounts.json', [...readState<any[]>('accounts.json', []).filter((a) => a.id !== id), entry]);
            return json(200, { done: true, account: entry });
          }
          return json(200, { done: false, error: r.error });
        }
        if (!acc) throw new HttpError(400, 'Unknown account');
        if (op === 'repos') return json(200, await asAccount(acc, (token) => github.listRepos(acc.host, token, body.page ?? 1)));
        if (op === 'addKey') return json(200, await asAccount(acc, (token) => github.addSshKey(acc.host, token, String(body.title), String(body.key))));
        throw new HttpError(404, `Unknown github op ${op}`);
      }
      // ---------- Prong's own sources: agent versions and the interface build ----------
      if (req.method === 'POST' && url.pathname.startsWith('/api/app/')) {
        const op = url.pathname.slice('/api/app/'.length);
        if (op === 'factory') {
          resetUiToFactory();
          emit({ opId: 'ui', label: 'Interface reset to factory', event: 'ui-updated', done: true });
          return json(200, { ok: true });
        }
        const sources = expandHome(String(body.sources ?? loadSettings().agent.sourcesPath ?? ''));
        if (!sources) throw new HttpError(400, 'No app sources folder configured');
        const app = new AppSources(sources);
        if (op === 'prepare') return json(200, { before: await app.prepare() });
        if (op === 'record') return json(200, await app.record(String(body.message ?? 'agent change'), body.before ?? {}));
        if (op === 'revert') return json(200, { sha: await app.revert(String(body.sha)) });
        if (op === 'versions') return json(200, await app.versions());
        if (op === 'rebuild') {
          if (!WEB_DIR) return json(200, { opId: null, skipped: 'the interface is served by a dev server, which reloads by itself' });
          return json(
            200,
            longOp('Rebuilding the interface', async (p, signal) => {
              await buildUi(app.dir, (l) => p(l, null), signal);
              // every open window reloads into the new build
              emit({ opId: 'ui', label: 'Interface rebuilt', event: 'ui-updated', done: true });
            }),
          );
        }
        throw new HttpError(404, `Unknown app op ${op}`);
      }
      if (req.method === 'POST' && url.pathname === '/api/ops/cancel') {
        const ctl = running.get(String(body.opId ?? ''));
        if (!ctl) return json(404, { error: 'No such running operation' });
        ctl.abort();
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/agent/run') {
        const settings = loadSettings();
        if (isTestAgent(settings.agent.cliPath) && !process.env.PRONG_TEST_MODE)
          throw new HttpError(400, 'The agent is set to the test stand-in (tools/fake-claude.sh), which does nothing. Clear the Claude Code path in Settings → Agent.');
        const cwd = expandHome(String(body.cwd ?? ''));
        if (!existsSync(cwd)) throw new HttpError(400, `No such directory: ${cwd}`);
        const result: { text: string } = { text: '' };
        const mode = body.mode === 'app' ? 'app' : 'repo';
        // in a repository the agent's git fetch / push / ls-remote sign in as Prong's do (its SSH key or account)
        const auth = mode === 'repo' && Repo.isRepo(cwd) && Repo.auth ? await Repo.auth(cwd) : null;
        const env = gitEnvOf(auth);
        const op = longOp(`Agent: ${String(body.prompt ?? '').slice(0, 40)}`, async (p, signal) => {
          const r = await runAgent({ prompt: String(body.prompt ?? ''), cwd, mode, model: body.model || settings.agent.model || undefined, cliPath: settings.agent.cliPath, apply: body.apply !== false, resume: body.resume ? String(body.resume) : undefined, env, connection: auth?.describe, signal, onEvent: (e) => p(`${e.type}:${e.text}`, null) });
          result.text = r.text;
          p(`result:${JSON.stringify({ text: r.text, costUsd: r.costUsd, sessionId: r.sessionId })}`, 1);
        });
        return json(200, op);
      }
      if (req.method === 'POST' && url.pathname === '/api/repos/open') {
        const p = expandHome(String(body.path ?? ''));
        if (!Repo.isRepo(p)) throw new HttpError(400, `Not a git repository: ${p}`);
        const prev = loadRepos().find((r) => r.path === p);
        const list = loadRepos().filter((r) => r.path !== p);
        const entry: KnownRepo = { ...(prev ?? {}), path: p, name: path.basename(p), workspace: body.workspace ?? prev?.workspace ?? 'work', lastOpened: Date.now() };
        saveRepos([entry, ...list]);
        return json(200, entry);
      }
      if (req.method === 'POST' && url.pathname === '/api/repos/move') {
        const p = expandHome(String(body.path ?? ''));
        const ws = String(body.workspace ?? 'work');
        saveRepos(loadRepos().map((r) => (r.path === p ? { ...r, workspace: ws } : r)));
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/repos/forget') {
        const p = expandHome(String(body.path ?? ''));
        saveRepos(loadRepos().filter((r) => r.path !== p));
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/repos/init') {
        const p = expandHome(String(body.path ?? ''));
        mkdirSync(p, { recursive: true });
        await Repo.init(p);
        return json(200, { path: p });
      }
      if (req.method === 'POST' && url.pathname === '/api/repos/clone') {
        const dir = expandHome(String(body.dir ?? ''));
        const name = String(body.name ?? path.basename(String(body.url)).replace(/\.git$/, ''));
        const dest = path.join(dir, name);
        if (existsSync(dest)) throw new HttpError(400, `Already exists: ${dest}`);
        const op = longOp(`Cloning ${name}`, async (p) => {
          await Repo.clone(String(body.url), dest, !!body.recursive, p);
          const list = loadRepos().filter((r) => r.path !== dest);
          saveRepos([{ path: dest, name, workspace: body.workspace ?? 'work', lastOpened: Date.now() }, ...list]);
        });
        return json(200, { ...op, path: dest });
      }
      if (req.method === 'GET' && url.pathname === '/api/queue') return json(200, allQueues());
      if (req.method === 'POST' && url.pathname === '/api/queue/cancel') return json(200, { cancelled: cancelQueued(Number(body.id)) });
      const m = url.pathname.match(/^\/api\/repo\/(\w+)$/);
      if (req.method === 'POST' && m) {
        const op = OPS[m[1]];
        if (!op) throw new HttpError(404, `Unknown op ${m[1]}`);
        // whatever changes the repository waits its turn (and for other git processes' lock files)
        const queued = !UNQUEUED.has(m[1]);
        const result = queued ? await queueFor(repoOf(body).dir).run(opLabel(m[1], body), () => op(body)) : await op(body);
        return json(200, result === undefined ? { ok: true } : result);
      }
      if (req.method === 'GET' && WEB_DIR && !url.pathname.startsWith('/api/')) {
        // the agent's latest interface build when there is one, the factory build otherwise
        const web = currentUiBuild(WEB_DIR) ?? WEB_DIR;
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        let file = path.resolve(web, rel || 'index.html');
        if (!file.startsWith(web)) throw new HttpError(403, 'Forbidden');
        if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(web, 'index.html');
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        createReadStream(file).pipe(res);
        return;
      }
      throw new HttpError(404, 'Not found');
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      log(`${req.method} ${url.pathname} → ${status}: ${err?.message}`);
      json(status, { error: err?.message ?? String(err) });
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  return { server, emit, OPS };
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
