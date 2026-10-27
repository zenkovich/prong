import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The stop signal of the long operation (fetch, pull, push, clone, submodule update…) whose work is running: every
 * git it starts is killed when the user stops it. Set by the API around the operation's work (`withStop`), so the
 * repository methods need no parameter for it.
 */
const stopSignal = new AsyncLocalStorage<AbortSignal>();
export const withStop = <T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> => stopSignal.run(signal, fn);
/** what a stopped git rejects with */
export class StoppedError extends Error {
  constructor() {
    super('Stopped');
  }
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  /** called for every line written to stderr (git progress uses \r-separated updates) */
  onLine?: (line: string) => void;
  input?: string;
  /** resolve instead of throwing on a non-zero exit code */
  allowFail?: boolean;
  timeoutMs?: number;
  /** keep stdout as raw bytes (blobs such as images); `stdout` is then empty and `raw` holds the data */
  binary?: boolean;
  /**
   * Stop reading after this many bytes of stdout: git is killed and the result is marked `truncated`
   * (a merge can produce a patch of a gigabyte, more than a JS string can hold).
   */
  maxBytes?: number;
  /** git is killed when this aborts (default: the running long operation's stop signal, see withStop) */
  signal?: AbortSignal;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  raw?: Buffer;
  /** stdout was cut at `maxBytes` */
  truncated?: boolean;
}

/** git's progress lines ("Receiving objects:  38% (700/1842)"), redrawn hundreds of times: they bury the error */
const PROGRESS_LINE = /\b\d{1,3}% \(\d+\/\d+\)/;
export function withoutProgress(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() && !PROGRESS_LINE.test(l))
    .join('\n');
}

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly code: number,
    public readonly stderr: string,
    public readonly stdout: string,
  ) {
    // what git said on both streams: a failed pull or merge reports its conflicts on stdout, while stderr is mostly
    // progress (which used to be the whole message — the conflict itself was left out)
    const err = withoutProgress(stderr).trim();
    const out = stdout.trim();
    super(`git ${args.join(' ')} failed (${code}): ${[err, out.length > 4000 ? `${out.slice(0, 4000)}…` : out].filter(Boolean).join('\n')}`);
  }
}

export const GIT_BIN = process.env.PRONG_GIT ?? 'git';

/**
 * Paths in runs that each fit one command line: a folder picked in Changes can hold thousands of files, and
 * macOS refuses a command over about 1 MB (the environment included).
 */
export function inRuns(paths: string[], budget = 96 * 1024): string[][] {
  const out: string[][] = [];
  let run: string[] = [];
  let bytes = 0;
  for (const p of paths) {
    const n = Buffer.byteLength(p) + 1;
    if (run.length && bytes + n > budget) {
      out.push(run);
      run = [];
      bytes = 0;
    }
    run.push(p);
    bytes += n;
  }
  if (run.length) out.push(run);
  return out;
}

/** Non-interactive git environment: no editors, no prompts, English output, progress on stderr. */
function baseEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_PAGER: 'cat',
    ...extra,
  };
}

/**
 * Paths as they are: by default git writes a name with non-ASCII letters ("файл.txt", "фото.png") in quotes with octal
 * escapes in diffs and --raw lists, which the parsers do not read (a Cyrillic file came out as `"a/\321\204…"`,
 * an image as a binary). Errors still name the command as it was asked.
 */
const PLAIN_PATHS = ['-c', 'core.quotepath=false'];

export function runGit(args: string[], opts: RunOptions): Promise<RunResult> {
  const signal = opts.signal ?? stopSignal.getStore();
  if (signal?.aborted) return Promise.reject(new StoppedError());
  return new Promise((resolve, reject) => {
    const child = spawn(GIT_BIN, [...PLAIN_PATHS, ...args], { cwd: opts.cwd, env: baseEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
    // stopped by the user: git goes at once, and so does the wait for it (a helper it started, such as ssh or
    // upload-pack, may hold the pipes a while longer)
    let stopped = false;
    const onStop = () => {
      stopped = true;
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onStop, { once: true });
    child.on('exit', () => {
      if (stopped) reject(new StoppedError());
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let pending = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : null;
    let bytes = 0;
    let truncated = false;
    child.stdout.on('data', (b: Buffer) => {
      if (truncated) return;
      if (opts.maxBytes !== undefined && bytes + b.length > opts.maxBytes) {
        out.push(b.subarray(0, opts.maxBytes - bytes));
        bytes = opts.maxBytes;
        truncated = true;
        child.kill('SIGTERM');
        return;
      }
      bytes += b.length;
      out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      err.push(b);
      if (opts.onLine) {
        pending += b.toString('utf8');
        const parts = pending.split(/\r\n|\r|\n/);
        pending = parts.pop() ?? '';
        for (const p of parts) if (p.trim()) opts.onLine(p);
      }
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onStop);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onStop);
      if (stopped) return reject(new StoppedError());
      if (opts.onLine && pending.trim()) opts.onLine(pending);
      const raw = Buffer.concat(out);
      const result: RunResult = { code: code ?? -1, stdout: opts.binary ? '' : raw.toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
      if (opts.binary) result.raw = raw;
      if (truncated) {
        // killed on purpose: whatever git wrote so far is the answer
        result.truncated = true;
        result.code = 0;
      }
      if (result.code !== 0 && !opts.allowFail) reject(new GitError(args, result.code, result.stderr, result.stdout));
      else resolve(result);
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/**
 * Read git's stdout line by line; `onLine` returns false to stop early (git is killed then).
 * Resolves with the number of lines read.
 */
export function runGitLines(args: string[], opts: Pick<RunOptions, 'cwd' | 'env'>, onLine: (line: string) => boolean | void, sep = '\n'): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT_BIN, [...PLAIN_PATHS, ...args], { cwd: opts.cwd, env: baseEnv(opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    let count = 0;
    let stopped = false;
    let err = '';
    child.stdout.on('data', (b: Buffer) => {
      if (stopped) return;
      pending += b.toString('utf8');
      const parts = pending.split(sep);
      pending = parts.pop() ?? '';
      for (const p of parts) {
        count++;
        if (onLine(p) === false) {
          stopped = true;
          child.kill('SIGTERM');
          return;
        }
      }
    });
    child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (!stopped && pending.trim()) {
        count++;
        onLine(pending);
      }
      if (!stopped && code !== 0) reject(new GitError(args, code ?? -1, err, ''));
      else resolve(count);
    });
  });
}

/** Parse "Receiving objects:  38% (700/1842)" style progress lines into 0..1 (null when not a progress line). */
export function progressOf(line: string): number | null {
  const m = line.match(/(\d{1,3})%/);
  if (!m) return null;
  const pct = Math.min(100, parseInt(m[1], 10)) / 100;
  // weight phases so the bar does not jump back to 0 on each phase
  if (/Counting objects/i.test(line)) return pct * 0.1;
  if (/Compressing objects/i.test(line)) return 0.1 + pct * 0.2;
  if (/Receiving objects|Writing objects/i.test(line)) return 0.3 + pct * 0.5;
  if (/Resolving deltas/i.test(line)) return 0.8 + pct * 0.15;
  if (/Updating files|Checking out/i.test(line)) return 0.95 + pct * 0.05;
  return pct;
}
