import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { checkRequest, extraOrigins } from '../src/origin.js';

describe('origin policy', () => {
  it('accepts the engine itself, the dev servers and configured origins only', () => {
    expect(checkRequest({ host: '127.0.0.1:8790', origin: 'http://127.0.0.1:8790' })).toEqual({ ok: true, allowOrigin: undefined });
    expect(checkRequest({ host: '127.0.0.1:8790', origin: 'http://localhost:8099' })).toEqual({ ok: true, allowOrigin: 'http://localhost:8099' });
    expect(checkRequest({ host: '127.0.0.1:8790', origin: 'https://evil.example' }).ok).toBe(false);
    expect(checkRequest({ host: '127.0.0.1:8790', origin: 'null' }).ok).toBe(false);
    expect(checkRequest({ host: '127.0.0.1:8790', origin: 'http://tools.local:3000' }, ['http://tools.local:3000']).ok).toBe(true);
    expect(extraOrigins(' http://a:1/, http://b:2 ')).toEqual(['http://a:1', 'http://b:2']);
  });
  it('refuses non-loopback Host headers (DNS rebinding)', () => {
    expect(checkRequest({ host: 'evil.example:8790', origin: 'http://evil.example:8790' }).ok).toBe(false);
    expect(checkRequest({ host: 'evil.example:8790' }).ok).toBe(false);
    expect(checkRequest({ host: 'localhost:8790' }).ok).toBe(true);
    expect(checkRequest({ host: '[::1]:8790' }).ok).toBe(true);
  });
  it('lets plain clients through and blocks cross-site embeds without an allowed referer', () => {
    expect(checkRequest({ host: '127.0.0.1:8790' }).ok).toBe(true);
    expect(checkRequest({ host: '127.0.0.1:8790', secFetchSite: 'same-origin' }).ok).toBe(true);
    expect(checkRequest({ host: '127.0.0.1:8790', secFetchSite: 'cross-site', referer: 'https://evil.example/page' }).ok).toBe(false);
    expect(checkRequest({ host: '127.0.0.1:8790', secFetchSite: 'cross-site', referer: 'http://localhost:8099/' }).ok).toBe(true);
    expect(checkRequest({ host: '127.0.0.1:8790', secFetchSite: 'cross-site' }).ok).toBe(false);
  });
});

describe('origin policy over HTTP', () => {
  let root: string;
  let port: number;
  let close: () => void;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-origin-'));
    process.env.PRONG_STATE_DIR = path.join(root, 'state');
    const { server } = createApi();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    close = () => server.close();
  });
  afterAll(() => {
    close();
    rmSync(root, { recursive: true, force: true });
  });
  // raw requests: fetch() would not let us set Host / Origin freely
  const raw = (method: string, p: string, headers: Record<string, string>, body?: string) =>
    new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

  it('a foreign page cannot write settings, even with a "simple" text/plain POST', async () => {
    const r = await raw('PUT', '/api/settings', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'content-type': 'text/plain' }, JSON.stringify({ editor: 'pwned' }));
    expect(r.status).toBe(403);
    const s = await raw('GET', '/api/settings', { host: `127.0.0.1:${port}` });
    expect(JSON.parse(s.body).editor).not.toBe('pwned');
    const pre = await raw('OPTIONS', '/api/agent/run', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'access-control-request-method': 'POST' });
    expect(pre.status).toBe(403);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('the dev UI origin gets an exact CORS echo, never a wildcard', async () => {
    const r = await raw('GET', '/api/health', { host: `127.0.0.1:${port}`, origin: 'http://localhost:8099' });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:8099');
    const self = await raw('GET', '/api/health', { host: `127.0.0.1:${port}` });
    expect(self.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('a rebinding Host is refused', async () => {
    const r = await raw('GET', '/api/health', { host: `attacker.example:${port}` });
    expect(r.status).toBe(403);
  });
});
