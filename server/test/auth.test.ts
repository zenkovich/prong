import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountAuth, hostOwner, resolveAuth, sshAuth, TOKEN_HELPER, validKeyPath } from '../src/auth.js';
import { Repo } from '../src/git/repo.js';

/** How a repository (and its submodules) signs in to remotes: SSH key or account, inherited downwards. */
describe('repository connection', () => {
  let root: string;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, args: string[], extra: Record<string, string> = {}, input?: string) =>
    execFileSync('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0', ...extra }, input, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-auth-'));
    mkdirSync(path.join(root, 'ssh'));
    writeFileSync(path.join(root, 'ssh/work_key'), 'not a real key\n');
    writeFileSync(path.join(root, 'ssh/work_key.pub'), 'ssh-ed25519 AAAA test\n');
    process.env.PRONG_SSH_DIR = path.join(root, 'ssh');
  });
  afterAll(() => {
    delete process.env.PRONG_SSH_DIR;
    Repo.auth = null;
    rmSync(root, { recursive: true, force: true });
  });

  it('a submodule inherits its parent’s setting; its own wins; a sibling folder with the same prefix does not', () => {
    const repos = [
      { path: '/w/homescapes', auth: { kind: 'ssh' as const, key: 'plrx' } },
      { path: '/w/homescapes/libs/own', auth: { kind: 'account' as const, account: 'github.com:me' } },
      { path: '/w/homescapes/libs/plain', auth: { kind: 'default' as const } },
      { path: '/w/other' },
    ];
    expect(resolveAuth(repos, '/w/homescapes')).toEqual({ auth: { kind: 'ssh', key: 'plrx' }, from: '/w/homescapes' });
    expect(resolveAuth(repos, '/w/homescapes/vso-engine')?.from).toBe('/w/homescapes');
    expect(resolveAuth(repos, '/w/homescapes/libs/own/deeper')?.auth).toEqual({ kind: 'account', account: 'github.com:me' });
    expect(resolveAuth(repos, '/w/homescapes/libs/plain')?.auth.kind).toBe('default');
    expect(resolveAuth(repos, '/w/homescapes2')).toBeNull();
    expect(resolveAuth(repos, '/w/other')).toBeNull();
  });

  it('accepts only private keys inside the SSH folder', () => {
    expect(validKeyPath('work_key')).toBe(path.join(root, 'ssh/work_key'));
    expect(validKeyPath(path.join(root, 'ssh/work_key'))).toBe(path.join(root, 'ssh/work_key'));
    for (const bad of ['work_key.pub', '../ssh/../../etc/passwd', '/etc/hosts', 'missing', "it's", '']) expect(validKeyPath(bad)).toBeNull();
    expect(sshAuth(validKeyPath('work_key')!).env.GIT_SSH_COMMAND).toBe(`ssh -i '${path.join(root, 'ssh/work_key')}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`);
  });

  it('an account’s token goes to its host only, and never into the command line', () => {
    const a = accountAuth('github.com', 'me', 'tok-123');
    expect(a.config.join(' ')).not.toContain('tok-123');
    const cfg = a.config.flatMap((c) => ['-c', c]);
    const ask = (host: string) => {
      try {
        return git(root, [...cfg, 'credential', 'fill'], a.env, `protocol=https\nhost=${host}\n\n`);
      } catch (e: any) {
        return String(e.stdout ?? '') + String(e.stderr ?? '');
      }
    };
    const own = ask('github.com');
    expect(own).toContain('username=x-access-token');
    expect(own).toContain('password=tok-123');
    expect(ask('evil.example.com')).not.toContain('tok-123');
    expect(TOKEN_HELPER).toContain('$PRONG_GIT_TOKEN');
  });

  it('an account turns SSH addresses of its host into HTTPS for the command', () => {
    const r = path.join(root, 'rewrite');
    execFileSync('git', ['init', '-q', r]);
    git(r, ['remote', 'add', 'origin', 'git@github.com:Playrix/perfect-project.git']);
    git(r, ['remote', 'add', 'other', 'git@gitlab.com:x/y.git']);
    const cfg = accountAuth('github.com', 'me', 't').config.flatMap((c) => ['-c', c]);
    expect(git(r, [...cfg, 'ls-remote', '--get-url', 'origin']).trim()).toBe('https://github.com/Playrix/perfect-project.git');
    expect(git(r, [...cfg, 'ls-remote', '--get-url', 'other']).trim()).toBe('git@gitlab.com:x/y.git');
  });

  it('fetch, and the clone a submodule update makes, run with the repository’s SSH command', async () => {
    const log = path.join(root, 'ssh-calls.log');
    const fake = path.join(root, 'fake-ssh.sh');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\nexit 1\n`);
    chmodSync(fake, 0o755);
    // a superproject whose submodule lives on an SSH server
    const sup = path.join(root, 'super');
    execFileSync('git', ['init', '-q', '-b', 'main', sup]);
    git(sup, ['config', 'commit.gpgsign', 'false']);
    git(sup, ['remote', 'add', 'origin', 'ssh://git@example.invalid/super.git']);
    writeFileSync(path.join(sup, '.gitmodules'), '[submodule "core"]\n\tpath = libs/core\n\turl = ssh://git@example.invalid/core.git\n');
    git(sup, ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},libs/core`]);
    git(sup, ['add', '.gitmodules']);
    git(sup, ['commit', '-qm', 'with submodule']);
    Repo.auth = async (dir) => (dir.startsWith(sup) ? { env: { GIT_SSH_COMMAND: `sh '${fake}'` }, config: [], describe: 'test key' } : null);
    const repo = new Repo(sup);
    await expect(repo.fetch('origin')).rejects.toThrow();
    await expect(repo.submoduleUpdate(['libs/core'], false)).rejects.toThrow();
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    expect(calls).toContain("git-upload-pack '/super.git'");
    expect(calls).toContain("git-upload-pack '/core.git'"); // the submodule clone went through the same command
  });
});

describe('repository addresses', () => {
  it('host and owner of SSH, ssh:// and HTTPS addresses; nothing for a local path', () => {
    expect(hostOwner('git@github.com:Playrix/township.git')).toEqual({ host: 'github.com', owner: 'Playrix' });
    expect(hostOwner('ssh://git@GitHub.com:22/Playrix/township.git')).toEqual({ host: 'github.com', owner: 'Playrix' });
    expect(hostOwner('https://github.com/zenkovich/prong.git')).toEqual({ host: 'github.com', owner: 'zenkovich' });
    expect(hostOwner('/Users/me/repos/x.git')).toBeNull();
  });
});
