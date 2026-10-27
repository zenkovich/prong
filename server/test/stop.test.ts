import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { runGit, StoppedError, withStop } from '../src/git/run.js';
import { RepoQueue } from '../src/queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop in the status panel: a fetch, pull or push (any long operation) really stops — git is killed — and one still
 * waiting for its turn or for another git's lock leaves the queue. The stop used to only flip a flag: git went on
 * to the end (a 20-minute fetch of a game repository) and the operation then said "done".
 */
describe('stopping a long operation', () => {
  let root: string;
  let dir: string;
  let origin: string;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  beforeAll(() => {
    RepoQueue.pollMs = 30;
    root = mkdtempSync(path.join(tmpdir(), 'prong-stop-'));
    origin = path.join(root, 'origin.git');
    dir = path.join(root, 'r');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'a');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    // a server that takes its time: the fetch hangs for half a minute before anything arrives
    git(dir, 'config', 'remote.origin.uploadpack', 'sleep 30; git-upload-pack');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a git started under a stop signal is killed when it fires, at once', async () => {
    const ctl = new AbortController();
    const started = Date.now();
    const run = withStop(ctl.signal, () => runGit(['-c', 'alias.wait=!sleep 30', 'wait'], { cwd: dir, allowFail: true }));
    await sleep(150);
    ctl.abort();
    await expect(run).rejects.toBeInstanceOf(StoppedError);
    expect(Date.now() - started).toBeLessThan(5000);
    // once stopped, the operation starts no more git (allowFail or not)
    await expect(withStop(ctl.signal, () => runGit(['status'], { cwd: dir, allowFail: true }))).rejects.toThrow('Stopped');
  });

  it('through the API: Stop ends a hanging fetch with "Stopped"; a push waiting for index.lock leaves the queue', async () => {
    process.env.PRONG_STATE_DIR = path.join(root, 'state');
    mkdirSync(process.env.PRONG_STATE_DIR, { recursive: true });
    const { server } = createApi();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (p: string, body: unknown) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const events: any[] = [];
    const ctl = new AbortController();
    try {
      const sse = await fetch(base + '/api/events', { signal: ctl.signal });
      const reader = sse.body!.getReader();
      void (async () => {
        const dec = new TextDecoder();
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let k;
            while ((k = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, k);
              buf = buf.slice(k + 2);
              if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
            }
          }
        } catch {
          /* aborted */
        }
      })();
      const doneOf = (opId: string) => events.find((e) => e.opId === opId && e.done);
      const waitDone = async (opId: string, ms: number) => {
        for (let t = 0; t < ms && !doneOf(opId); t += 50) await sleep(50);
        return doneOf(opId);
      };

      const { opId } = await post('/api/repo/fetch', { path: dir, remote: 'origin' });
      await sleep(500);
      expect(doneOf(opId)).toBeUndefined();
      const started = Date.now();
      expect(await post('/api/ops/cancel', { opId })).toEqual({ ok: true });
      expect((await waitDone(opId, 5000))?.error).toBe('Stopped');
      expect(Date.now() - started).toBeLessThan(5000);

      // another git holds index.lock: the push waits in the queue; Stop takes it out, it never runs
      const lock = path.join(dir, '.git/index.lock');
      writeFileSync(lock, '');
      try {
        const push = await post('/api/repo/push', { path: dir, remote: 'origin', branch: 'main' });
        for (let t = 0; t < 3000 && !events.some((e) => e.event === 'queue' && e.items?.[0]?.state === 'waiting-lock'); t += 50) await sleep(50);
        expect(await post('/api/ops/cancel', { opId: push.opId })).toEqual({ ok: true });
        expect((await waitDone(push.opId, 3000))?.error).toBe('Stopped');
        expect(events.filter((e) => e.event === 'queue').at(-1)?.items).toEqual([]);
      } finally {
        unlinkSync(lock);
      }
    } finally {
      ctl.abort();
      server.close();
    }
  });
});

describe('git errors', () => {
  it('say what git said on both streams, without its progress lines', async () => {
    const { GitError } = await import('../src/git/run.js');
    const stderr = 'remote: Counting objects:  20% (1/5)\rremote: Counting objects: 100% (5/5), done.\r\nReceiving objects:  50% (2/4)\rReceiving objects: 100% (4/4), done.\nFrom /srv/game\n   58e2eb7..cf0c040  main       -> origin/main\n';
    const stdout = 'Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n';
    const e = new GitError(['pull', '--no-rebase'], 1, stderr, stdout);
    // the conflict used to be left out (stderr won), and the progress filled the error window
    expect(e.message).toContain('CONFLICT (content): Merge conflict in a.txt');
    expect(e.message).toContain('From /srv/game');
    expect(e.message).not.toMatch(/Counting objects|Receiving objects/);
    expect(new GitError(['checkout', 'x'], 1, 'error: pathspec x did not match\n', '').message).toBe('git checkout x failed (1): error: pathspec x did not match');
  });
});
