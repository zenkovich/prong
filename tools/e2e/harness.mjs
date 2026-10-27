/**
 * What every end-to-end run starts from, set up when this module is imported: fixture repositories in a temporary
 * folder, an engine of its own on a free port with a temporary state directory, and a headless page on the exported
 * web UI. Nothing touches ~/.prong or the user's repositories.
 *
 * tools/e2e.mjs and each suite in tools/e2e/suites/ import it, so every one of them runs in a process of its own,
 * with its own engine and repositories: suites can run side by side (tools/e2e/run-all.mjs) and alone
 * (`node tools/e2e/suites/<name>.mjs`). Needs a web export (macos/build/web, or E2E_WEB_DIR) and the compiled engine
 * (server/dist). E2E_ONLY=<regex> runs the matching checks only; E2E_SHOTS=<dir> screenshots after every check.
 */
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = process.env.E2E_WEB_DIR ?? path.join(ROOT, 'macos/build/web');
const ENGINE = path.join(ROOT, 'server/dist/src/index.js');
if (!existsSync(path.join(WEB, 'index.html')) || !existsSync(ENGINE)) {
  console.error('e2e: run macos/build.sh first (web export + compiled engine)');
  process.exit(2);
}
/** minimal PNG encoder: solid colour with a diagonal of a second colour, so the two versions differ visibly */
function makePng(w, h, rgb, rgb2) {
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const px = Math.abs(x - y) < 3 ? rgb2 : rgb;
      raw.set(px, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_A = makePng(64, 48, [200, 60, 40], [255, 255, 255]);
const PNG_B = makePng(80, 48, [40, 90, 200], [255, 230, 0]);
const SAME_1 = makePng(64, 48, [30, 160, 90], [255, 255, 255]);
const SAME_2 = makePng(64, 48, [30, 160, 90], [255, 40, 40]);
/** 16-bit mono PCM WAV with a sine tone */
function makeWav(freq, seconds, rate = 8000) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000 * (1 - i / n)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const FIX = path.join(ROOT, 'tools/fixtures');

const tmp = mkdtempSync(path.join(tmpdir(), 'prong-e2e-'));
const state = path.join(tmp, 'state');
const root = path.join(tmp, 'repos');
/**
 * git in a fixture. The engine reads the same repositories in the background (a refresh after an operation runs
 * `git status`, which holds index.lock for a moment): a command that finds the lock taken tries again shortly, and
 * a failure says what git said.
 */
const git = (dir, ...args) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'E2E Author', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E Author', GIT_COMMITTER_EMAIL: 'e2e@example.com' } }).toString();
    } catch (e) {
      const err = String(e?.stderr ?? '');
      if (/index\.lock|\.lock': File exists/.test(err) && attempt < 30) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      e.message = `${e.message.split('\n')[0]}: ${err.trim().split('\n')[0] ?? ''}`;
      throw e;
    }
  }
};
function makeRepo(name) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'img'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  writeFileSync(path.join(dir, 'src.txt'), 'one\ntwo\n');
  mkdirSync(path.join(dir, 'src/nested'), { recursive: true });
  writeFileSync(path.join(dir, 'src/nested/deep.txt'), 'deep\n');
  writeFileSync(path.join(dir, 'img/pixel.png'), PNG_A);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
  writeFileSync(path.join(dir, 'img/pixel.png'), PNG_B);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Change pixel');
  if (name === 'alpha') {
    // every kind of media change: modified (same and different size), deleted, added, audio, video, unplayable, binary
    for (const d of ['media', 'data', 'Assets']) mkdirSync(path.join(dir, d), { recursive: true });
    writeFileSync(path.join(dir, 'img/same.png'), SAME_1);
    writeFileSync(path.join(dir, 'img/old.png'), PNG_A);
    writeFileSync(path.join(dir, 'media/tone.wav'), makeWav(440, 0.5));
    copyFileSync(path.join(FIX, 'clip-a.webm'), path.join(dir, 'media/clip.webm'));
    writeFileSync(path.join(dir, 'data/blob.bin'), Buffer.from(Array.from({ length: 1000 }, (_, i) => (i % 7 === 0 ? 0 : i % 251)))); // NUL bytes: git treats it as binary
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Add media');
    writeFileSync(path.join(dir, 'img/same.png'), SAME_2);
    rmSync(path.join(dir, 'img/old.png'));
    writeFileSync(path.join(dir, 'media/tone.wav'), makeWav(660, 0.8));
    copyFileSync(path.join(FIX, 'clip-b.webm'), path.join(dir, 'media/clip.webm'));
    copyFileSync(path.join(FIX, 'legacy.avi'), path.join(dir, 'media/legacy.avi'));
    writeFileSync(path.join(dir, 'data/blob.bin'), Buffer.from(Array.from({ length: 1500 }, (_, i) => (i % 5 === 0 ? 0 : i % 241))));
    writeFileSync(path.join(dir, 'Assets/scene.meta'), 'guid: 1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Media changes');
    // a TypeScript module, branches, a tag and an origin: sidebar, commit list and line staging checks
    writeFileSync(path.join(dir, 'src/app.ts'), Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\nexport default v0;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Add app module');
    git(dir, 'branch', 'feature/login');
    git(dir, 'branch', 'bugfix/crash');
    git(dir, 'tag', 'v1.0');
    git(dir, 'checkout', '-q', '-b', 'feature/search');
    writeFileSync(path.join(dir, 'search.txt'), 'search\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Search feature work');
    git(dir, 'checkout', '-q', 'main');
    // branches for the batch actions: three merged ones and one with a commit of its own
    for (const b of ['batch/a', 'batch/b', 'batch/c']) git(dir, 'branch', b);
    for (const b of ['batch/wip', 'batch/wip2']) {
      git(dir, 'checkout', '-q', '-b', b, 'main');
      writeFileSync(path.join(dir, `${b.split('/')[1]}.txt`), 'wip\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', b === 'batch/wip' ? 'Batch wip' : 'Batch wip two');
    }
    git(dir, 'checkout', '-q', 'main');
    const origin = path.join(tmp, 'origins/alpha.git');
    mkdirSync(path.dirname(origin), { recursive: true });
    git(tmp, 'init', '-q', '--bare', origin);
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'main', 'feature/search');
    // two neighbouring edits: one hunk, two changed line pairs
    writeFileSync(path.join(dir, 'src/app.ts'), Array.from({ length: 10 }, (_, i) => (i === 3 ? 'const v3 = 30;' : i === 4 ? 'const v4 = 40;' : `const v${i} = ${i};`)).join('\n') + '\nexport default v0;\n');
    writeFileSync(path.join(dir, 'img/new.png'), PNG_B); // untracked: a new image with no previous version
  }
  // working-copy changes: a text edit, a nested new file and an image edit
  writeFileSync(path.join(dir, 'src.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(dir, 'src/nested/new.txt'), 'new\n');
  writeFileSync(path.join(dir, 'img/pixel.png'), PNG_A);
  return dir;
}
mkdirSync(root, { recursive: true });
makeRepo('alpha');
makeRepo('beta');
{
  // beta gets a long history (650 empty commits on main): a branch click has to read more pages of the log.
  // old-start sits on the very first commit, mid-way 50 commits under the tip.
  const beta = path.join(root, 'beta');
  const head = git(beta, 'rev-parse', 'HEAD').trim();
  const t0 = Math.floor(Date.now() / 1000) + 60;
  let stream = '';
  for (let i = 1; i <= 650; i++) {
    const msg = `Filler ${i}`;
    stream += `commit refs/heads/main\nmark :${i}\ncommitter E2E Author <e2e@example.com> ${t0 + i * 60} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}\n${i === 1 ? `from ${head}\n` : ''}\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: beta, input: stream });
  git(beta, 'branch', 'old-start', git(beta, 'rev-list', '--max-parents=0', 'HEAD').trim());
  git(beta, 'branch', 'mid-way', 'main~50');
  // a commit with more files than the engine sends diffs for at once (on its own branch, newest in the history)
  git(beta, 'checkout', '-q', '-b', 'wide');
  for (let i = 0; i < 400; i++) {
    mkdirSync(path.join(beta, `wide/part${i % 5}`), { recursive: true });
    writeFileSync(path.join(beta, `wide/part${i % 5}/file${i}.txt`), `wide line ${i}\n`);
  }
  git(beta, 'add', 'wide');
  execFileSync('git', ['commit', '-q', '-m', 'Wide commit', '--date', new Date((t0 + 700 * 60) * 1000).toISOString()], { cwd: beta, env: { ...process.env, GIT_AUTHOR_NAME: 'E2E Author', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E Author', GIT_COMMITTER_EMAIL: 'e2e@example.com', GIT_COMMITTER_DATE: new Date((t0 + 700 * 60) * 1000).toISOString() } });
  git(beta, 'checkout', '-q', 'main');
  // and 2000 new files in the index (git would list a wholly untracked folder as one entry)
  for (let i = 0; i < 2000; i++) {
    mkdirSync(path.join(beta, `gen/batch${i % 10}`), { recursive: true });
    writeFileSync(path.join(beta, `gen/batch${i % 10}/gen${i}.txt`), `${i}\n`);
  }
  git(beta, 'add', 'gen');
}
for (const n of ['payments-service-backend-api', 'customer-analytics-dashboard', 'mobile-client-ios-and-android']) makeRepo(n);
// a repository with a submodule (the submodule's origin lives outside the scanned folder)
const subOrigin = path.join(tmp, 'origins/core-lib');
mkdirSync(subOrigin, { recursive: true });
git(subOrigin, 'init', '-q', '-b', 'main');
git(subOrigin, 'config', 'commit.gpgsign', 'false');
writeFileSync(path.join(subOrigin, 'core.txt'), 'core\n');
git(subOrigin, 'add', '-A');
git(subOrigin, 'commit', '-q', '-m', 'core');
const sup = makeRepo('superproject');
git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOrigin, 'libs/core');
git(sup, 'commit', '-q', '-m', 'Add core submodule');
// two commits in the submodule, then a commit in the superproject that moves the pointer to them
const coreClone = path.join(sup, 'libs/core');
git(coreClone, 'config', 'commit.gpgsign', 'false');
writeFileSync(path.join(coreClone, 'core.txt'), 'core\none\n');
git(coreClone, 'commit', '-qam', 'core: one');
const coreOne = git(coreClone, 'rev-parse', 'HEAD').trim();
writeFileSync(path.join(coreClone, 'core.txt'), 'core\none\ntwo\n');
git(coreClone, 'commit', '-qam', 'core: two');
git(sup, 'add', 'libs/core');
git(sup, 'commit', '-q', '-m', 'Bump core');
// and one more in the submodule that the superproject has not recorded: a submodule change in Changes
writeFileSync(path.join(coreClone, 'core.txt'), 'core\none\ntwo\nthree\n');
git(coreClone, 'commit', '-qam', 'core: three');
mkdirSync(path.join(root, 'home-root'), { recursive: true });
makeRepo('home-root/gamma');

// Prong's own sources for the agent's interface changes: a small plain folder (no .git: the engine keeps a shadow log)
const appSources = path.join(tmp, 'app-sources');
mkdirSync(path.join(appSources, 'src'), { recursive: true });
writeFileSync(path.join(appSources, 'src/Toolbar.tsx'), 'export const themeButton = true;\n');

// SSH keys for the connection settings: a folder of its own, never the user's ~/.ssh
const sshKeys = path.join(tmp, 'ssh');
mkdirSync(sshKeys, { recursive: true });
for (const k of ['e2e_work', 'e2e_personal']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', k, '-f', path.join(sshKeys, k)]);

// git's global configuration for the engine: the user's own is read (included), but what the engine writes with
// `git config --global` (Preferences → Git identity) lands in this file, never in ~/.gitconfig
const gitGlobal = path.join(tmp, 'gitconfig');
writeFileSync(gitGlobal, `[include]\n\tpath = ${path.join(homedir(), '.gitconfig')}\n\tpath = ${path.join(homedir(), '.config/git/config')}\n`);

/*
 * The engine for this run. Ports stay away from the app's own (8790–8799), and the run only trusts an engine that
 * says it listens on the chosen port: once a taken port let the health check reach the user's running Prong, and
 * the run rewrote the user's workspaces and settings.
 */
let engine;
let engineLog = '';
let port = 0;
/** what the fake agent was asked, and where (tools/fake-claude.sh appends there) */
const agentLog = path.join(tmp, 'agent-prompts.log');
async function spawnEngine(p) {
  const child = spawn(process.execPath, [ENGINE], {
    env: { ...process.env, PRONG_TEST_MODE: '1', PRONG_FAKE_AGENT_LOG: agentLog, PRONG_PORT: String(p), PRONG_STATE_DIR: state, PRONG_SSH_DIR: sshKeys, GIT_CONFIG_GLOBAL: gitGlobal, PRONG_WEB_DIR: WEB, PRONG_SOURCES_DEFAULT: '', PRONG_UI_BUILD_CMD: `sh ${JSON.stringify(path.join(ROOT, 'tools/fake-ui-build.sh'))} {out}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ok = await new Promise((resolve) => {
    const onData = (b) => {
      engineLog += b;
      if (engineLog.includes(`listening on http://127.0.0.1:${p}`)) resolve(true);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => resolve(false));
    setTimeout(() => resolve(false), 20000);
  });
  if (!ok) child.kill('SIGKILL');
  return ok ? child : null;
}
for (let attempt = 0; attempt < 10 && !engine; attempt++) {
  port = 18700 + Math.floor(Math.random() * 1000);
  engine = await spawnEngine(port);
}
if (!engine) throw new Error('the engine did not start:\n' + engineLog);
// a crash of this script must not leave the engine running
process.on('exit', () => {
  try {
    engine.kill('SIGKILL');
  } catch {}
});
const base = `http://127.0.0.1:${port}`;
// the agent is a stand-in that prints Claude Code's stream events (no network, no cost)
await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: { cliPath: path.join(ROOT, 'tools/fake-claude.sh'), sourcesPath: appSources } }) });
// workspaces: work and home both scan `root` (alpha, beta; home-root/gamma is one level deeper), lab scans home-root
await fetch(base + '/api/workspaces', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'work', name: 'work', rootPath: root, scanDepth: 1 }, { id: 'home', name: 'home', rootPath: root, scanDepth: 1 }, { id: 'lab', name: 'lab', rootPath: path.join(root, 'home-root'), scanDepth: 1 }]) });

const exe = process.env.CHROME ?? (() => {
  const cache = path.join(homedir(), 'Library/Caches/ms-playwright');
  try {
    const d = readdirSync(cache).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop();
    const p = d && path.join(cache, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
    return p && existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
})();
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((b) => {
  window.__PRONG_SERVER__ = b;
}, base);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
// avatar lookups answer 404 for unknown authors by design (the UI falls back to initials): not an error
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource.*404/.test(m.text()) && pageErrors.push('console: ' + m.text().slice(0, 200)));

const results = [];
let failed = 0;
const SHOTS = process.env.E2E_SHOTS; // folder for a screenshot after every check (debugging the UI)
/** E2E_ONLY=<regex>: run only the checks whose names match (the others are skipped, not failed) */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, 'i') : null;
/**
 * E2E_REPORT=<dir>: every check leaves a screenshot of how it ended (shots/<suite>-NN.jpg) and the run writes
 * <suite>.json (name, ok, ms, error, shot) — what tools/e2e/report.py turns into the HTML report
 */
const REPORT = process.env.E2E_REPORT;
const SUITE = path.basename(process.argv[1] ?? 'e2e', '.mjs').replace(/^e2e$/, 'main');
const report = [];
async function reportShot() {
  if (!REPORT) return null;
  const file = `${SUITE}-${String(report.length + 1).padStart(3, '0')}.jpg`;
  mkdirSync(path.join(REPORT, 'shots'), { recursive: true });
  const ok = await page.screenshot({ path: path.join(REPORT, 'shots', file), type: 'jpeg', quality: 60 }).then(() => true, () => false);
  return ok ? file : null;
}
async function check(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push(`  ok   ${name}`);
    console.log(results[results.length - 1]);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${String(results.length).padStart(2, '0')}.png`) }).catch(() => {});
    if (REPORT) report.push({ name, ok: true, ms: Date.now() - t0, shot: await reportShot() });
  } catch (e) {
    failed++;
    // the first line, plus Playwright's call log (which locator it was waiting for, what blocked it)
    const lines = String(e?.message ?? e).split('\n');
    const log = lines.filter((l) => /waiting for|intercepts pointer|not stable|not visible|retrying/.test(l)).slice(0, 4);
    results.push(`  FAIL ${name}\n       ${[lines[0], ...log.map((l) => l.trim())].join('\n       ')}`);
    console.log(results[results.length - 1]);
    try {
      await page.screenshot({ path: path.join(tmp, `fail-${results.length}.png`) });
    } catch {}
    if (REPORT) report.push({ name, ok: false, ms: Date.now() - t0, error: lines[0], shot: await reportShot() });
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const text = () => page.evaluate(() => document.body.innerText);
// innerText applies CSS text-transform (labels are upper-case), so text checks ignore case
const visible = async (s) => (await text()).toLowerCase().includes(s.toLowerCase());
const waitText = (s, t = 15000) => page.waitForFunction((s) => document.body.innerText.toLowerCase().includes(s.toLowerCase()), s, { timeout: t });

await page.goto(base + '/', { waitUntil: 'load', timeout: 60000 });

// ---------- helpers every suite uses ----------

const tabBoxesNow = () => page.evaluate(() => [...document.querySelectorAll('[data-testid^="tab-"]')].filter((e) => !/^tab-(group|arrow)-/.test(e.getAttribute('data-testid'))));
/** opens a repository of the current workspace from the start screen */
const openRepo = async (name) => {
  await page.getByTestId('home-button').click();
  await page.getByText(name, { exact: true }).first().click();
  await waitText('All Commits');
};
/** git in the alpha fixture */
const gitOut = (...a) => git(path.join(root, 'alpha'), ...a);
/** the status panel (right of the toolbar) shows text matching `re` (a quick action may come and go unseen) */
const statusHas = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), re.source, { timeout: 15000 });
/** changes made from the command line show up after a refresh (More → Refresh) */
const refreshUi = async () => {
  await page.getByText('More', { exact: true }).first().click();
  await page.getByText('Refresh', { exact: true }).first().click();
  await page.waitForTimeout(600);
};
/** polls `fn` (git state, files) up to `ms`; fails with `what` */
const until = async (fn, what, ms = 10000) => {
  const end = Date.now() + ms;
  while (!(await fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  expect(await fn(), what);
};
/** a call to the engine's API */
const post = async (url, body) => (await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
/** the label of the toolbar's Undo button: "Undo <last action> (⌘Z)" — it names quick actions the status panel may not show */
const undoLabel = () => page.evaluate(() => document.querySelector('[data-testid="undo-button"]')?.getAttribute('aria-label') ?? '');
/**
 * A fresh repository of a suite's own in the scanned folder (one commit of `files`), listed on the start screen.
 * Suites change their own repositories where they can, not the shared fixtures. The page reloads.
 */
async function freshRepo(name, files = { 'README.md': `# ${name}\n` }) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
  // registered as a scan of the workspaces would (work and home scan `root`), then the page reloads to list it
  for (const ws of ['work', 'home']) await post('/api/scan', { path: root, depth: 1, register: true, workspace: ws });
  await page.reload({ waitUntil: 'load' });
  return dir;
}

/** ends the run: closes the browser and the engine, prints the summary, exits 1 when a check failed */
async function finish(label = 'e2e') {
  if (REPORT) writeFileSync(path.join(REPORT, `${SUITE}.json`), JSON.stringify({ suite: SUITE, label, checks: report }, null, 1));
  await browser.close();
  engine.kill('SIGTERM');
  if (failed) {
    // the screenshots stay (a folder of their own); the repositories, state and keys go unless E2E_KEEP is set —
    // a failing run used to leave 36 MB behind each time
    let where = tmp;
    if (!process.env.E2E_KEEP) {
      where = mkdtempSync(path.join(tmpdir(), `prong-e2e-shots-${label}-`));
      for (const f of readdirSync(tmp)) if (f.endsWith('.png')) copyFileSync(path.join(tmp, f), path.join(where, f));
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${label}: ${failed} failed · screenshots in ${where}\n--- engine log ---\n${engineLog.slice(-2000)}`);
    process.exit(1);
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${label}: ${results.length} checks passed`);
}

export {
  ROOT, WEB, FIX, PNG_A, PNG_B, SAME_1, SAME_2, makePng, makeWav,
  tmp, state, root, git, makeRepo, sup, coreClone, coreOne, appSources, sshKeys, gitGlobal, agentLog,
  base, port, engineLog, browser, page, pageErrors, results,
  check, expect, text, visible, waitText, SHOTS,
  tabBoxesNow, openRepo, gitOut, statusHas, refreshUi, until, post, undoLabel, freshRepo, finish,
};
