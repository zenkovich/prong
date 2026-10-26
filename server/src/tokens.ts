/**
 * An account's sign-in as kept in the Keychain. A personal token is kept as is; a GitHub App's user token expires
 * after 8 hours and comes with a refresh token (6 months), so it is kept as JSON with both and their deadlines and is
 * renewed on use.
 */
export interface StoredToken {
  access: string;
  refresh?: string;
  clientId?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
}

/** what GitHub answers to the device flow poll and to a refresh */
export interface GhTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface TokenAccount {
  id: string;
  host: string;
  login: string;
}

export interface TokenDeps {
  getSecret(id: string): Promise<string | null>;
  setSecret(id: string, value: string): Promise<void>;
  refresh(clientId: string, refreshToken: string, host: string): Promise<GhTokenResponse>;
  now(): number;
}

/** the sign-in is gone or can no longer be renewed: only signing in again helps */
export class SignInExpired extends Error {
  constructor(login: string, host: string, why: string) {
    super(`The GitHub sign-in of ${login} (${host}) ${why}. Sign in again under Accounts.`);
  }
}

// renewed a minute early, so a request never leaves with a token that dies on the way
const EARLY_MS = 60_000;

export function parseStored(raw: string): StoredToken {
  if (raw.startsWith('{')) {
    try {
      const t = JSON.parse(raw) as StoredToken;
      if (typeof t.access === 'string') return t;
    } catch {
      // not ours: a token that happens to start with a brace
    }
  }
  return { access: raw };
}

export function serializeStored(t: StoredToken): string {
  return t.refresh ? JSON.stringify(t) : t.access;
}

export function storedFrom(r: GhTokenResponse, clientId: string, now: number): StoredToken {
  const t: StoredToken = { access: r.access_token ?? '' };
  if (r.refresh_token) {
    t.refresh = r.refresh_token;
    t.clientId = clientId;
    if (r.expires_in) t.expiresAt = now + r.expires_in * 1000;
    if (r.refresh_token_expires_in) t.refreshExpiresAt = now + r.refresh_token_expires_in * 1000;
  }
  return t;
}

// a refresh token works once: concurrent requests of one account share one renewal
const renewing = new Map<string, Promise<string>>();

/** a token of the account that is valid now, renewed and saved back when it has expired */
export async function accountToken(acc: TokenAccount, deps: TokenDeps): Promise<string> {
  const raw = await deps.getSecret(acc.id);
  if (!raw) throw new SignInExpired(acc.login, acc.host, 'is missing');
  const t = parseStored(raw);
  if (!t.expiresAt || t.expiresAt - EARLY_MS > deps.now()) return t.access;
  if (!t.refresh || !t.clientId || (t.refreshExpiresAt && t.refreshExpiresAt <= deps.now())) throw new SignInExpired(acc.login, acc.host, 'has expired');

  const pending = renewing.get(acc.id);
  if (pending) return pending;
  const job = (async () => {
    const r = await deps.refresh(t.clientId!, t.refresh!, acc.host);
    if (!r.access_token) throw new SignInExpired(acc.login, acc.host, `could not be renewed (${r.error_description || r.error || 'no token in the answer'})`);
    const next = storedFrom(r, t.clientId!, deps.now());
    await deps.setSecret(acc.id, serializeStored(next));
    return next.access;
  })().finally(() => renewing.delete(acc.id));
  renewing.set(acc.id, job);
  return job;
}
