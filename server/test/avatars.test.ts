import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { avatarUrls, getAvatar, hashEmail, type Fetcher } from '../src/avatars.js';

describe('avatars', () => {
  let dir: string;
  let prev: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'prong-av-'));
    prev = process.env.PRONG_STATE_DIR;
    process.env.PRONG_STATE_DIR = dir;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.PRONG_STATE_DIR;
    else process.env.PRONG_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashes e-mails the Gravatar way (trimmed, lower-case md5)', () => {
    expect(hashEmail('  Test@Example.com ')).toBe('55502f40dc8b7c769880b10874abc9d0');
  });

  it('picks GitHub for noreply addresses and Gravatar (d=404) otherwise', () => {
    expect(avatarUrls('123456+octo-cat@users.noreply.github.com')).toEqual(['https://avatars.githubusercontent.com/u/123456?s=64']);
    expect(avatarUrls('octocat@users.noreply.github.com')).toEqual(['https://github.com/octocat.png?size=64']);
    expect(avatarUrls('Test@Example.com')).toEqual(['https://www.gravatar.com/avatar/55502f40dc8b7c769880b10874abc9d0?s=64&d=404']);
  });

  it('caches hits as png files and misses as markers, and never fetches twice', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return url.includes('gravatar') ? { ok: true, status: 200, mime: 'image/png', data: Buffer.from([1, 2, 3]) } : { ok: false, status: 404, mime: 'text/html', data: Buffer.alloc(0) };
    };
    const hit = await getAvatar('someone@example.com', fetcher);
    expect([...hit.data!]).toEqual([1, 2, 3]);
    expect(existsSync(path.join(dir, 'avatars', `${hashEmail('someone@example.com')}.png`))).toBe(true);
    const again = await getAvatar('Someone@Example.com', fetcher);
    expect([...again.data!]).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);

    const miss = await getAvatar('nobody@users.noreply.github.com', fetcher);
    expect(miss.data).toBeNull();
    expect(existsSync(path.join(dir, 'avatars', `${hashEmail('nobody@users.noreply.github.com')}.none`))).toBe(true);
    await getAvatar('nobody@users.noreply.github.com', fetcher);
    expect(calls).toHaveLength(2);
  });

  it('ignores addresses without an @ and network failures', async () => {
    const boom: Fetcher = async () => {
      throw new Error('offline');
    };
    expect((await getAvatar('not an email', boom)).data).toBeNull();
    expect((await getAvatar('x@offline.example', boom)).data).toBeNull();
  });

  it('dedupes concurrent requests for the same address', async () => {
    let n = 0;
    const slow: Fetcher = async () => {
      n++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, status: 200, mime: 'image/png', data: Buffer.from([9]) };
    };
    const [a, b] = await Promise.all([getAvatar('dup@example.com', slow), getAvatar('dup@example.com', slow)]);
    expect(n).toBe(1);
    expect([...a.data!]).toEqual([9]);
    expect([...b.data!]).toEqual([9]);
  });
});
