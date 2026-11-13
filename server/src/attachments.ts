import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { STATE_DIR } from './state.js';

/**
 * What the user attaches to an agent message (pasted or dropped: screenshots above all). Each is kept as a file
 * in the engine's state folder for a week; the agent gets its path and opens it with Claude Code's Read tool,
 * which shows it an image or a PDF as such. The chat shows the image back from here.
 */
export const attachDir = () => path.join(STATE_DIR(), 'agent-attachments');
/** a screenshot of a large screen is a few MB; a video is not what this is for */
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 3600_000;
/** the stored file's name: what the engine hands out and takes back (never a path) */
const STORED = /^[0-9a-z]{6,40}-[\p{L}\p{N}_.() -]{1,120}$/iu;

function prune() {
  try {
    for (const f of readdirSync(attachDir())) {
      const p = path.join(attachDir(), f);
      if (Date.now() - statSync(p).mtimeMs > KEEP_MS) rmSync(p, { force: true });
    }
  } catch {
    /* nothing kept yet */
  }
}

/** a name safe for the file system, its extension kept (a pasted image has none: from its type) */
export function safeName(name: string, mime: string): string {
  const base = path.basename(String(name || '')).replace(/[^\p{L}\p{N}_.() -]+/gu, '_').replace(/^\.+/, '').slice(-100) || 'pasted';
  if (/\.[a-z0-9]{1,6}$/i.test(base)) return base;
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt' }[mime] ?? '';
  return base + ext;
}

/** the request's body (the file's bytes) kept as an attachment */
export async function saveAttachment(req: IncomingMessage, name: string, mime: string): Promise<{ file: string; path: string; name: string; mime: string; size: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_ATTACHMENT) {
        reject(Object.assign(new Error(`The file is over ${MAX_ATTACHMENT / 1024 / 1024} MB: too large to attach`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve());
    req.on('error', reject);
  });
  if (!size) throw Object.assign(new Error('The file is empty'), { status: 400 });
  prune();
  mkdirSync(attachDir(), { recursive: true });
  const shown = safeName(name, mime);
  const file = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}-${shown}`;
  const full = path.join(attachDir(), file);
  writeFileSync(full, Buffer.concat(chunks));
  return { file, path: full, name: shown, mime, size };
}

/** the path of a stored attachment by its file name, or null (unknown, gone, not one of ours) */
export function attachmentPath(file: string): string | null {
  if (!STORED.test(String(file))) return null;
  const full = path.join(attachDir(), file);
  return path.dirname(full) === attachDir() && existsSync(full) ? full : null;
}

/** what the agent is told about the files attached to the message */
export function attachmentsNote(paths: string[]): string {
  if (!paths.length) return '';
  return `\n\nThe user attached ${paths.length === 1 ? 'a file' : `${paths.length} files`} to this message. Open ${paths.length === 1 ? 'it' : 'each'} with the Read tool (images and PDFs are shown to you that way) before you answer:\n${paths.map((p) => `- ${p}`).join('\n')}`;
}
