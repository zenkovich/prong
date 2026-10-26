import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { RepoAuth } from './types.js';

/**
 * How git signs in to the remotes of a repository (RepoAuth). Set per repository; its submodules (and any repository
 * inside its folder) use the same unless they have their own. Absent everywhere: git's defaults (ssh-agent,
 * ~/.ssh/config, credential helpers).
 */
export type { RepoAuth };

/** what a network command of that repository runs with: environment and `-c` settings */
export interface NetAuth {
  env: Record<string, string>;
  config: string[];
  describe: string;
}

export const sshDir = () => process.env.PRONG_SSH_DIR ?? path.join(homedir(), '.ssh');

/** the setting for `dir`: its own, or the nearest registered folder above it that has one */
export function resolveAuth(repos: { path: string; auth?: RepoAuth }[], dir: string): { auth: RepoAuth; from: string } | null {
  let best: { auth: RepoAuth; from: string } | null = null;
  for (const r of repos) {
    if (!r.auth) continue;
    const inside = dir === r.path || dir.startsWith(r.path.endsWith('/') ? r.path : r.path + '/');
    if (inside && (!best || r.path.length > best.from.length)) best = { auth: r.auth, from: r.path };
  }
  return best;
}

/** a private key inside the SSH folder (by name or full path), safe to put in a command line */
export function validKeyPath(key: string): string | null {
  if (!key || typeof key !== 'string') return null;
  const dir = path.resolve(sshDir());
  const p = path.resolve(dir, key);
  if (!p.startsWith(dir + path.sep)) return null;
  if (/['"\\$`\n\r]/.test(p) || p.endsWith('.pub')) return null;
  try {
    return existsSync(p) && statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/** only this key (or the agent's copy of it); no prompts; a new host is remembered on first contact */
export function sshAuth(keyPath: string): NetAuth {
  return {
    env: { GIT_SSH_COMMAND: `ssh -i '${keyPath}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new` },
    config: [],
    describe: `SSH key ${path.basename(keyPath)}`,
  };
}

/**
 * git's credential helper for an account: answers with the token only when git asks for the account's host, so a
 * submodule on another server never sees it. The token travels in the environment, never in the command line.
 */
export const TOKEN_HELPER =
  '!f() { test "$1" = get || exit 0; h=; while IFS= read -r l; do case "$l" in host=*) h="${l#host=}";; esac; done; test "$h" = "$PRONG_GIT_HOST" || exit 0; echo username=x-access-token; echo "password=$PRONG_GIT_TOKEN"; }; f';

/** an account (a token from the Keychain) over HTTPS; SSH addresses of its host are used over HTTPS for the command */
export function accountAuth(host: string, login: string, token: string): NetAuth {
  return {
    env: { PRONG_GIT_TOKEN: token, PRONG_GIT_HOST: host },
    config: ['credential.helper=', `credential.helper=${TOKEN_HELPER}`, `url.https://${host}/.insteadOf=git@${host}:`, `url.https://${host}/.insteadOf=ssh://git@${host}/`],
    describe: `account ${login} (${host})`,
  };
}

export function sameAuth(a?: RepoAuth | null, b?: RepoAuth | null) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
