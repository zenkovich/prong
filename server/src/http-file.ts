import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serves a file with HTTP byte ranges. WebKit (Safari, the WKWebView of Prong.app) only plays <video> and
 * <audio> from servers that answer `Range` requests with 206, so every media response goes through here.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    // suffix range: the last N bytes
    const n = parseInt(m[2], 10);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

export function serveFile(req: IncomingMessage, res: ServerResponse, file: string, mime: string, extraHeaders: Record<string, string> = {}) {
  const size = statSync(file).size;
  const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
  const base = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', ...extraHeaders };
  if (range === 'invalid') {
    res.writeHead(416, { ...base, 'content-range': `bytes */${size}` }).end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, { ...base, 'content-length': String(length), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
