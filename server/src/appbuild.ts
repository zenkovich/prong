import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './state.js';

/**
 * Prong rebuilding and restarting itself. The interface is rebuilt after every agent version (buildUi), but the
 * git engine and the window around it are the copies compiled into Prong.app: a change under server/ or macos/
 * only runs after `macos/build.sh` and a restart. The engine does both. The build runs while the app keeps working
 * (the script swaps the bundle at its very end); then a small detached waiter opens the new app once this one is
 * gone, and the window is asked to quit. The agent chat goes over to the new instance through a file.
 */

const STARTED = Date.now();

/** the app bundle this engine runs from (`…/Prong.app/Contents/Resources/bin/node`), or null (a dev or test run) */
export function runningBundle(execPath = process.execPath): string | null {
  const m = /^(.+\.app)\/Contents\/Resources\/bin\/node$/.exec(execPath);
  return m ? m[1] : null;
}

/** the bundle macos/build.sh makes in the sources */
export const builtBundle = (sources: string) => path.join(sources, 'macos', 'build', 'Prong.app');

/** when a bundle was built: build.sh copies its Info.plist anew each time */
function builtAt(bundle: string): number {
  try {
    return statSync(path.join(bundle, 'Contents', 'Info.plist')).mtimeMs;
  } catch {
    return 0;
  }
}

/** a build of the sources newer than this run: the agent or the user ran macos/build.sh since Prong started */
export function newerBuildOnDisk(sources: string, startedAt = STARTED): boolean {
  return !!sources && builtAt(builtBundle(sources)) > startedAt;
}

/** the newest mtime of the files under `p` (a file or a folder), dependencies and dot folders left out */
function newest(p: string): number {
  let st;
  try {
    st = statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'build' || e.name === 'dist') continue;
    n = Math.max(n, newest(path.join(p, e.name)));
  }
  return n;
}

/** what Prong.app is built from: the engine, the window, the interface and their settings */
const BUILT_FROM = ['server/src', 'src', 'App.tsx', 'assets', 'macos/Sources', 'macos/Info.plist', 'macos/build.sh', 'package.json', 'app.json'];

/** whether the sources changed since their last build (false right after the agent ran macos/build.sh itself) */
export function buildOutdated(sources: string): boolean {
  const at = builtAt(builtBundle(sources));
  return !at || BUILT_FROM.some((p) => newest(path.join(sources, p)) > at);
}

/**
 * Runs `macos/build.sh` in the sources, its lines to `onLine`. PRONG_APP_BUILD_CMD stands in for it (tests), run
 * by sh in the sources. The PATH keeps the engine's own (Homebrew's node and npx) with this Node as a fallback.
 */
export async function buildApp(sources: string, onLine: (l: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  const custom = process.env.PRONG_APP_BUILD_CMD;
  const script = path.join(sources, 'macos', 'build.sh');
  if (!custom && !existsSync(script)) throw new Error(`Cannot build Prong: ${script} is missing`);
  const [cmd, args] = custom ? ['/bin/sh', ['-c', custom]] : ['/bin/bash', [script]];
  const env = { ...process.env, CI: '1', PATH: `${process.env.PATH ?? '/usr/bin:/bin'}:${path.dirname(process.execPath)}` };
  const tail: string[] = [];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: sources, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const feed = (b: Buffer) => {
      for (const l of b.toString().split(/\r?\n/)) {
        if (!l.trim()) continue;
        tail.push(l);
        if (tail.length > 30) tail.shift();
        onLine(l);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? -1));
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
  if (signal?.aborted) throw new Error('Stopped');
  if (code !== 0) throw new Error(`Prong.app build failed: ${tail.slice(-6).join('\n').slice(0, 1500) || `exit ${code}`}`);
}

// ---------- what goes over to the next instance ----------

const handoffFile = () => path.join(STATE_DIR(), 'handoff.json');
/** a handoff older than this is a restart that never happened: not brought back */
const HANDOFF_MS = 5 * 60_000;

export function saveHandoff(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const text = JSON.stringify({ at: Date.now(), data });
  if (text.length > 8 * 1024 * 1024) throw Object.assign(new Error('The chat is too large to keep over a restart'), { status: 413 });
  writeFileSync(handoffFile(), text);
}

/** what the instance before handed over, once (it is gone after this) */
export function takeHandoff(now = Date.now()): unknown | null {
  try {
    const raw = JSON.parse(readFileSync(handoffFile(), 'utf8'));
    rmSync(handoffFile(), { force: true });
    return raw && now - raw.at < HANDOFF_MS ? raw.data : null;
  } catch {
    return null;
  }
}

// ---------- the restart ----------

/** the window's process when this engine is the one it started (the parent is the bundle's Contents/MacOS/Prong) */
export function shellPid(bundle: string): number | null {
  try {
    const comm = execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim();
    return comm === path.join(bundle, 'Contents', 'MacOS', 'Prong') || comm.endsWith('.app/Contents/MacOS/Prong') ? process.ppid : null;
  } catch {
    return null;
  }
}

/**
 * Quits this Prong and opens `target` once it is gone. A waiter of its own (it outlives both) opens the app when
 * the window and this engine have exited, so the new one gets the same port and with it the same saved state.
 * The window quits once the work in flight is done (`idle`): a restart never cuts a long pull or LFS download
 * short, however long it takes. An older window ends at once on SIGTERM without stopping its engine, so the engine
 * follows it out.
 */
export function scheduleRestart(target: string, shell: number, idle: () => boolean) {
  const waiter = spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null || kill -0 "$2" 2>/dev/null; do sleep 0.2; done; sleep 0.3; exec /usr/bin/open "$3"', 'prong-restart', String(shell), String(process.pid), target], {
    detached: true,
    stdio: 'ignore',
  });
  waiter.unref();
  const quit = () => {
    if (!idle()) return void setTimeout(quit, 500);
    try {
      process.kill(shell, 'SIGTERM');
    } catch {
      /* already gone */
    }
    const gone = setInterval(() => {
      try {
        process.kill(shell, 0);
      } catch {
        clearInterval(gone);
        process.exit(0);
      }
    }, 100);
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  // the page has handed its chat over already; a moment for its last requests
  setTimeout(quit, 800);
}
