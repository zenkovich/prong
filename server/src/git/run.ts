import { spawn } from 'node:child_process';

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
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  raw?: Buffer;
  /** stdout was cut at `maxBytes` */
  truncated?: boolean;
}

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly code: number,
    public readonly stderr: string,
    public readonly stdout: string,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
}

export const GIT_BIN = process.env.PRONG_GIT ?? 'git';

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

export function runGit(args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT_BIN, args, { cwd: opts.cwd, env: baseEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
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
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
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
    const child = spawn(GIT_BIN, args, { cwd: opts.cwd, env: baseEnv(opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
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
