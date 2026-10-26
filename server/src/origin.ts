import type { IncomingMessage } from 'node:http';

/**
 * Who may talk to the engine.
 *
 * The engine listens on 127.0.0.1 and can run git, open files and start the agent, so a web page on any other
 * site must not be able to drive it through the user's browser. Rules:
 *
 * - The Host header must be a loopback name (127.0.0.1 / localhost / [::1]). This defeats DNS rebinding, where
 *   an attacker's domain resolves to 127.0.0.1 and the browser then treats the engine as that domain.
 * - A request with an Origin header is accepted only from the engine's own origin (the desktop app and the
 *   e2e harness load the UI from the engine), the Expo dev servers, or origins listed in PRONG_ALLOWED_ORIGINS.
 *   Browsers send Origin on every cross-origin request and on every POST, so this covers fetch, XHR and forms.
 * - A request without Origin (curl, tests, same-origin GETs, <img>/<video> loads) is accepted unless the
 *   browser marks it `Sec-Fetch-Site: cross-site` and its Referer is not an allowed origin: another site cannot
 *   even embed a blob or an icon.
 */

export const DEV_ORIGINS = ['http://localhost:8099', 'http://127.0.0.1:8099', 'http://localhost:8081', 'http://127.0.0.1:8081', 'http://localhost:19006', 'http://127.0.0.1:19006'];

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function extraOrigins(env: string | undefined = process.env.PRONG_ALLOWED_ORIGINS): string[] {
  return (env ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export interface OriginVerdict {
  ok: boolean;
  /** origin to echo in Access-Control-Allow-Origin (only for allowed cross-origin callers) */
  allowOrigin?: string;
  reason?: string;
}

export function checkRequest(h: { host?: string; origin?: string; referer?: string; secFetchSite?: string }, extra: string[] = extraOrigins()): OriginVerdict {
  const host = (h.host ?? '').trim();
  if (host && !LOOPBACK_HOST.test(host)) return { ok: false, reason: `host ${host} is not a loopback address` };
  const self = host ? [`http://${host.toLowerCase()}`] : [];
  const allowed = new Set([...self, ...DEV_ORIGINS, ...extra].map((o) => o.toLowerCase()));
  const origin = h.origin?.trim();
  if (origin) {
    if (origin === 'null') return { ok: false, reason: 'opaque origin' };
    if (!allowed.has(origin.toLowerCase())) return { ok: false, reason: `origin ${origin} is not allowed` };
    return { ok: true, allowOrigin: self.includes(origin.toLowerCase()) ? undefined : origin };
  }
  if (h.secFetchSite === 'cross-site') {
    let refOrigin = '';
    try {
      refOrigin = h.referer ? new URL(h.referer).origin.toLowerCase() : '';
    } catch {
      refOrigin = '';
    }
    if (!refOrigin || !allowed.has(refOrigin)) return { ok: false, reason: 'cross-site request' };
  }
  return { ok: true };
}

export function checkIncoming(req: IncomingMessage, extra?: string[]): OriginVerdict {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return checkRequest({ host: one(req.headers.host), origin: one(req.headers.origin), referer: one(req.headers.referer), secFetchSite: one(req.headers['sec-fetch-site']) }, extra);
}
