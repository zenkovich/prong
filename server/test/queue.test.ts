import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { Repo } from '../src/git/repo.js';
import { isLockError, QueueItem, RepoQueue } from '../src/queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The action queue: one action at a time per repository, and a wait while another git process holds a lock. */
describe('repository action queue', () => {
  let root: string;
  let dir: string;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const lock = () => path.join(dir, '.git/index.lock');
  beforeAll(() => {
    RepoQueue.pollMs = 30;
    root = mkdtempSync(path.join(tmpdir(), 'prong-queue-'));
    dir = path.join(root, 'r');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-qm', 'a');
  });
  // a failed test must not leave its lock to stall the next one
  afterEach(() => rmSync(lock(), { force: true }));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('runs actions one at a time, in the order asked', async () => {
    const seen: string[] = [];
    const q = new RepoQueue(dir, () => {});
    const a = q.run('a', async () => {
      seen.push('a+');
      await sleep(60);
      seen.push('a-');
      return 1;
    });
    const b = q.run('b', async () => {
      seen.push('b+');
      return 2;
    });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(seen).toEqual(['a+', 'a-', 'b+']);
  });

  it('waits while another git process holds index.lock, then runs; the queue shows what it waits for', async () => {
    writeFileSync(lock(), '');
    const states: QueueItem[][] = [];
    const q = new RepoQueue(dir, (items) => states.push(items));
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    let done = false;
    const job = q.run('Stage b.txt', () => new Repo(dir).stage(['b.txt'])).then(() => (done = true));
    await sleep(200);
    expect(done).toBe(false);
    expect(q.items[0]).toMatchObject({ label: 'Stage b.txt', state: 'waiting-lock' });
    expect(q.items[0].lock).toMatch(/\.git\/index\.lock$/);
    unlinkSync(lock());
    await job;
    expect(done).toBe(true);
    expect(git('diff', '--cached', '--name-only')).toBe('b.txt');
    expect(states.some((s) => s[0]?.state === 'running')).toBe(true);
    expect(states.at(-1)).toEqual([]);
  });

  it('a lock taken between the check and git is waited for and the action goes again', async () => {
    const q = new RepoQueue(dir, () => {});
    let attempts = 0;
    const r = await q.run('flaky', async () => {
      attempts++;
      if (attempts === 1) throw new Error("fatal: Unable to create '/x/.git/index.lock': File exists.");
      return 'ok';
    });
    expect(r).toBe('ok');
    expect(attempts).toBe(2);
    expect(isLockError(new Error('Another git process seems to be running in this repository'))).toBe(true);
    expect(isLockError(new Error('pathspec did not match'))).toBe(false);
  });

  it('a queued action can be cancelled; a waiting one too', async () => {
    writeFileSync(lock(), '');
    const q = new RepoQueue(dir, () => {});
    const first = q.run('first', async () => 'first');
    const second = q.run('second', async () => 'second');
    await sleep(80);
    expect(q.items.map((i) => i.state)).toEqual(['waiting-lock', 'queued']);
    expect(q.cancel(q.items[1].id)).toBe(true);
    await expect(second).rejects.toThrow('Cancelled');
    expect(q.cancel(q.items[0].id)).toBe(true);
    await expect(first).rejects.toThrow('Cancelled');
    unlinkSync(lock());
  });

  it('through the API: an operation blocked by a lock finishes after it is released; a fresh lock is not deleted, an old one is', async () => {
    process.env.PRONG_STATE_DIR = path.join(root, 'state');
    const { server } = createApi();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      // the queue's events
      const events: any[] = [];
      const ctl = new AbortController();
      const sse = await fetch(base + '/api/events', { signal: ctl.signal });
      const reader = sse.body!.getReader();
      void (async () => {
        const dec = new TextDecoder();
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value);
            for (const part of buf.split('\n\n').slice(0, -1)) if (part.startsWith('data: ')) events.push(JSON.parse(part.slice(6)));
            buf = buf.split('\n\n').pop()!;
          }
        } catch {
          /* aborted */
        }
      })();
      writeFileSync(lock(), '');
      writeFileSync(path.join(dir, 'c.txt'), 'c\n');
      let answered = false;
      const staging = post('/api/repo/stage', { path: dir, paths: ['c.txt'] }).then((r) => {
        answered = true;
        return r;
      });
      await sleep(300);
      expect(answered).toBe(false);
      expect(events.some((e) => e.event === 'queue' && e.items?.[0]?.state === 'waiting-lock')).toBe(true);
      // a lock that just changed is somebody's work in progress
      expect((await post('/api/repo/removeLock', { path: dir, lock: 'index.lock' })).status).toBe(409);
      // one left for minutes: removed, and the waiting action runs
      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(lock(), old, old);
      expect(await (await post('/api/repo/removeLock', { path: dir, lock: 'index.lock' })).json()).toEqual({ removed: true });
      expect(existsSync(lock())).toBe(false);
      expect((await staging).status).toBe(200);
      expect(git('diff', '--cached', '--name-only').split('\n')).toContain('c.txt');
      expect((await post('/api/repo/removeLock', { path: dir, lock: '../../etc/passwd' })).status).toBe(400);
      ctl.abort();
    } finally {
      server.close();
    }
  });
});
