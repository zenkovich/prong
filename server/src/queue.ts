import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { runGit } from './git/run.js';
import type { QueueItem } from './types.js';

export type { QueueItem };

/**
 * One queue of actions per repository: whatever changes it (stage, commit, checkout, pull, …) runs one at a time,
 * in the order asked. Before an action runs, and again when git fails on a lock, it waits until no other git
 * process holds the repository's lock files (index.lock and friends), then (re)runs.
 */

/** the lock files git takes for the changes Prong makes */
export const LOCK_FILES = ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock'];
/** git's words for "someone else holds a lock" */
export const isLockError = (e: unknown) => /\.lock': File exists|Another git process seems to be running|cannot lock ref|Unable to create '[^']*\.lock'/i.test(String((e as Error)?.message ?? e));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

interface Job extends QueueItem {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  cancelled?: boolean;
}

export class RepoQueue {
  private jobs: Job[] = [];
  private busy = false;
  private gitDir: string | null = null;
  /** how long a lock is waited for before the action gives up (a lock left by a crash never goes away) */
  static maxWaitMs = 30 * 60 * 1000;
  static pollMs = 200;

  constructor(
    public readonly dir: string,
    private onChange: (items: QueueItem[]) => void,
  ) {}

  get items(): QueueItem[] {
    return this.jobs.map(({ id, label, state, since, lock, lockSince }) => ({ id, label, state, since, lock, lockSince }));
  }

  run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ id: ++seq, label, state: 'queued', since: Date.now(), fn, resolve: resolve as (v: unknown) => void, reject });
      this.changed();
      void this.pump();
    });
  }

  /** a queued or lock-waiting action is dropped (a running one finishes) */
  cancel(id: number) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || j.state === 'running') return false;
    j.cancelled = true;
    if (j.state === 'queued') {
      this.jobs = this.jobs.filter((x) => x !== j);
      j.reject(new Error('Cancelled'));
      this.changed();
    }
    return true;
  }

  private changed() {
    this.onChange(this.items);
  }

  private async lockPaths() {
    if (!this.gitDir) {
      const r = await runGit(['rev-parse', '--absolute-git-dir'], { cwd: this.dir, allowFail: true });
      this.gitDir = r.code === 0 ? r.stdout.trim() : path.join(this.dir, '.git');
    }
    return LOCK_FILES.map((f) => path.join(this.gitDir!, f));
  }

  /** until none of the lock files exists; the job shows which one it waits for */
  private async waitForLocks(job: Job) {
    const locks = await this.lockPaths();
    const started = Date.now();
    for (;;) {
      if (job.cancelled) throw new Error('Cancelled');
      const held = locks.find((p) => existsSync(p));
      if (!held) return;
      let mtime = 0;
      try {
        mtime = statSync(held).mtimeMs;
      } catch {
        continue; // gone in between
      }
      if (job.state !== 'waiting-lock' || job.lock !== held) {
        job.state = 'waiting-lock';
        job.lock = held;
        job.lockSince = mtime;
        this.changed();
      } else if (job.lockSince !== mtime) {
        job.lockSince = mtime;
        this.changed();
      }
      if (Date.now() - started > RepoQueue.maxWaitMs) throw new Error(`${path.basename(held)} was not released for ${Math.round(RepoQueue.maxWaitMs / 60000)} min: if no git process is running, it was left by a crash; delete it and try again`);
      await sleep(RepoQueue.pollMs);
    }
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs[0];
        try {
          let result: unknown;
          for (let attempt = 0; ; attempt++) {
            await this.waitForLocks(job);
            job.state = 'running';
            job.lock = undefined;
            this.changed();
            try {
              result = await job.fn();
              break;
            } catch (e) {
              // another git process took the lock between our check and git's: wait for it and go again
              if (isLockError(e) && attempt < 10 && !job.cancelled) {
                await sleep(RepoQueue.pollMs);
                continue;
              }
              throw e;
            }
          }
          job.resolve(result);
        } catch (e) {
          job.reject(e);
        } finally {
          this.jobs.shift();
          this.changed();
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

const queues = new Map<string, RepoQueue>();
let listener: (dir: string, items: QueueItem[]) => void = () => {};
export function onQueueChange(fn: (dir: string, items: QueueItem[]) => void) {
  listener = fn;
}
export function queueFor(dir: string): RepoQueue {
  let q = queues.get(dir);
  if (!q) queues.set(dir, (q = new RepoQueue(dir, (items) => listener(dir, items))));
  return q;
}
/** every repository's queue that has something in it (for a client that connects while actions wait) */
export function allQueues(): Record<string, QueueItem[]> {
  const out: Record<string, QueueItem[]> = {};
  for (const [dir, q] of queues) if (q.items.length) out[dir] = q.items;
  return out;
}
export function cancelQueued(id: number) {
  for (const q of queues.values()) if (q.cancel(id)) return true;
  return false;
}
