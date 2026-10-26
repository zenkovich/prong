import { sshDir } from './auth.js';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Runs a system command and resolves with stdout; rejects on non-zero exit. */
export function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string>; onLine?: (l: string) => void; signal?: AbortSignal } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // abortable runs get their own process group so a stop also ends the tools they started (shells, git, tsc)
    const group = !!opts.signal && process.platform !== 'win32';
    const child = spawn(cmd, args, { cwd: opts.cwd, detached: group, env: { ...process.env, PATH: `${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const onAbort = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('close', () => opts.signal?.removeEventListener('abort', onAbort));
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let pending = '';
    const feed = (b: Buffer) => {
      if (!opts.onLine) return;
      pending += b.toString('utf8');
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const p of parts) if (p.trim()) opts.onLine(p);
    };
    child.stdout.on('data', (b: Buffer) => {
      out.push(b);
      feed(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      err.push(b);
      feed(b);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (opts.onLine && pending.trim()) opts.onLine(pending);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

// ---------- open / reveal / terminal (macOS) ----------

export async function openWith(app: string, target: string) {
  const r = await run('open', app ? ['-a', app, target] : [target]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `open failed (${r.code})`);
}
export async function reveal(target: string) {
  const r = await run('open', ['-R', target]);
  if (r.code !== 0) throw new Error(r.stderr.trim());
}
export async function openTerminal(app: string, dir: string) {
  if (/iterm/i.test(app)) {
    const script = `tell application "iTerm"\n activate\n create window with default profile\n tell current session of current window to write text "cd " & quoted form of "${dir}"\nend tell`;
    await run('osascript', ['-e', script]);
  } else {
    await run('osascript', ['-e', `tell application "Terminal" to do script "cd " & quoted form of "${dir}"`, '-e', 'tell application "Terminal" to activate']);
  }
}

// ---------- ssh keys ----------

export interface SshKeyInfo {
  name: string;
  type: string;
  bits: number;
  fingerprint: string;
  comment: string;
  publicKey: string;
  inAgent: boolean;
  hasPassphrase: boolean | null;
}

export async function listSshKeys(): Promise<SshKeyInfo[]> {
  const dir = sshDir();
  if (!existsSync(dir)) return [];
  const agent = await run('ssh-add', ['-l', '-E', 'sha256']).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  const agentFps = new Set(agent.stdout.split('\n').map((l) => l.split(' ')[1]).filter(Boolean));
  const out: SshKeyInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.pub')) continue;
    const pub = readFileSync(path.join(dir, f), 'utf8').trim();
    const fp = await run('ssh-keygen', ['-l', '-E', 'sha256', '-f', path.join(dir, f)]);
    const m = fp.stdout.trim().match(/^(\d+) (\S+) (.*) \((\w+)\)$/);
    const priv = path.join(dir, f.replace(/\.pub$/, ''));
    let hasPassphrase: boolean | null = null;
    if (existsSync(priv)) {
      const head = readFileSync(priv, 'utf8').slice(0, 400);
      hasPassphrase = /ENCRYPTED/.test(head) ? true : /BEGIN OPENSSH PRIVATE KEY/.test(head) ? null : false;
      if (hasPassphrase === null) {
        // openssh format: try to read without passphrase
        const t = await run('ssh-keygen', ['-y', '-P', '', '-f', priv]);
        hasPassphrase = t.code !== 0;
      }
    }
    out.push({ name: f.replace(/\.pub$/, ''), type: m ? m[4].toLowerCase() : pub.split(' ')[0].replace('ssh-', ''), bits: m ? parseInt(m[1], 10) : 0, fingerprint: m ? m[2] : '', comment: m ? m[3] : '', publicKey: pub, inAgent: m ? agentFps.has(m[2]) : false, hasPassphrase });
  }
  return out;
}

export async function generateSshKey(name: string, type: 'ed25519' | 'rsa' | 'ecdsa', passphrase: string, comment: string) {
  const file = path.join(homedir(), '.ssh', name);
  if (existsSync(file)) throw new Error(`${file} already exists`);
  const args = ['-q', '-t', type, ...(type === 'rsa' ? ['-b', '4096'] : []), '-C', comment || `${process.env.USER}@prong`, '-N', passphrase, '-f', file];
  const r = await run('ssh-keygen', args);
  if (r.code !== 0) throw new Error(r.stderr.trim());
  return { file };
}

export async function addKeyToAgent(name: string, useKeychain = true) {
  const file = path.join(homedir(), '.ssh', name);
  const r = await run('ssh-add', [...(useKeychain ? ['--apple-use-keychain'] : []), file]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'ssh-add failed (passphrase-protected keys must be added from a terminal once)');
}

export async function testSsh(host: string, onLine?: (l: string) => void) {
  const r = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', `git@${host}`], { onLine });
  const text = (r.stdout + r.stderr).trim();
  // github/gitlab exit 1 after a successful greeting
  const ok = /successfully authenticated|Welcome to GitLab|logged in as/i.test(text);
  return { ok, output: text };
}

// ---------- keychain (macOS `security`) ----------

const SERVICE = 'space.zenkovich.prong';

export async function setSecret(account: string, value: string) {
  await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]).catch(() => null);
  const r = await run('security', ['add-generic-password', '-s', SERVICE, '-a', account, '-w', value, '-U']);
  if (r.code !== 0) throw new Error(r.stderr.trim());
}
export async function getSecret(account: string): Promise<string | null> {
  const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
  return r.code === 0 ? r.stdout.trim() : null;
}
export async function deleteSecret(account: string) {
  await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]).catch(() => null);
}

// ---------- which ----------

export async function which(bin: string): Promise<string | null> {
  const r = await run('/bin/sh', ['-lc', `command -v ${bin}`]);
  return r.code === 0 ? r.stdout.trim().split('\n').pop() ?? null : null;
}
