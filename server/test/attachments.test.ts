import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachDir, attachmentPath, attachmentsNote, safeName, saveAttachment } from '../src/attachments.js';

/** files pasted or dropped on an agent message: kept by the engine, handed to the agent by path */
describe('agent attachments', () => {
  let state: string;
  const before = process.env.PRONG_STATE_DIR;
  beforeAll(() => {
    state = mkdtempSync(path.join(tmpdir(), 'prong-attach-'));
    process.env.PRONG_STATE_DIR = state;
  });
  afterAll(() => {
    process.env.PRONG_STATE_DIR = before;
    rmSync(state, { recursive: true, force: true });
  });
  const body = (b: Buffer) => Readable.from([b]) as any;

  it('a pasted screenshot is kept under a name of its own, with the extension of its type', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const r = await saveAttachment(body(png), '', 'image/png');
    expect(r.name).toBe('pasted.png');
    expect(r.size).toBe(7);
    expect(path.dirname(r.path)).toBe(attachDir());
    expect(readFileSync(r.path)).toEqual(png);
    expect(attachmentPath(r.file)).toBe(r.path);
  });

  it('only its own stored files are handed back: no paths, no other names', async () => {
    const r = await saveAttachment(body(Buffer.from('notes')), '../../etc/passwd notes.txt', 'text/plain');
    expect(r.name).toBe('passwd notes.txt');
    expect(attachmentPath(r.file)).toBe(r.path);
    for (const bad of ['../x', '/etc/passwd', 'x/../../y', 'abc', `${r.file}/..`, '']) expect(attachmentPath(bad)).toBeNull();
  });

  it('an empty or a too large file is refused', async () => {
    await expect(saveAttachment(body(Buffer.alloc(0)), 'a.png', 'image/png')).rejects.toThrow(/empty/);
    await expect(saveAttachment(Readable.from([Buffer.alloc(26 * 1024 * 1024)]) as any, 'big.png', 'image/png')).rejects.toThrow(/too large/);
  });

  it('names: unsafe characters go, an extension stays or comes from the type', () => {
    expect(safeName('Снимок экрана 2026.png', 'image/png')).toBe('Снимок экрана 2026.png');
    expect(safeName('shot', 'image/jpeg')).toBe('shot.jpg');
    expect(safeName('.hidden', 'text/plain')).toBe('hidden.txt');
  });

  it('the agent is told to open each file with Read', () => {
    expect(attachmentsNote([])).toBe('');
    const note = attachmentsNote(['/a/one.png', '/a/two.pdf']);
    expect(note).toMatch(/2 files/);
    expect(note).toMatch(/Read tool/);
    expect(note).toContain('- /a/one.png');
  });
});
