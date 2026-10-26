import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './state.js';

/**
 * Author avatars: GitHub for noreply addresses (`123456+login@users.noreply.github.com`), Gravatar for
 * everything else (`d=404` so unknown addresses yield nothing instead of a generated image).
 * Results are cached on disk under ~/.prong/avatars: `<md5>.png` for hits, `<md5>.none` for misses
 * (misses are retried after NONE_TTL). At most CONCURRENCY downloads run at once.
 */

const NONE_TTL = 7 * 24 * 3600 * 1000;
const CONCURRENCY = 4;
const SIZE = 64;

export interface AvatarResult {
  /** image bytes, or null when no avatar is known */
  data: Buffer | null;
  mime: string;
}

export const hashEmail = (email: string) => createHash('md5').update(email.trim().toLowerCase()).digest('hex');

export function avatarUrls(email: string): string[] {
  const e = email.trim().toLowerCase();
  const gh = e.match(/^(?:(\d+)\+)?([a-z0-9-]+)@users\.noreply\.github\.com$/);
  if (gh) return [gh[1] ? `https://avatars.githubusercontent.com/u/${gh[1]}?s=${SIZE}` : `https://github.com/${gh[2]}.png?size=${SIZE}`];
  return [`https://www.gravatar.com/avatar/${hashEmail(e)}?s=${SIZE}&d=404`];
}

let active = 0;
const queue: (() => void)[] = [];
const inflight = new Map<string, Promise<AvatarResult>>();
const slot = () => new Promise<void>((r) => (active < CONCURRENCY ? (active++, r()) : queue.push(() => (active++, r()))));
const release = () => {
  active--;
  queue.shift()?.();
};

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; mime: string; data: Buffer }>;
const defaultFetch: Fetcher = async (url) => {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
  return { ok: r.ok, status: r.status, mime: r.headers.get('content-type') ?? 'image/png', data: Buffer.from(await r.arrayBuffer()) };
};

export async function getAvatar(email: string, fetcher: Fetcher = defaultFetch): Promise<AvatarResult> {
  const e = email.trim().toLowerCase();
  if (!e || !e.includes('@')) return { data: null, mime: 'image/png' };
  const key = hashEmail(e);
  const dir = path.join(STATE_DIR(), 'avatars');
  const hit = path.join(dir, `${key}.png`);
  const miss = path.join(dir, `${key}.none`);
  if (existsSync(hit)) return { data: readFileSync(hit), mime: 'image/png' };
  try {
    if (existsSync(miss) && Date.now() - statSync(miss).mtimeMs < NONE_TTL) return { data: null, mime: 'image/png' };
  } catch {
    /* ignore */
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = (async () => {
    await slot();
    try {
      for (const url of avatarUrls(e)) {
        try {
          const r = await fetcher(url);
          if (r.ok && r.data.length > 0 && r.mime.startsWith('image/')) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(hit, r.data);
            return { data: r.data, mime: r.mime };
          }
        } catch {
          /* next source */
        }
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(miss, '');
      return { data: null, mime: 'image/png' };
    } finally {
      release();
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}
