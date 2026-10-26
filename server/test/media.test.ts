import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { kindOf, parseDiff } from '../src/git/parse.js';
import { mimeOf, safeRelPath, WORKTREE } from '../src/git/repo.js';
import { parseRange } from '../src/http-file.js';
import { makeFixtureRepo } from './fixture.js';

const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PNG_B = Buffer.from(PNG_A);
PNG_B[PNG_B.length - 20] ^= 0xff;
// bytes that are not valid UTF-8: a lossy text decode anywhere in the path would change them
const AUDIO = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80, 0x81]), Buffer.alloc(4000, 0xa5)]);

describe('content kinds', () => {
  it('classifies images, audio and video by extension; .ts stays text', () => {
    expect(kindOf('a/b.PNG')).toBe('image');
    expect(kindOf('s/x.mp3')).toBe('audio');
    expect(kindOf('s/x.flac')).toBe('audio');
    expect(kindOf('v/x.mov')).toBe('video');
    expect(kindOf('v/x.webm')).toBe('video');
    expect(kindOf('src/x.ts')).toBe('text');
    expect(kindOf('Makefile')).toBe('text');
  });
  it('keeps media kinds for binary diffs and falls back to text for textual media (svg)', () => {
    const bin = parseDiff('diff --git a/s.wav b/s.wav\nindex 1..2 100644\nBinary files a/s.wav and b/s.wav differ\n');
    expect(bin[0].kind).toBe('audio');
    const other = parseDiff('diff --git a/x.bin b/x.bin\nindex 1..2 100644\nBinary files a/x.bin and b/x.bin differ\n');
    expect(other[0].kind).toBe('binary');
    const svg = parseDiff('diff --git a/i.svg b/i.svg\nindex 1..2 100644\n--- a/i.svg\n+++ b/i.svg\n@@ -1 +1 @@\n-<svg/>\n+<svg></svg>\n');
    expect(svg[0].kind).toBe('text');
  });
  it('maps mime types and rejects paths that escape the repository', () => {
    expect(mimeOf('a.mp4')).toBe('video/mp4');
    expect(mimeOf('a.MOV')).toBe('video/quicktime');
    expect(mimeOf('a.wav')).toBe('audio/wav');
    expect(mimeOf('a.png')).toBe('image/png');
    expect(mimeOf('a.unknown')).toBe('application/octet-stream');
    expect(safeRelPath('img/a.png')).toBe(true);
    expect(safeRelPath('../secret')).toBe(false);
    expect(safeRelPath('a/../../b')).toBe(false);
    expect(safeRelPath('/etc/passwd')).toBe(false);
    expect(safeRelPath('')).toBe(false);
  });
});

describe('parseRange', () => {
  it('reads explicit, open-ended and suffix ranges and rejects impossible ones', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-2', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });
});

describe('media sides and blobs', () => {
  let root: string;
  let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
  let base: string;
  let close: () => void;
  let first: string;
  let second: string;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-media-'));
    process.env.PRONG_STATE_DIR = path.join(root, 'state');
    fx = await makeFixtureRepo(root);
    fx.write('media/pixel.png', '');
    writeFileSync(path.join(fx.dir, 'media/pixel.png'), PNG_A);
    writeFileSync(path.join(fx.dir, 'media/sound.wav'), AUDIO);
    await fx.repo.stageAll();
    first = await fx.repo.commit('Add media');
    writeFileSync(path.join(fx.dir, 'media/pixel.png'), PNG_B);
    rmSync(path.join(fx.dir, 'media/sound.wav'));
    await fx.repo.stageAll();
    second = await fx.repo.commit('Change pixel, delete sound');
    const { server } = createApi();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => {
    close();
    rmSync(root, { recursive: true, force: true });
  });

  it('commit sides: an added file has no before, a deleted file no after, a modified file both', async () => {
    const added = await fx.repo.mediaSides('media/sound.wav', first);
    expect(added.before).toBeUndefined();
    expect(added.after).toMatchObject({ rev: first, file: 'media/sound.wav', bytes: AUDIO.length });
    const deleted = await fx.repo.mediaSides('media/sound.wav', second);
    expect(deleted.after).toBeUndefined();
    expect(deleted.before).toMatchObject({ rev: `${second}^`, bytes: AUDIO.length });
    const modified = await fx.repo.mediaSides('media/pixel.png', second);
    expect(modified.before!.oid).not.toBe(modified.after!.oid);
    expect(modified.before!.bytes).toBe(PNG_A.length);
  });

  it('working-copy sides: untracked (after only), modified, staged, deleted', async () => {
    writeFileSync(path.join(fx.dir, 'media/new.png'), PNG_A);
    const untracked = await fx.repo.mediaSides('media/new.png', 'unstaged');
    expect(untracked.before).toBeUndefined();
    expect(untracked.after).toMatchObject({ rev: WORKTREE, bytes: PNG_A.length });
    writeFileSync(path.join(fx.dir, 'media/pixel.png'), PNG_A);
    const modified = await fx.repo.mediaSides('media/pixel.png', 'unstaged');
    expect(modified.before).toMatchObject({ rev: ':0', bytes: PNG_B.length });
    expect(modified.after!.version).toMatch(/^w\d+-\d+$/);
    await fx.repo.stage(['media/pixel.png']);
    const staged = await fx.repo.mediaSides('media/pixel.png', 'staged');
    expect(staged.before!.rev).toBe('HEAD');
    expect(staged.after!.rev).toBe(':0');
    await fx.repo.unstageAll();
    await fx.repo.discard(['media/pixel.png', 'media/new.png']);
    rmSync(path.join(fx.dir, 'media/pixel.png'));
    const gone = await fx.repo.mediaSides('media/pixel.png', 'unstaged');
    expect(gone.before).toBeDefined();
    expect(gone.after).toBeUndefined();
    await fx.repo.discard(['media/pixel.png']);
  });

  it('stash sides find untracked files in the third parent', async () => {
    writeFileSync(path.join(fx.dir, 'media/stashed.wav'), AUDIO);
    await fx.repo.stashPush('with untracked', false, true);
    const sides = await fx.repo.mediaSides('media/stashed.wav', 'stash@{0}');
    expect(sides.before).toBeUndefined();
    expect(sides.after).toMatchObject({ rev: 'stash@{0}^3', bytes: AUDIO.length });
    await fx.repo.stashDrop(0);
  });

  it('materializes blobs byte-exact into a content-addressed cache, once', async () => {
    const a = await fx.repo.materializeBlob(first, 'media/sound.wav');
    expect(readFileSync(a!.path).equals(AUDIO)).toBe(true);
    expect(a!.path).toMatch(/cache\/blobs\/[0-9a-f]{40}\.wav$/);
    const again = await fx.repo.materializeBlob(first, 'media/sound.wav');
    expect(again!.path).toBe(a!.path);
    expect(await fx.repo.materializeBlob(second, 'media/sound.wav')).toBeNull();
    expect(await fx.repo.materializeBlob(first, '../outside.txt')).toBeNull();
  });

  it('serves blobs over HTTP with byte ranges (what WebKit needs to play media)', async () => {
    const url = `${base}/api/blob?repo=${encodeURIComponent(fx.dir)}&rev=${first}&file=media/sound.wav`;
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('audio/wav');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer()).equals(AUDIO)).toBe(true);
    const part = await fetch(url, { headers: { range: 'bytes=4-10' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 4-10/${AUDIO.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(AUDIO.subarray(4, 11))).toBe(true);
    const bad = await fetch(url, { headers: { range: `bytes=${AUDIO.length}-` } });
    expect(bad.status).toBe(416);
    const missing = await fetch(`${base}/api/blob?repo=${encodeURIComponent(fx.dir)}&rev=${second}&file=media/sound.wav`);
    expect(missing.status).toBe(404);
    const escape = await fetch(`${base}/api/blob?repo=${encodeURIComponent(fx.dir)}&rev=WORKTREE&file=../../etc/passwd`);
    expect(escape.status).toBe(400);
  });

  it('answers media sides and blob files through the op API', async () => {
    const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sides = await (await post('/api/repo/mediaSides', { path: fx.dir, file: 'media/pixel.png', area: second })).json();
    expect(sides.before.bytes).toBe(PNG_A.length);
    expect(sides.after.bytes).toBe(PNG_B.length);
    const file = await (await post('/api/repo/blobFile', { path: fx.dir, rev: second, file: 'media/pixel.png' })).json();
    expect(readFileSync(file.path).equals(PNG_B)).toBe(true);
    const gone = await post('/api/repo/blobFile', { path: fx.dir, rev: second, file: 'media/sound.wav' });
    expect(gone.status).toBe(404);
  });
});
