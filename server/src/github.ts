/** GitHub REST helpers: token validation, repository list for cloning, SSH key upload, device flow. */

import type { GhTokenResponse } from './tokens.js';

/** GitHub refused the token: it was revoked, or it expired */
export class GhUnauthorized extends Error {}

function apiBase(host: string) {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

async function gh<T>(host: string, token: string, route: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${apiBase(host)}${route}`, { ...init, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'prong', ...(init.headers ?? {}) } });
  if (r.status === 401) throw new GhUnauthorized(`GitHub ${route} → 401 ${(await r.text()).slice(0, 200)}`);
  if (!r.ok) throw new Error(`GitHub ${route} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

export interface GhUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

export async function validateToken(host: string, token: string) {
  const user = await gh<GhUser>(host, token, '/user');
  const orgs = await gh<{ login: string }[]>(host, token, '/user/orgs?per_page=100').catch(() => []);
  return { login: user.login, name: user.name ?? user.login, avatar: user.avatar_url, orgs: orgs.map((o) => o.login) };
}

/** the installations of GitHub Apps this user token can see (where the app reaches private repositories) */
export async function userInstallations(host: string, token: string) {
  const r = await gh<{ installations: { account: { login: string }; app_slug: string; repository_selection: string }[] }>(host, token, '/user/installations?per_page=100');
  return r.installations.map((i) => ({ account: i.account.login, slug: i.app_slug, selection: i.repository_selection }));
}

export async function listRepos(host: string, token: string, page = 1) {
  const repos = await gh<{ full_name: string; ssh_url: string; clone_url: string; private: boolean; pushed_at: string; description: string | null }[]>(host, token, `/user/repos?per_page=100&sort=pushed&page=${page}`);
  return repos.map((r) => ({ fullName: r.full_name, sshUrl: r.ssh_url, httpsUrl: r.clone_url, private: r.private, pushedAt: r.pushed_at, description: r.description ?? '' }));
}

export async function addSshKey(host: string, token: string, title: string, key: string) {
  return gh<{ id: number }>(host, token, '/user/keys', { method: 'POST', body: JSON.stringify({ title, key }), headers: { 'content-type': 'application/json' } });
}

/**
 * Prong's own OAuth app on github.com (device flow on), the way Fork signs in: its token reaches every repository the
 * user can reach. The GitHub App used before (`Iv23…`) reached only where it was installed — nowhere, as a rule — so
 * pushes failed with "Write access to repository not granted". A client id is public; the device flow needs no secret.
 */
export const PRONG_CLIENT_ID = 'Ov23li733t6lHfwMrFOH';
/** client ids that were Prong's before: a saved one of these is not the user's own choice, the built-in replaces it */
const FORMER_CLIENT_IDS = new Set(['Iv23lifyjeOmrixbmyni']);

/** the user's own client id as saved, '' when none (or one of Prong's former ones) */
export function ownClientId(saved?: string | null): string {
  const id = (saved ?? '').trim();
  return FORMER_CLIENT_IDS.has(id) ? '' : id;
}

/** the client id for a sign-in: the user's own app if set (GitHub Enterprise needs one), else Prong's on github.com */
export function clientIdFor(host: string, own?: string | null): string {
  return ownClientId(own) || (host === 'github.com' ? PRONG_CLIENT_ID : '');
}

/** what Prong asks for: repositories (with their workflow files, else such a push is refused), organizations, SSH keys */
const SCOPES = 'repo workflow read:org admin:public_key';

/** OAuth device flow: the user approves a code in the browser */
export async function deviceStart(clientId: string, host = 'github.com') {
  const url = host === 'github.com' ? 'https://github.com/login/device/code' : `https://${host}/login/device/code`;
  const r = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, scope: SCOPES }) });
  if (!r.ok) throw new Error(`device flow start failed: ${r.status}`);
  return (await r.json()) as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
}

async function tokenRequest(host: string, body: Record<string, string>): Promise<GhTokenResponse> {
  const url = host === 'github.com' ? 'https://github.com/login/oauth/access_token' : `https://${host}/login/oauth/access_token`;
  const r = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await r.json()) as GhTokenResponse;
}

export function devicePoll(clientId: string, deviceCode: string, host = 'github.com') {
  return tokenRequest(host, { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
}

/** a GitHub App's expired user token renewed; a token from the device flow needs no client secret for it */
export function refreshUserToken(clientId: string, refreshToken: string, host = 'github.com') {
  return tokenRequest(host, { client_id: clientId, refresh_token: refreshToken, grant_type: 'refresh_token' });
}
