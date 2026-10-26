import { describe, expect, it } from 'vitest';
import { accountToken, parseStored, serializeStored, SignInExpired, storedFrom, type GhTokenResponse, type TokenDeps } from '../src/tokens.js';

const HOUR = 3600_000;
const acc = { id: 'github.com:me', host: 'github.com', login: 'me' };

function stand(initial: string | null, answer: (refresh: string) => GhTokenResponse) {
  const secrets = new Map<string, string>();
  if (initial !== null) secrets.set(acc.id, initial);
  const refreshes: { clientId: string; refresh: string; host: string }[] = [];
  let now = 1_000_000;
  const deps: TokenDeps = {
    getSecret: async (id) => secrets.get(id) ?? null,
    setSecret: async (id, v) => void secrets.set(id, v),
    refresh: async (clientId, refresh, host) => {
      refreshes.push({ clientId, refresh, host });
      await new Promise((r) => setTimeout(r, 5));
      return answer(refresh);
    },
    now: () => now,
  };
  return { deps, secrets, refreshes, advance: (ms: number) => (now += ms), at: () => now };
}

const appToken = (n: number): GhTokenResponse => ({ access_token: `ghu_${n}`, expires_in: 28800, refresh_token: `ghr_${n}`, refresh_token_expires_in: 15897600 });

describe('account tokens', () => {
  it('keeps a personal token as it is and never renews it', async () => {
    const s = stand('ghp_personal', () => appToken(9));
    expect(serializeStored(storedFrom({ access_token: 'ghp_personal' }, 'Iv1', 0))).toBe('ghp_personal');
    s.advance(1000 * HOUR);
    expect(await accountToken(acc, s.deps)).toBe('ghp_personal');
    expect(s.refreshes).toHaveLength(0);
  });

  it('renews an expired GitHub App token with its refresh token and saves the new pair', async () => {
    const s = stand(null, (r) => (r === 'ghr_1' ? appToken(2) : { error: 'bad_refresh_token' }));
    s.secrets.set(acc.id, serializeStored(storedFrom(appToken(1), 'Iv23app', s.at())));
    expect(await accountToken(acc, s.deps)).toBe('ghu_1');
    s.advance(8 * HOUR);
    expect(await accountToken(acc, s.deps)).toBe('ghu_2');
    expect(s.refreshes).toEqual([{ clientId: 'Iv23app', refresh: 'ghr_1', host: 'github.com' }]);
    const saved = parseStored(s.secrets.get(acc.id)!);
    expect(saved).toMatchObject({ access: 'ghu_2', refresh: 'ghr_2', clientId: 'Iv23app', expiresAt: s.at() + 8 * HOUR });
    expect(await accountToken(acc, s.deps)).toBe('ghu_2');
    expect(s.refreshes).toHaveLength(1);
  });

  it('renews a minute before the deadline, once for requests that come together', async () => {
    const s = stand(null, () => appToken(2));
    s.secrets.set(acc.id, serializeStored(storedFrom(appToken(1), 'Iv23app', s.at())));
    s.advance(8 * HOUR - 30_000);
    expect(await Promise.all([accountToken(acc, s.deps), accountToken(acc, s.deps), accountToken(acc, s.deps)])).toEqual(['ghu_2', 'ghu_2', 'ghu_2']);
    expect(s.refreshes).toHaveLength(1);
  });

  it('asks to sign in again when the renewal is refused, the refresh token has expired or nothing is stored', async () => {
    const refused = stand(null, () => ({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }));
    refused.secrets.set(acc.id, serializeStored(storedFrom(appToken(1), 'Iv23app', refused.at())));
    refused.advance(9 * HOUR);
    await expect(accountToken(acc, refused.deps)).rejects.toThrow(/sign-in of me \(github\.com\) could not be renewed \(The refresh token passed is incorrect or expired\.\)\. Sign in again under Accounts/);

    const old = stand(null, () => appToken(2));
    old.secrets.set(acc.id, serializeStored(storedFrom(appToken(1), 'Iv23app', old.at())));
    old.advance(7 * 30 * 24 * HOUR);
    await expect(accountToken(acc, old.deps)).rejects.toBeInstanceOf(SignInExpired);
    expect(old.refreshes).toHaveLength(0);

    await expect(accountToken(acc, stand(null, () => appToken(2)).deps)).rejects.toThrow(/is missing/);
  });

  it('reads a token that only looks like JSON as a plain token', () => {
    expect(parseStored('{not json')).toEqual({ access: '{not json' });
    expect(parseStored('{"x":1}')).toEqual({ access: '{"x":1}' });
  });
});
