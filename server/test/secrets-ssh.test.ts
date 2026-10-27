import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// nothing here may start a process: in test mode a secret never reaches `security` (the user's Keychain)
const spawned: string[] = [];
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: (cmd: string, ...rest: any[]) => {
      spawned.push(cmd);
      if (cmd === 'security') throw new Error('the Keychain must not be touched by tests');
      return (real.spawn as any)(cmd, ...rest);
    },
  };
});

describe('engine: secrets in test mode, SSH keys in the SSH folder', () => {
  let root: string;
  const env = { ...process.env };
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-secrets-'));
    process.env.PRONG_TEST_MODE = '1';
    process.env.PRONG_STATE_DIR = path.join(root, 'state');
    process.env.PRONG_SSH_DIR = path.join(root, 'ssh');
  });
  afterAll(() => {
    for (const k of ['PRONG_TEST_MODE', 'PRONG_STATE_DIR', 'PRONG_SSH_DIR']) if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps secrets in a file of the state folder, never in the Keychain', async () => {
    const { getSecret, setSecret, deleteSecret } = await import('../src/system.js');
    await setSecret('github.com:someone', 'token-1');
    const file = path.join(root, 'state', 'test-secrets.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'github.com:someone': 'token-1' });
    expect(await getSecret('github.com:someone')).toBe('token-1');
    expect(await getSecret('github.com:nobody')).toBeNull();
    await deleteSecret('github.com:someone');
    expect(await getSecret('github.com:someone')).toBeNull();
    expect(spawned).not.toContain('security');
  });

  it('makes a key pair in the SSH folder the key list reads; a name that is a path or an option is refused', async () => {
    const { generateSshKey, listSshKeys, addKeyToAgent } = await import('../src/system.js');
    const r = await generateSshKey('made_here', 'ed25519', '', 'test');
    expect(r.file).toBe(path.join(root, 'ssh', 'made_here'));
    expect(existsSync(path.join(root, 'ssh', 'made_here.pub'))).toBe(true);
    expect((await listSshKeys()).map((k) => k.name)).toContain('made_here');
    await expect(generateSshKey('made_here', 'ed25519', '', '')).rejects.toThrow(/already exists/);
    for (const bad of ['../outside', 'a/b', '-oProxyCommand=x', '.hidden', 'k.pub', '']) await expect(generateSshKey(bad, 'ed25519', '', '')).rejects.toThrow(/Not a key file name/);
    expect(existsSync(path.join(root, 'outside'))).toBe(false);
    // ssh-agent gets only a key of that folder (and not one that is missing)
    await expect(addKeyToAgent('../outside')).rejects.toThrow(/Not a key file name/);
    await expect(addKeyToAgent('missing_key')).rejects.toThrow(/does not exist/);
    mkdirSync(path.join(root, 'ssh'), { recursive: true });
  });
});
