#!/usr/bin/env node
/**
 * End-to-end checks of the real UI against the real engine, headless.
 *
 *   npm run e2e            (needs a web export in macos/build/web and the compiled engine in server/dist,
 *                           i.e. after macos/build.sh; CHROME may point at a chromium binary, otherwise
 *                           Playwright's own chromium is used)
 *
 * The run starts an engine on a free port with a temporary state directory, builds a fixture repository
 * with text and image changes, and drives the exported web UI through Playwright. Nothing touches
 * ~/.prong or the user's repositories.
 */
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'E2E Author', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E Author', GIT_COMMITTER_EMAIL: 'e2e@example.com' } }).toString();
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
    env: { ...process.env, PRONG_TEST_MODE: '1', PRONG_FAKE_AGENT_LOG: agentLog, PRONG_PORT: String(p), PRONG_STATE_DIR: state, PRONG_SSH_DIR: sshKeys, PRONG_WEB_DIR: WEB, PRONG_SOURCES_DEFAULT: '', PRONG_UI_BUILD_CMD: `sh ${JSON.stringify(path.join(ROOT, 'tools/fake-ui-build.sh'))} {out}` },
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
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
    console.log(results[results.length - 1]);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${String(results.length).padStart(2, '0')}.png`) }).catch(() => {});
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

await check('welcome: work workspace lists the scanned top-level repositories only', async () => {
  await waitText('alpha');
  await waitText('beta');
  expect(!(await visible('gamma')), 'gamma (depth 2) must not be listed in work');
  expect(await visible('@work'), 'workspace name shown');
});

await check('workspaces: two workspaces scanning the same folder show the same repositories, a rescan changes nothing', async () => {
  await page.getByText('@home', { exact: true }).first().click();
  await waitText('alpha');
  await waitText('beta');
  expect(!(await visible('gamma')), 'gamma (depth 2) must not be listed in home');
  await page.getByText('Rescan', { exact: true }).first().click();
  await waitText('Scanned');
  const t = await text();
  expect(t.toLowerCase().includes('6 repositories'), 'rescan reports the shared count, got: ' + t.split('\n').find((l) => l.includes('Scanned')));
  expect(await visible('alpha') && await visible('beta'), 'still both after the rescan');
  await page.getByText('@work', { exact: true }).first().click();
  await waitText('alpha');
  await waitText('beta');
  await page.getByText('Rescan', { exact: true }).first().click();
  await waitText('Scanned');
  await page.getByText('@home', { exact: true }).first().click();
  await waitText('alpha');
  await waitText('beta');
  await page.getByText('@lab', { exact: true }).first().click();
  await waitText('gamma');
  expect(!(await visible('alpha')), 'alpha must not be listed in lab');
  await page.getByText('@work', { exact: true }).first().click();
  await waitText('alpha');
});

await check('notifications: shown inline in the status strip, no floating toast', async () => {
  const floating = await page.evaluate(() => [...document.querySelectorAll('[data-glass]')].filter((e) => e.textContent?.includes('Scanned')).length);
  expect(floating === 0, 'no glass toast cards');
});

await check('repository: opens, sidebar and graph render, status bar shows the branch', async () => {
  await page.getByText('alpha', { exact: true }).first().click();
  await waitText('All Commits');
  await waitText('Change pixel');
  await waitText('main');
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

await check('changes: tree view is the default and nested files appear under folders', async () => {
  await page.getByText('Changes', { exact: true }).first().click();
  await waitText('src.txt');
  await waitText('nested');
  expect(await visible('new.txt'), 'nested file visible in the tree');
});

await check('image diff: the working-copy image shows BEFORE and AFTER without crashing', async () => {
  await page.getByText('pixel.png', { exact: true }).first().click();
  await waitText('BEFORE');
  await waitText('AFTER');
  await page.waitForFunction(() => document.querySelectorAll('img[src*="/api/blob"]').length >= 2, null, { timeout: 15000 });
  expect(!(await visible('crashed')), 'no crash fallback');
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

await check('image diff: a committed image diff loads its sides on demand (the former black-screen crash)', async () => {
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByText('Change pixel', { exact: true }).first().click();
  await waitText('pixel.png');
  await page.getByText('pixel.png', { exact: true }).last().click();
  await waitText('BEFORE');
  await page.waitForFunction(() => document.querySelectorAll('img[src*="/api/blob"]').length >= 2, null, { timeout: 15000 });
  expect((await text()).includes('Prong hit an error') === false, 'root boundary not shown');
  expect(!(await visible('crashed')), 'no panel crash fallback');
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

await check('image diff: swipe and onion skin modes switch without errors', async () => {
  await page.getByText('Swipe', { exact: true }).first().click();
  await page.waitForTimeout(200);
  await page.getByText('Onion skin', { exact: true }).first().click();
  await page.waitForTimeout(200);
  await page.getByText('Side by side', { exact: true }).first().click();
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

const openCommitFile = async (subject, file) => {
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByText(subject, { exact: true }).first().click();
  await waitText(file);
  await page.getByText(file, { exact: true }).last().click();
};
const paneBox = async (sel = '[data-pane]') => page.locator(sel).first().boundingBox();
const zoomText = async () => (await text()).match(/(\d+)%\s*\n/)?.[1];
const layerTransform = () => page.evaluate(() => [...document.querySelectorAll('[data-pane] div')].find((d) => d.style.transform)?.style.transform ?? '');

await check('image compare: modes appear only when both versions exist; Difference only for equal sizes', async () => {
  await openCommitFile('Change pixel', 'pixel.png');
  await waitText('Swipe');
  expect(!(await visible('Difference')), 'no Difference for 64×48 vs 80×48');
  await openCommitFile('Media changes', 'same.png');
  await waitText('Difference');
  await openCommitFile('Media changes', 'old.png');
  await waitText('removed in this change');
  await waitText('BEFORE · deleted');
  expect(!(await visible('Swipe')), 'no modes for a deleted image');
});

await check('image compare: untracked image is shown as new, with no previous version', async () => {
  await page.getByText('Changes', { exact: true }).first().click();
  await page.getByText('new.png', { exact: true }).first().click();
  await waitText('no previous version');
  await waitText('AFTER · new file');
  expect(!(await visible('Onion skin')), 'no modes for an added image');
});

await check('image compare: ctrl/⌘ wheel and pinch zoom, scroll and drag pan, double-click 1:1', async () => {
  await openCommitFile('Media changes', 'same.png');
  await page.waitForFunction(() => document.querySelectorAll('[data-pane] img').length >= 2, null, { timeout: 15000 });
  const z0 = Number(await zoomText());
  const b = await paneBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const wheel = (o) => page.evaluate(({ o, cx, cy }) => document.querySelector('[data-pane]').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, ...o })), { o, cx, cy });
  await wheel({ deltaY: -40, ctrlKey: true });
  await page.waitForTimeout(100);
  const z1 = Number(await zoomText());
  expect(z1 > z0, `ctrl+wheel zooms in: ${z0}% → ${z1}%`);
  await wheel({ deltaY: 30, metaKey: true });
  await page.waitForTimeout(100);
  expect(Number(await zoomText()) < z1, '⌘+wheel down zooms out');
  // WebKit trackpad pinch
  await page.evaluate(({ cx, cy }) => {
    const el = document.querySelector('[data-pane]');
    const ev = (type, scale) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: cx, clientY: cy });
    el.dispatchEvent(ev('gesturestart', 1));
    el.dispatchEvent(ev('gesturechange', 2));
  }, { cx, cy });
  await page.waitForTimeout(100);
  const z2 = Number(await zoomText());
  expect(z2 > z1 * 1.2, `pinch zooms in: ${z2}%`);
  const t0 = await layerTransform();
  await wheel({ deltaX: 40, deltaY: 25 });
  await page.waitForTimeout(100);
  const t1 = await layerTransform();
  expect(t1 !== t0, 'two-finger scroll pans');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 30, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect((await layerTransform()) !== t1, 'drag pans');
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(100);
  expect((await zoomText()) === '100', 'double-click goes to 1:1, got ' + (await zoomText()));
  await page.getByText('Fit', { exact: true }).first().click();
});

await check('image compare: in Swipe the divider follows the cursor', async () => {
  await page.getByText('Swipe', { exact: true }).first().click();
  await page.waitForSelector('[data-divider]');
  const b = await paneBox();
  const at = async (f) => {
    await page.mouse.move(b.x + b.width * f, b.y + b.height / 2);
    await page.waitForTimeout(80);
    return page.evaluate(() => parseFloat(document.querySelector('[data-divider]').style.left));
  };
  const l1 = await at(0.25);
  const l2 = await at(0.7);
  expect(Math.abs(l1 + 1 - b.width * 0.25) < 4, `divider at 25%: ${l1} of ${b.width}`);
  expect(Math.abs(l2 + 1 - b.width * 0.7) < 4, `divider at 70%: ${l2} of ${b.width}`);
  await page.getByText('Side by side', { exact: true }).first().click();
});

await check('audio: both versions with waveforms, durations and linked playback', async () => {
  await openCommitFile('Media changes', 'tone.wav');
  await page.waitForFunction(() => document.querySelectorAll('audio').length === 2 && document.querySelectorAll('[data-waveform]').length === 2, null, { timeout: 15000 });
  await waitText('0:00.50');
  await waitText('0:00.80');
  await waitText('Link playback');
  await waitText('duration +0.30 s');
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

await check('video: both versions load, resolution change is reported', async () => {
  await openCommitFile('Media changes', 'clip.webm');
  await page.waitForFunction(() => document.querySelectorAll('video').length === 2, null, { timeout: 15000 });
  await waitText('resolution 160×90 → 192×108');
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

await check('unplayable format and plain binaries: explained, never a crash', async () => {
  await openCommitFile('Media changes', 'legacy.avi');
  await waitText("can't be played here");
  await waitText('new file');
  await openCommitFile('Media changes', 'blob.bin');
  await waitText('Binary file changed');
  await waitText('1000 B → 1.5 KB (+500 B)');
  expect(!(await visible('crashed')) && !(await visible('Preview failed')), 'no crash card');
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

await check('file icons: theme icons by type and folder, the OS icon for unknown types', async () => {
  await openCommitFile('Media changes', 'tone.wav');
  const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="file-icon-"],[data-testid^="folder-icon-"]')].map((e) => e.getAttribute('data-testid')));
  for (const id of ['file-icon-audio', 'file-icon-video', 'file-icon-image']) expect(ids.includes(id), `${id} in ${ids.join(',')}`);
  expect(ids.some((i) => i.startsWith('folder-icon-folder-')), 'a named folder icon: ' + ids.join(','));
  expect(ids.includes('file-icon-system-meta'), 'unknown .meta asks the OS: ' + ids.join(','));
  const sys = await fetch(base + '/api/fileicon?ext=meta');
  expect(process.platform !== 'darwin' || sys.status === 200, 'macOS answers with an icon: ' + sys.status);
  const svg = await fetch(base + '/file-icons/audio.svg');
  expect(svg.status === 200 && (await svg.text()).includes('<svg'), 'bundled icons are served');
});

await check('avatars: the engine is asked for the author avatar and initials stay as the fallback', async () => {
  const r = await fetch(base + '/api/avatar?email=e2e@example.com');
  expect(r.status === 404 || r.status === 200, 'avatar endpoint answers');
  expect(await visible('E2E Author'), 'author shown');
});

await check('preferences: list/tree choice is remembered across a reload', async () => {
  await page.getByText('Changes', { exact: true }).first().click();
  await waitText('src.txt');
  // the list/tree switch of the Unstaged section
  await page.locator('[aria-label="list"]').filter({ has: page.locator('svg') }).nth(await page.evaluate(() => {
    const segs = [...document.querySelectorAll('[aria-label="list"]')];
    const header = [...document.querySelectorAll('div')].find((d) => d.textContent === 'Unstaged' || d.textContent === 'UNSTAGED');
    const hy = header?.getBoundingClientRect().y ?? 0;
    return Math.max(0, segs.findIndex((e) => Math.abs(e.getBoundingClientRect().y - hy) < 20));
  })).click();
  await page.waitForTimeout(500);
  const s = await fetch(base + '/api/settings').then((x) => x.json());
  expect(s.ui.fileView === 'list', 'engine settings hold fileView=list, got ' + s.ui.fileView);
  await page.reload({ waitUntil: 'load' });
  await waitText('alpha');
  const s2 = await fetch(base + '/api/settings').then((x) => x.json());
  expect(s2.ui.fileView === 'list', 'still list after reload');
});

const tabBoxesNow = () => page.evaluate(() => [...document.querySelectorAll('[data-testid^="tab-"]')].filter((e) => !/^tab-(group|arrow)-/.test(e.getAttribute('data-testid'))));
const openRepo = async (name) => {
  await page.getByTestId('home-button').click();
  await page.getByText(name, { exact: true }).first().click();
  await waitText('All Commits');
};

await check('agent bar: without a repository it says so in a notice', async () => {
  // a launch with no tabs (tabs now come back from the saved session, so start from an empty one)
  // leave the page first: its pending session save (half a second after a change) must not land after the reset
  await page.goto('about:blank');
  await fetch(base + '/api/session', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  await page.goto(base, { waitUntil: 'load' });
  await waitText('alpha');
  expect((await tabBoxesNow()).length === 0, 'no tabs');
  await page.getByTestId('agent-button').click();
  await page.getByTestId('agent-input').fill('создай ветку feature/x');
  await page.getByTestId('agent-input').press('Enter');
  await page.getByTestId('agent-notice').first().waitFor({ timeout: 5000 });
  await waitText('No repository open');
  await page.getByTestId('agent-notice-close').first().click();
  await page.keyboard.press('Escape');
});

await check('agent bar: unfolds into a command line, shows live status, leaves a notice until closed', async () => {
  await openRepo('alpha');
  if (!(await page.getByTestId('agent-input').count())) await page.getByTestId('agent-button').click();
  const input = page.getByTestId('agent-input');
  await input.waitFor({ timeout: 5000 });
  await input.fill('покажи последние коммиты');
  await input.press('Enter');
  const status = page.getByTestId('agent-status');
  await status.waitFor({ timeout: 5000 });
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    if (!(await status.count())) break;
    seen.add(await status.innerText().catch(() => ''));
    await page.waitForTimeout(100);
  }
  expect([...seen].some((x) => /Reading store\.ts|Type-checking|Thinking/.test(x)), 'status line followed the agent: ' + [...seen].join(' | '));
  if (SHOTS) await page.getByTestId('agent-notice').first().waitFor({ timeout: 10000 }).then(() => page.screenshot({ path: path.join(SHOTS, 'agent-notice.png') })).catch(() => {});
  await page.getByTestId('agent-notice').first().waitFor({ timeout: 10000 });
  await waitText('Done: checked src/state/store.ts');
  await page.waitForTimeout(1500);
  expect(await page.getByTestId('agent-notice').count() === 1, 'the notice stays');
  await page.getByTestId('agent-notice-close').first().click();
  await page.waitForTimeout(200);
  expect(await page.getByTestId('agent-notice').count() === 0, 'closed by hand');
});

await check('agent bar: the stop button ends a running agent', async () => {
  if (!(await page.getByTestId('agent-input').count())) await page.getByTestId('agent-button').click();
  await page.getByTestId('agent-input').fill('slow task');
  await page.getByTestId('agent-input').press('Enter');
  await page.waitForFunction(() => /Type-checking/.test(document.querySelector('[data-testid="agent-status"]')?.textContent ?? ''), null, { timeout: 8000 });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'agent-busy.png'), clip: { x: 0, y: 0, width: 1440, height: 120 } });
  await page.getByTestId('agent-stop').click();
  await page.getByTestId('agent-notice').first().waitFor({ timeout: 8000 });
  await waitText('Stopped');
  await page.getByTestId('agent-notice-close').first().click();
});

await check('agent bar: expands into the full chat window and folds back', async () => {
  if (!(await page.getByTestId('agent-input').count())) await page.getByTestId('agent-button').click();
  await page.getByTestId('agent-expand').click();
  await waitText('Prong поставляется');
  await waitText('Done: checked src/state/store.ts'); // the earlier run is in the chat history
  await page.getByTestId('agent-fold').click();
  await page.getByTestId('agent-input').waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');
});

await check('shortcuts work while typing: ⌘K from the commit message, ⌘⇧J from the chat input', async () => {
  await openRepo('alpha');
  await page.getByText('Changes', { exact: true }).first().click();
  const summary = page.getByPlaceholder('Commit summary');
  await summary.click();
  await summary.type('wip');
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('input[placeholder="type a command"]', { timeout: 3000 });
  // the palette is driven from its own input: arrows move, Enter runs, Esc closes
  await page.keyboard.type('all commits');
  await page.keyboard.press('Enter');
  await waitText('Media changes');
  expect(!(await page.locator('input[placeholder="type a command"]').count()), 'Enter ran the command and closed the palette');
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('input[placeholder="type a command"]', { timeout: 3000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(!(await page.locator('input[placeholder="type a command"]').count()), 'Esc closes the palette from its input');
  await page.keyboard.press('Meta+Shift+J');
  await waitText('Prong поставляется');
  await page.locator('input[placeholder*="команда для репозитория"]').first().click();
  await page.keyboard.press('Meta+Shift+J');
  await page.waitForTimeout(300);
  expect(!(await visible('Prong поставляется')), 'the chat window closes from its own input');
});

await check('agent panel: chat text is selectable', async () => {
  await page.keyboard.press('Meta+Shift+J');
  await waitText('Prong поставляется');
  const sel = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div,span')].find((e) => e.textContent?.startsWith('Prong поставляется') && e.children.length === 0);
    return el ? getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect : 'missing';
  });
  expect(sel === 'text', 'user-select on chat text is ' + sel);
  await page.keyboard.press('Meta+Shift+J');
});

const tabBoxes = () => page.evaluate(() => [...document.querySelectorAll('[data-testid^="tab-"]')].filter((e) => !/^tab-(group|arrow)-/.test(e.getAttribute('data-testid'))).map((e) => ({ id: e.getAttribute('data-testid').slice(4), ...e.getBoundingClientRect().toJSON() })));

await check('tabs: a submodule tab sits in a framed group with its parent, points back at it, folds only by hand', async () => {
  await openRepo('alpha');
  await openRepo('superproject');
  await page.getByTestId('submodule-libs/core').click(); // sidebar → Submodules, tree view: libs / core
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tab-libs/core"]'), null, { timeout: 10000 });
  let ids = (await tabBoxes()).map((x) => x.id);
  expect(ids.indexOf('libs/core') === ids.indexOf('superproject') + 1, 'sub-tab right after its parent: ' + ids.join(','));
  expect((await page.getByTestId('tab-arrow-libs/core').innerText()) === '←', 'the sub-tab points at its parent');
  const frame = await page.evaluate(() => {
    const g = document.querySelector('[data-testid="tab-group-superproject"]');
    const cs = g && getComputedStyle(g);
    return g ? { border: cs.borderTopWidth, holds: ['tab-superproject', 'tab-libs/core'].every((id) => g.querySelector(`[data-testid="${id}"]`)) } : null;
  });
  expect(frame && frame.border === '1px' && frame.holds, 'one frame around parent and submodule: ' + JSON.stringify(frame));
  // names are not cut while the bar has room
  const full = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="tab-"]')].filter((e) => !/^tab-(group|arrow)-/.test(e.getAttribute('data-testid'))).map((e) => { const label = [...e.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent && d.textContent.length > 2); return { id: e.getAttribute('data-testid'), sw: label ? label.scrollWidth : 0, cw: label ? label.clientWidth : 0 }; }));
  expect(full.every((f) => f.sw <= f.cw + 1), 'labels fit: ' + JSON.stringify(full));
  await page.getByTestId('tab-alpha').click();
  await page.waitForTimeout(200);
  ids = (await tabBoxes()).map((x) => x.id);
  expect(ids.includes('libs/core'), 'the group stays open when another repository is active: ' + ids.join(','));
  await page.getByTestId('tab-group-toggle-superproject').click();
  await page.waitForTimeout(200);
  ids = (await tabBoxes()).map((x) => x.id);
  expect(!ids.includes('libs/core') && (await page.getByTestId('tab-group-toggle-superproject').innerText()).includes('+1'), 'folded by hand into "+1": ' + ids.join(','));
  await page.getByTestId('tab-group-toggle-superproject').click();
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tab-libs/core"]'), null, { timeout: 5000 });
});

await check('tabs: widths fit the bar, long names shrink, the active tab stays visible', async () => {
  await page.setViewportSize({ width: 1100, height: 900 });
  for (const n of ['payments-service-backend-api', 'customer-analytics-dashboard', 'mobile-client-ios-and-android', 'beta']) await openRepo(n);
  await page.waitForTimeout(300);
  const boxes = await tabBoxes();
  const right = Math.max(...boxes.map((b) => b.right));
  const agentBox = () => page.locator('[data-testid="agent-button"], [data-testid="agent-bar"]').first().boundingBox();
  const agent = await agentBox();
  expect(right <= agent.x, `tabs end before the agent: ${right} vs ${agent.x}`);
  const long = boxes.find((b) => b.id === 'mobile-client-ios-and-android');
  expect(!long || (long.width < 47 + 29 * 6.9 && long.width >= 96), 'long name shrunk, not below the minimum: ' + long?.width);
  await page.setViewportSize({ width: 760, height: 900 });
  await page.waitForTimeout(400);
  const active = (await tabBoxes()).find((b) => b.id === 'beta');
  const agent2 = await agentBox();
  expect(active && active.left >= 0 && active.right <= agent2.x + 1, 'active tab visible in a narrow window: ' + JSON.stringify(active));
  await page.setViewportSize({ width: 1440, height: 900 });
});

await check('crash containment: an error thrown outside React opens the error dialog with its stack, the UI stays', async () => {
  // simulate a thrown error from an event handler: the global handler reports it, the UI stays
  await page.evaluate(() => setTimeout(() => { throw new Error('e2e synthetic error'); }, 0));
  await page.getByTestId('error-dialog').waitFor({ timeout: 5000 });
  expect((await page.getByTestId('error-title').innerText()) === 'Unexpected error', 'title');
  expect((await page.getByTestId('error-detail').innerText()).includes('e2e synthetic error'), 'the message in full');
  await page.keyboard.press('Escape');
  await page.getByTestId('error-dialog').waitFor({ state: 'detached', timeout: 3000 });
  expect(await visible('All Commits') || await visible('alpha'), 'UI still rendered');
  // the status bar keeps a way back to it
  await page.getByTestId('error-log-button').click();
  await page.getByTestId('error-dialog').waitFor({ timeout: 3000 });
  await page.getByTestId('error-close').click();
  await page.getByTestId('error-dialog').waitFor({ state: 'detached', timeout: 3000 });
});

const gitOut = (...a) => git(path.join(root, 'alpha'), ...a);

await check('header: the workspace button has no frame, its menu is short, no colour-scheme button', async () => {
  const border = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="workspace-button"]')).borderTopWidth);
  expect(border === '0px', 'no frame: ' + border);
  await page.getByTestId('workspace-button').click();
  const menu = await page.getByTestId('workspace-menu').locator('..').innerText();
  for (const s of ['@work', '@home', '@lab', 'New workspace', 'settings']) expect(menu.includes(s), `menu has ${s}: ${menu}`);
  for (const s of ['Delete', 'Rescan', 'repos ·', 'open tab']) expect(!menu.includes(s), `menu has no ${s}`);
  await page.keyboard.press('Escape');
  expect((await page.locator('[aria-label="Colour scheme"]').count()) === 0, 'no colour-scheme button');
});

await check('sidebar: a separator under Changes / All Commits, a branch filter, clickable + buttons', async () => {
  await openRepo('alpha');
  expect((await page.getByTestId('sidebar-separator').count()) === 1, 'separator');
  const filter = page.getByPlaceholder('filter branches');
  await filter.fill('login');
  await page.waitForTimeout(200);
  const branchesText = (await page.getByTestId('group-branches').innerText()).toLowerCase();
  expect(branchesText.includes('login') && !branchesText.includes('bugfix') && !branchesText.includes('search'), 'only matching branches: ' + branchesText);
  await filter.fill('search');
  await page.waitForTimeout(200);
  const remotes = await page.getByTestId('group-remotes').innerText();
  expect(remotes.toLowerCase().includes('search'), 'remote branches show (group opened by the filter): ' + remotes);
  await filter.fill('');
  // the + of the Branches group stays put when the pointer moves onto it
  await page.getByText('Branches', { exact: true }).first().hover();
  await page.locator('[aria-label="New branch"]').first().hover();
  await page.locator('[aria-label="New branch"]').first().click();
  await page.locator('input[placeholder="feature/…"]').fill('feature/from-plus');
  await page.locator('input[placeholder="feature/…"]').press('Enter');
  await waitText('from-plus');
  expect(gitOut('branch', '--list', 'feature/from-plus').includes('feature/from-plus'), 'branch created');
  gitOut('checkout', '-q', 'main');
});

await check('sidebar: deleting a remote branch removes it from the list (and from the remote)', async () => {
  const filter = page.getByPlaceholder('filter branches');
  await filter.fill('search');
  await page.waitForTimeout(300);
  const remoteRow = page.getByTestId('group-remotes').getByText('search', { exact: true });
  await remoteRow.click({ button: 'right' });
  await page.getByText('Delete remote branch', { exact: true }).first().click();
  await page.getByText('Delete', { exact: true }).last().click(); // confirm
  await page.waitForFunction(() => !(document.querySelector('[data-testid="group-remotes"]')?.textContent ?? '').includes('search'), null, { timeout: 10000 });
  expect(!gitOut('branch', '-r').includes('origin/feature/search'), 'remote-tracking ref gone');
  expect(gitOut('branch', '--list', 'feature/search').includes('feature/search'), 'the local branch stays');
  await filter.fill('');
});

await check('commit list: HEAD in bold, commits off the current branch grey, a cloud on branches that are on origin', async () => {
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.waitForSelector('[data-testid="head-commit"]');
  const head = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="head-commit"]');
    return { text: e.textContent, family: getComputedStyle(e).fontFamily, weight: getComputedStyle(e).fontWeight };
  });
  expect(head.text === 'Add app module' && /Bold|700/.test(head.family + head.weight), 'HEAD bold: ' + JSON.stringify(head));
  const off = await page.evaluate(() => [...document.querySelectorAll('[data-testid="off-branch-commit"]')].map((e) => e.textContent));
  expect(off.includes('Search feature work') && !off.includes('Add app module'), 'grey off-branch commits: ' + off.join(','));
  expect((await page.getByTestId('ref-cloud-main').count()) >= 1, 'main carries the origin cloud');
});

await check('the selected commit keeps its graph node visible; a published branch shows a cloud in the sidebar', async () => {
  await page.getByText('Add app module', { exact: true }).first().click();
  const g = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="selected-commit"]');
    const svg = [...document.querySelectorAll('[data-testid="commit-scroll"] svg')].find((x) => x.querySelector('polygon, rect'));
    if (!row || !svg) return null;
    const r = row.getBoundingClientRect();
    // the graph is drawn after (above) the rows, and the selected row's node has a dark ring under it
    const above = !!(row.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING);
    const ring = [...svg.querySelectorAll('polygon, rect')].some((p) => {
      const b = p.getBoundingClientRect();
      return b.height >= 13 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1;
    });
    return { above, ring, pe: getComputedStyle(svg.parentElement).pointerEvents };
  });
  expect(g && g.above && g.ring, 'graph above the selected row with a ring: ' + JSON.stringify(g));
  // clicks in the graph column still reach the rows
  const target = await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="commit-scroll"]').getBoundingClientRect();
    const leaf = [...document.querySelectorAll('[data-testid="commit-scroll"] div')].find((d) => d.children.length === 0 && d.textContent === 'Media changes');
    const r = leaf.getBoundingClientRect();
    return { x: sc.left + 12, y: r.top + r.height / 2 };
  });
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(() => (document.querySelector('[data-testid="selected-commit"]')?.innerText ?? '').includes('Media changes'), null, { timeout: 3000 });
  // main tracks origin/main: a cloud next to it in the sidebar; feature/login was never pushed: none
  expect((await page.getByTestId('branch-cloud-main').count()) === 1, 'cloud on main');
  expect((await page.getByTestId('branch-cloud-feature/login').count()) === 0, 'no cloud on an unpublished branch');
});

await check('commit details: description on top, files on the left, diff on the right', async () => {
  await page.getByText('Add app module', { exact: true }).first().click();
  await page.getByText('app.ts', { exact: true }).last().click();
  const d = await page.getByTestId('commit-description').boundingBox();
  const files = await page.getByText('Files', { exact: true }).last().boundingBox();
  const diff = await page.getByText('src/app.ts', { exact: true }).last().boundingBox();
  expect(files.y > d.y + d.height - 2, 'files below the description');
  expect(diff.x > files.x + 100 && diff.y > d.y + d.height - 2, 'diff to the right, below the description');
  expect(d.width > diff.x - d.x, 'description spans over the diff column too: ' + JSON.stringify({ d, diff }));
});

await check('syntax highlighting: keywords and numbers coloured in a TypeScript diff', async () => {
  const colours = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('div, span')].filter((e) => e.children.length === 0);
    const of = (txt) => spans.find((e) => e.textContent === txt) && getComputedStyle(spans.find((e) => e.textContent === txt)).color;
    return { kw: of('const'), num: of('0'), plain: of('v0') ?? of(' v0 ') };
  });
  expect(colours.kw && colours.num && colours.kw !== colours.num, 'distinct token colours: ' + JSON.stringify(colours));
});

await check('changes: the commit box sits under the diff; the button menu switches to commit and push', async () => {
  await page.getByText('Changes', { exact: true }).first().click();
  await page.getByText('app.ts', { exact: true }).first().click();
  await waitText('const v3 = 30;');
  const box = await page.getByTestId('commit-box').boundingBox();
  const unstagedHeader = await page.getByText('Unstaged', { exact: true }).first().boundingBox();
  const diffHeader = await page.getByText('src/app.ts', { exact: true }).last().boundingBox();
  expect(box.x > unstagedHeader.x + 150, 'commit box in the right column');
  expect(box.y > diffHeader.y + 40, 'below the diff');
  await page.getByTestId('commit-menu').click();
  await page.getByText(/^\s*✓?\s*Commit and push\s*$/).last().click();
  await page.waitForTimeout(200);
  expect((await page.getByTestId('commit-button').innerText()).toLowerCase().includes('commit & push'), 'button follows the choice');
  await page.getByTestId('commit-menu').click();
  await page.getByText(/^\s*Commit\s*$/).last().click();
  await page.waitForTimeout(150);
  expect((await page.getByTestId('commit-button').innerText()).trim().toLowerCase() === 'commit', 'back to plain commit');
});

await check('line staging: pick one changed line pair, stage just it, then unstage it again', async () => {
  // the hunk has "-const v3 = 3; -const v4 = 4; +const v3 = 30; +const v4 = 40;": pick the v3 pair
  await page.getByText('const v3 = 3;', { exact: true }).first().click();
  await page.getByText('const v3 = 30;', { exact: true }).first().click();
  await page.getByTestId('stage-lines').click();
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('staged') , null, { timeout: 5000 });
  await page.waitForTimeout(800);
  const cached = gitOut('diff', '--cached', '--', 'src/app.ts');
  expect(cached.includes('+const v3 = 30;') && !cached.includes('v4 = 40'), 'only the v3 pair staged:\n' + cached);
  const rest = gitOut('diff', '--', 'src/app.ts');
  expect(rest.includes('+const v4 = 40;') && !rest.includes('+const v3 = 30;'), 'v4 still unstaged:\n' + rest);
  // unstage the added line again from the staged side
  await page.getByText('app.ts', { exact: true }).last().click();
  await page.getByText('const v3 = 30;', { exact: true }).first().click();
  await page.getByText('const v3 = 3;', { exact: true }).first().click();
  await page.getByTestId('unstage-lines').click();
  await page.waitForTimeout(800);
  expect(gitOut('diff', '--cached', '--', 'src/app.ts').trim() === '', 'nothing staged any more');
});

await check('submodules: shown as a tree by default, list on request', async () => {
  await openRepo('superproject');
  await page.waitForSelector('[data-testid="submodule-libs/core"]');
  expect((await page.getByTestId('submodule-libs/core').innerText()) === 'core', 'tree: leaf name under the libs folder');
  await page.getByTestId('group-submodules').locator('[aria-label="list"]').first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="submodule-libs/core"]')?.textContent === 'libs/core', null, { timeout: 3000 });
  await page.getByTestId('group-submodules').locator('[aria-label="tree"]').first().click();
});

// ---------- branch clicks, the Fork-style branch filter, resizable commit box and description ----------
const scrollTop = () => page.evaluate(() => document.querySelector('[data-testid="commit-scroll"]')?.scrollTop ?? 0);
/** the selected commit row carries `subject` and sits inside the visible part of the history */
const waitSelectedInView = (subject) =>
  page.waitForFunction(
    (subject) => {
      const sc = document.querySelector('[data-testid="commit-scroll"]')?.getBoundingClientRect();
      const row = document.querySelector('[data-testid="selected-commit"]');
      if (!sc || !row) return false;
      const r = row.getBoundingClientRect();
      return row.innerText.includes(subject) && r.top >= sc.top - 1 && r.bottom <= sc.bottom + 1;
    },
    subject,
    { timeout: 15000 },
  );
const commitCount = async () => Number((await text()).match(/of (\d+) commits/)?.[1] ?? 0);
const funnelShown = (name) =>
  page.evaluate((name) => {
    const el = document.querySelector(`[data-testid="funnel-${name}"]`);
    return !!el && [...el.querySelectorAll('div')].every((d) => getComputedStyle(d).opacity !== '0');
  }, name);
const dragBy = async (testId, dy) => {
  const b = await page.getByTestId(testId).boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x, y + (dy * i) / 6);
  await page.mouse.up();
  await page.waitForTimeout(150);
};

await check('branch click: selects the commit of the branch and scrolls the history to it', async () => {
  await openRepo('beta');
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.waitForSelector('[data-testid="branch-mid-way"]');
  const before = await scrollTop();
  await page.getByTestId('branch-mid-way').click();
  await waitSelectedInView('Filler 600');
  const after = await scrollTop();
  expect(after > before + 200, `the list scrolled: ${before} → ${after}`);
  expect((await page.getByTestId('commit-description').innerText()).includes('Filler 600'), 'details show the branch commit');
});

await check('branch click: a commit older than the loaded history is found by reading more pages', async () => {
  const n0 = await commitCount();
  await page.getByTestId('branch-old-start').click();
  await waitSelectedInView('Initial commit');
  const n1 = await commitCount();
  expect(n0 === 300 && n1 === 653, `pages read on demand: ${n0} → ${n1}`);
});

await check('branch filter pages like the full log: a click finds a commit deep in the filtered history', async () => {
  await page.getByTestId('branch-main').hover();
  await page.getByTestId('funnel-main').click();
  await page.waitForSelector('[data-testid="filter-chip-main"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="selected-commit"]'), null, { timeout: 10000 }); // the first filtered page stops short of it
  await page.waitForTimeout(600); // the previous check clicked this row: two clicks within 450 ms are a double click (checkout)
  await page.getByTestId('branch-old-start').click();
  await waitSelectedInView('Initial commit');
  expect((await page.getByTestId('filter-chip-main').count()) === 1, 'the filter stays');
  await page.getByTestId('clear-branch-filter').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="branch-filter-bar"]'), null, { timeout: 5000 });
});

await check('a commit with 400 files: listed at once, only the visible rows rendered, a diff loads when its file is picked', async () => {
  if (await page.getByTestId('clear-branch-filter').count()) await page.getByTestId('clear-branch-filter').click();
  await page.getByTestId('branch-wide').click();
  await waitSelectedInView('Wide commit');
  await page.waitForFunction(() => /FILES\s*400/i.test(document.body.innerText), null, { timeout: 15000 });
  const rendered = await page.evaluate(() => [...document.querySelectorAll('div')].filter((d) => d.children.length === 0 && /^file\d+\.txt$/.test(d.textContent ?? '')).length);
  expect(rendered > 5 && rendered < 120, `only visible file rows rendered: ${rendered}`);
  await page.getByText('file0.txt', { exact: true }).first().click();
  await waitText('wide line 0');
});

await check('a working copy with 2000 changes: the list renders what is on screen and scrolls to the rest', async () => {
  await page.getByText('Changes', { exact: true }).first().click();
  await page.waitForFunction(() => /STAGED\s*2000/i.test(document.body.innerText), null, { timeout: 20000 });
  const rendered = await page.evaluate(() => [...document.querySelectorAll('div')].filter((d) => d.children.length === 0 && /^gen\d+\.txt$/.test(d.textContent ?? '')).length);
  expect(rendered < 150, `rendered rows: ${rendered}`);
  // list view, then scroll the Unstaged list to its end: the last files appear
  await page.locator('[aria-label="list"]').first().click();
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > 20000 && getComputedStyle(d).overflowY !== 'visible');
    if (el) el.scrollTop = el.scrollHeight;
  });
  // paths sort as text, so the list ends with gen/batch9/gen999.txt
  await page.waitForFunction(() => [...document.querySelectorAll('div')].some((d) => d.children.length === 0 && d.textContent === 'gen999.txt'), null, { timeout: 5000 });
  await page.locator('[aria-label="tree"]').first().click();
  await page.getByText('All Commits', { exact: true }).first().click();
});

await check('a git failure opens the error dialog: git output in full, what to do, earlier errors a step away', async () => {
  // beta's working copy changes img/pixel.png, which differs on old-start: git refuses the checkout
  await page.getByTestId('branch-old-start').click({ button: 'right' });
  await page.getByText('Checkout old-start', { exact: true }).first().click();
  await page.getByTestId('error-dialog').waitFor({ timeout: 10000 });
  expect(/^Checkout old-start failed$/.test(await page.getByTestId('error-title').innerText()), 'title: ' + (await page.getByTestId('error-title').innerText()));
  const detail = await page.getByTestId('error-detail').innerText();
  expect(detail.includes('would be overwritten by checkout') && detail.includes('img/pixel.png'), 'git output in full: ' + detail);
  expect((await page.getByTestId('error-hint').innerText()).includes('Commit, stash or discard'), 'a hint');
  // the earlier error (the synthetic one) is one step older
  await page.getByTestId('error-older').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="error-title"]')?.textContent === 'Unexpected error', null, { timeout: 3000 });
  await page.getByTestId('error-newer').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="error-title"]')?.textContent === 'Checkout old-start failed', null, { timeout: 3000 });
  await page.keyboard.press('Enter');
  await page.getByTestId('error-dialog').waitFor({ state: 'detached', timeout: 3000 });
  expect(git(path.join(root, 'beta'), 'rev-parse', '--abbrev-ref', 'HEAD').trim() === 'main', 'still on main');
  expect(!(await visible('Checked out old-start')), 'no success message after the failure');
  // the status panel points at it: cut to the panel's width with "details" visible, a click opens the dialog
  const bar = await page.getByTestId('status-notice').boundingBox();
  expect(bar.width <= 560, 'the error line keeps to the panel: ' + bar.width);
  await page.getByTestId('status-notice').getByText('details', { exact: true }).waitFor({ timeout: 2000 });
  await page.getByTestId('status-notice').click();
  await page.getByTestId('error-dialog').waitFor({ timeout: 3000 });
  await page.getByTestId('error-close').click();
});

await check('an error over another dialog: Escape closes the error first, then the dialog', async () => {
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('input[placeholder="type a command"]', { timeout: 3000 });
  const paletteOpen = async () => (await page.locator('input[placeholder="type a command"]').count()) > 0;
  await page.evaluate(() => setTimeout(() => { throw new Error('error while a dialog is open'); }, 0));
  await page.getByTestId('error-dialog').waitFor({ timeout: 5000 });
  // Enter closes the error dialog only: the palette does not run its selected command
  await page.keyboard.press('Enter');
  await page.getByTestId('error-dialog').waitFor({ state: 'detached', timeout: 3000 });
  expect(await paletteOpen(), 'the palette is still open after Enter');
  await page.evaluate(() => setTimeout(() => { throw new Error('second error while a dialog is open'); }, 0));
  await page.getByTestId('error-dialog').waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.getByTestId('error-dialog').waitFor({ state: 'detached', timeout: 3000 });
  expect(await paletteOpen(), 'the palette is still open after Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(!(await paletteOpen()), 'then the palette closes');
});

await check('branch filter like Fork: a funnel per branch, several branches, a chip removes one, Clear removes all', async () => {
  await openRepo('alpha');
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="commit-scroll"]')?.innerText ?? '').includes('Search feature work'), null, { timeout: 10000 });
  await page.mouse.move(700, 880);
  expect(!(await funnelShown('feature/login')), 'funnels stay hidden until the row is hovered');
  await page.getByTestId('branch-feature/login').hover();
  expect(await funnelShown('feature/login'), 'the funnel shows on hover');
  await page.getByTestId('funnel-feature/login').click();
  await page.waitForSelector('[data-testid="filter-chip-feature/login"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="commit-scroll"]')?.innerText ?? '';
    return t.includes('Add app module') && !t.includes('Search feature work');
  }, null, { timeout: 10000 });
  await page.mouse.move(700, 880);
  expect(await funnelShown('feature/login'), 'the funnel of a filtered branch stays lit');
  expect(!(await funnelShown('bugfix/crash')), 'the others stay hidden');
  // a second branch joins the filter
  await page.getByTestId('branch-feature/search').hover();
  await page.getByTestId('funnel-feature/search').click();
  await page.waitForSelector('[data-testid="filter-chip-feature/search"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="commit-scroll"]')?.innerText ?? '').includes('Search feature work'), null, { timeout: 10000 });
  expect((await page.getByTestId('filter-chip-feature/login').count()) === 1, 'both branches listed in the bar');
  // the × on a chip drops that branch again
  await page.getByTestId('filter-chip-feature/search').locator('[aria-label="Remove feature/search from the filter"]').click();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="commit-scroll"]')?.innerText ?? '').includes('Search feature work'), null, { timeout: 10000 });
  expect((await page.getByTestId('filter-chip-feature/search').count()) === 0, 'chip gone');
  // context menu: show only one branch
  await page.getByTestId('branch-bugfix/crash').click({ button: 'right' });
  await page.getByText('Show only this branch', { exact: true }).first().click();
  await page.waitForSelector('[data-testid="filter-chip-bugfix/crash"]');
  expect((await page.getByTestId('filter-chip-feature/login').count()) === 0, 'only bugfix/crash is left');
  await page.getByTestId('clear-branch-filter').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="branch-filter-bar"]'), null, { timeout: 5000 });
  await page.waitForFunction(() => (document.querySelector('[data-testid="commit-scroll"]')?.innerText ?? '').includes('Search feature work'), null, { timeout: 10000 });
});

await check('branch click under a filter: a commit the filter hides is reported, not silently ignored', async () => {
  await page.getByTestId('branch-feature/login').hover();
  await page.getByTestId('funnel-feature/login').click();
  await page.waitForSelector('[data-testid="filter-chip-feature/login"]');
  // the chip shows before the filtered history is read: a click in between still sees the full list
  await page.waitForFunction(() => !(document.querySelector('[data-testid="commit-scroll"]')?.textContent ?? '').includes('Search feature work'), null, { timeout: 10000 });
  await page.getByTestId('branch-feature/search').click();
  await waitText('Hidden by the branch filter');
  await page.getByTestId('clear-branch-filter').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="branch-filter-bar"]'), null, { timeout: 5000 });
  await page.waitForTimeout(600); // two clicks on one row within 450 ms are a double click, which checks the branch out
  await page.getByTestId('branch-feature/search').click();
  await waitSelectedInView('Search feature work');
  expect(gitOut('rev-parse', '--abbrev-ref', 'HEAD').trim() === 'main', 'a single click does not check out');
});

await check('commit box: taller from the splitter above it, the description folds and unfolds, both remembered', async () => {
  await page.getByText('Changes', { exact: true }).first().click();
  await page.waitForSelector('[data-testid="commit-box-splitter"]');
  // let the section's entry animation finish before measuring
  await page.waitForFunction(async () => {
    const at = () => document.querySelector('[data-testid="commit-box"]')?.getBoundingClientRect().bottom;
    const a = at();
    await new Promise((r) => setTimeout(r, 150));
    return a !== undefined && a === at();
  }, null, { timeout: 5000 });
  const box0 = await page.getByTestId('commit-box').boundingBox();
  const desc0 = await page.getByTestId('commit-description-input').boundingBox();
  await dragBy('commit-box-splitter', -120);
  const box1 = await page.getByTestId('commit-box').boundingBox();
  const desc1 = await page.getByTestId('commit-description-input').boundingBox();
  expect(box1.height > box0.height + 90, `taller: ${box0.height} → ${box1.height}`);
  expect(desc1.height > desc0.height + 90, `the description field takes the extra height: ${desc0.height} → ${desc1.height}`);
  expect(Math.abs(box1.y + box1.height - (box0.y + box0.height)) < 2, 'the bottom edge stays put');
  // fold: the field goes, its first line stays visible, the box gets compact, no splitter
  await page.getByTestId('commit-description-input').fill('First line of the body\nsecond line');
  await page.getByTestId('toggle-commit-desc').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="commit-description-input"]'), null, { timeout: 3000 });
  const box2 = await page.getByTestId('commit-box').boundingBox();
  expect(box2.height < box0.height, `compact when folded: ${box2.height}`);
  expect((await page.getByTestId('commit-box-splitter').count()) === 0, 'no splitter while folded');
  expect((await page.getByTestId('commit-box').innerText()).includes('First line of the body'), 'the folded box shows the start of the description');
  await page.waitForTimeout(600);
  const s = await fetch(base + '/api/settings').then((x) => x.json());
  expect(s.ui.commitDescOpen === false && Math.abs(s.ui.commitBoxHeight - box1.height) < 3, 'remembered in settings: ' + JSON.stringify({ open: s.ui.commitDescOpen, h: s.ui.commitBoxHeight }));
  await page.getByTestId('toggle-commit-desc').click();
  await page.waitForSelector('[data-testid="commit-description-input"]');
  const box3 = await page.getByTestId('commit-box').boundingBox();
  expect(Math.abs(box3.height - box1.height) < 3, `unfolds to the chosen height: ${box3.height}`);
  expect((await page.getByTestId('commit-description-input').inputValue()).startsWith('First line'), 'the text is kept');
  await page.getByTestId('commit-description-input').fill('');
});

await check('commit details: the description block resizes from its splitter and folds to one line', async () => {
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByText('Add app module', { exact: true }).first().click();
  await page.waitForSelector('[data-testid="details-header-splitter"]');
  const d0 = await page.getByTestId('commit-description').boundingBox();
  await dragBy('details-header-splitter', 80);
  const d1 = await page.getByTestId('commit-description').boundingBox();
  expect(d1.height > d0.height + 60, `taller: ${d0.height} → ${d1.height}`);
  await page.getByTestId('toggle-details-desc').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="commit-description"]').getBoundingClientRect().height < 40, null, { timeout: 3000 });
  const folded = await page.getByTestId('commit-description').innerText();
  expect(folded.includes('Add app module') && !folded.includes('Parent'), 'one line with the subject: ' + folded);
  expect((await page.getByTestId('details-header-splitter').count()) === 0, 'no splitter while folded');
  await page.waitForTimeout(600);
  const s = await fetch(base + '/api/settings').then((x) => x.json());
  expect(s.ui.detailsDescOpen === false, 'fold remembered');
  await page.getByTestId('toggle-details-desc').click();
  await page.waitForFunction((h) => Math.abs(document.querySelector('[data-testid="commit-description"]').getBoundingClientRect().height - h) < 3, d1.height, { timeout: 3000 });
});

await check('a submodule change in a commit: its commits listed, a click opens the submodule at that commit', async () => {
  await openRepo('superproject');
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByText('Bump core', { exact: true }).first().click();
  await page.getByTestId('submodule-added').waitFor({ timeout: 10000 });
  const listed = await page.getByTestId('submodule-added').innerText();
  expect(listed.includes('core: two') && listed.includes('core: one') && !listed.includes('Add core'), 'commits the bump brought in: ' + listed);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'submodule-change.png') });
  // a commit of the list: the submodule's tab opens with it selected
  await page.getByTestId(`submodule-commit-${coreOne.slice(0, 7)}`).click();
  await waitSelectedInView('core: one');
  expect((await page.getByTestId('commit-description').innerText()).includes('core: one'), 'details of the submodule commit');
  // back in the superproject: a double click on the submodule row goes to the new pointer
  await openRepo('superproject');
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByText('Bump core', { exact: true }).first().click();
  await page.getByTestId('file-commit-libs/core').dblclick();
  await waitSelectedInView('core: two');
  // and the button does the same
  await openRepo('superproject');
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByText('Bump core', { exact: true }).first().click();
  await page.getByTestId('submodule-go').click();
  await waitSelectedInView('core: two');
  // the arrow on the submodule row of the commit's files
  await openRepo('superproject');
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByText('Bump core', { exact: true }).first().click();
  await page.getByTestId('open-submodule-libs/core').first().click();
  await waitSelectedInView('core: two');
  // and on the submodule row in Changes: the submodule opens at what is checked out
  await openRepo('superproject');
  await page.getByText('Changes', { exact: true }).first().click();
  await page.getByTestId('open-submodule-libs/core').first().click();
  await waitSelectedInView('core: three');
});

const authInfo = async (p) => (await fetch(base + '/api/repo/authInfo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })).json();
await check('connection: an SSH key for a repository, its submodule inherits it and can override it; tests reach the remote', async () => {
  await openRepo('superproject');
  await page.getByTestId('group-remotes').locator('[aria-label="Connection: SSH key or account"]').first().click();
  await page.getByTestId('connection-dialog').waitFor({ timeout: 5000 });
  await page.getByTestId('conn-option-ssh:e2e_work').click();
  await page.getByTestId('conn-save').click();
  await page.getByTestId('connection-dialog').waitFor({ state: 'detached', timeout: 5000 });
  expect(JSON.stringify((await authInfo(sup)).own) === JSON.stringify({ kind: 'ssh', key: 'e2e_work' }), 'saved on the superproject');
  // the long confirmation stays inside the status panel
  const overlap = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="status-notice"]')?.getBoundingClientRect();
    const box = document.querySelector('[data-testid="status-bar"]')?.getBoundingClientRect();
    return n && box ? n.right - box.right : null;
  });
  expect(overlap !== null && overlap <= 1, 'the notice stays inside the status panel: ' + overlap);
  // the submodule: inherited, shown as such, and overridable
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByText('Bump core', { exact: true }).first().click();
  await page.getByTestId('submodule-go').click();
  await waitSelectedInView('core: two');
  await page.getByTestId('group-remotes').locator('[aria-label="Connection: SSH key or account"]').first().click();
  await page.getByTestId('conn-inherited').waitFor({ timeout: 5000 });
  expect((await page.getByTestId('conn-inherited').innerText()).includes('superproject') && (await page.getByTestId('conn-inherited').innerText()).includes('e2e_work'), 'inherited from the parent');
  const core = path.join(sup, 'libs/core');
  expect((await authInfo(core)).inherited?.from === sup, 'the engine resolves it the same way');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'connection-submodule.png') });
  await page.getByTestId('conn-option-ssh:e2e_personal').click();
  await page.getByTestId('conn-save').click();
  await page.getByTestId('connection-dialog').waitFor({ state: 'detached', timeout: 5000 });
  expect(JSON.stringify((await authInfo(core)).own) === JSON.stringify({ kind: 'ssh', key: 'e2e_personal' }), 'the submodule’s own key');
  // the connection test: alpha's remote is a local folder, reachable with the system default
  await openRepo('alpha');
  await page.getByTestId('group-remotes').locator('[aria-label="Connection: SSH key or account"]').first().click();
  await page.getByTestId('conn-test').click();
  await page.getByTestId('conn-test-result').waitFor({ timeout: 20000 });
  expect((await page.getByTestId('conn-test-result').innerText()).includes('Connected to origin'), 'reached origin');
  await page.keyboard.press('Escape');
  // a sign-in failure in the error dialog leads to these settings
  await page.evaluate(() => setTimeout(() => { throw new Error('git@github.com: Permission denied (publickey).'); }, 0));
  await page.getByTestId('error-connection').click();
  await page.getByTestId('connection-dialog').waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
});

await check('the + in the tab bar opens the start page’s repository list: filter, arrows and Enter, click, Escape', async () => {
  await openRepo('alpha');
  await page.getByTestId('new-tab').click();
  await page.getByTestId('repo-picker').waitFor({ timeout: 3000 });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'repo-picker.png') });
  const names = await page.getByTestId('repo-picker').innerText();
  for (const n of ['alpha', 'beta', 'superproject']) expect(names.includes(n), `${n} listed: ${names}`);
  expect(!names.includes('gamma'), 'only this workspace');
  // type to narrow, Enter opens the first match in a tab
  await page.keyboard.type('custom');
  await page.waitForFunction(() => !(document.querySelector('[data-testid="repo-picker"]')?.textContent ?? '').includes('superproject'), null, { timeout: 3000 });
  await page.keyboard.press('Enter');
  await page.getByTestId('repo-picker').waitFor({ state: 'detached', timeout: 3000 });
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tab-customer-analytics-dashboard"]'), null, { timeout: 10000 });
  // ⌘T opens it too; a click on a row opens that one; Escape and a click outside close it
  await page.keyboard.press('Meta+t');
  await page.getByTestId('repo-picker').waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await page.getByTestId('repo-picker').waitFor({ state: 'detached', timeout: 3000 });
  await page.getByTestId('new-tab').click();
  await page.getByTestId('repo-picker-backdrop').click({ position: { x: 5, y: 600 } });
  await page.getByTestId('repo-picker').waitFor({ state: 'detached', timeout: 3000 });
  await page.getByTestId('new-tab').click();
  await page.getByTestId('picker-repo-alpha').click();
  await page.getByTestId('repo-picker').waitFor({ state: 'detached', timeout: 3000 });
  await waitText('All Commits');
});

await check('tabs and branch filters come back on the next launch', async () => {
  await openRepo('alpha');
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByTestId('branch-feature/login').hover();
  await page.getByTestId('funnel-feature/login').click();
  await page.waitForSelector('[data-testid="filter-chip-feature/login"]');
  const tabsNow = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="tab-"]')].map((e) => e.getAttribute('data-testid')).filter((id) => !/^tab-(group|arrow)-/.test(id)));
  await page.waitForTimeout(900); // saved half a second after the change
  // a new launch: a fresh browser (no local storage) against the same engine
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx2.addInitScript((b) => {
    window.__PRONG_SERVER__ = b;
  }, base);
  const p2 = await ctx2.newPage();
  try {
    await p2.goto(base, { waitUntil: 'load' });
    await p2.waitForSelector('[data-testid="filter-chip-feature/login"]', { timeout: 15000 });
    await p2.waitForFunction(() => {
      const t = document.querySelector('[data-testid="commit-scroll"]')?.innerText ?? '';
      return t.includes('Add app module') && !t.includes('Search feature work');
    }, null, { timeout: 15000 });
    const tabsThen = await p2.evaluate(() => [...document.querySelectorAll('[data-testid^="tab-"]')].map((e) => e.getAttribute('data-testid')).filter((id) => !/^tab-(group|arrow)-/.test(id)));
    expect(JSON.stringify(tabsThen) === JSON.stringify(tabsNow), `the same tabs: ${tabsNow} / ${tabsThen}`);
    expect((await p2.locator('[aria-selected="true"], [data-testid^="tab-"]').count()) > 0, 'tabs shown');
  } finally {
    await ctx2.close();
  }
  await page.getByTestId('clear-branch-filter').click();
  await page.waitForTimeout(900);
});

await check('several branches at once: ⌘ and Shift pick them, the batch bar filters and deletes them all', async () => {
  await openRepo('alpha');
  await page.getByText('All Commits', { exact: true }).first().click();
  const count = () => page.evaluate(() => document.querySelector('[data-testid="batch-count"]')?.textContent ?? '');
  await page.getByTestId('branch-batch/a').click({ modifiers: ['Meta'] });
  await page.getByTestId('batch-bar').waitFor({ timeout: 3000 });
  // Shift: the run in the order the sidebar shows (a, b, c, wip)
  await page.getByTestId('branch-batch/wip').click({ modifiers: ['Shift'] });
  await page.waitForFunction(() => /^4 selected/.test(document.querySelector('[data-testid="batch-count"]')?.textContent ?? ''), null, { timeout: 3000 });
  // ⌘ takes one out again
  await page.getByTestId('branch-batch/b').click({ modifiers: ['Meta'] });
  await page.waitForFunction(() => /^3 selected/.test(document.querySelector('[data-testid="batch-count"]')?.textContent ?? ''), null, { timeout: 3000 });
  expect((await page.getByTestId('picked-batch/b').count()) === 0 && (await page.getByTestId('picked-batch/c').count()) === 1, 'b out, c in');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'batch-bar.png') });
  expect(gitOut('rev-parse', '--abbrev-ref', 'HEAD').trim() === 'main', 'picking does not check anything out');
  // the history shows only them
  await page.getByTestId('batch-filter').click();
  for (const b of ['batch/a', 'batch/c', 'batch/wip']) await page.waitForSelector(`[data-testid="filter-chip-${b}"]`, { timeout: 5000 });
  await page.getByTestId('clear-branch-filter').click();
  // delete them: the unmerged one stays and the error dialog says why
  expect((await count()).startsWith('3 selected'), 'still selected after filtering');
  await page.getByTestId('batch-delete').click();
  const dlg = await page.getByTestId('delete-branches-dialog').innerText();
  expect(['batch/a', 'batch/c', 'batch/wip'].every((b) => dlg.includes(b)) && !dlg.includes('batch/b'), 'the dialog lists them: ' + dlg);
  // "also unmerged" is on by default; untick it to keep unmerged branches: git then refuses batch/wip and says why
  await page.getByTestId('batch-force').click();
  await page.getByTestId('batch-delete-confirm').click();
  await page.getByTestId('error-dialog').waitFor({ timeout: 10000 });
  const why = await page.getByTestId('error-detail').innerText();
  expect(why.includes('batch/wip') && /not fully merged/.test(why) && !/hint:/.test(why), 'why batch/wip stayed, without git’s advice lines: ' + why);
  expect((await page.getByTestId('error-hint').innerText()).includes('unmerged'), 'what to do');
  expect(gitOut('branch', '--list', 'batch/*').split('\n').map((l) => l.trim()).filter(Boolean).sort().join(',') === 'batch/b,batch/wip,batch/wip2', 'a and c deleted: ' + gitOut('branch', '--list', 'batch/*'));
  // the way out in the error dialog: the unmerged ones go too
  expect((await page.getByTestId('error-action').innerText()).toLowerCase().includes('delete 1 unmerged anyway'), 'offered');
  await page.getByTestId('error-action').click();
  await page.waitForFunction(() => /Deleted 1 branch/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 10000 });
  expect(!gitOut('branch', '--list', 'batch/wip').trim(), 'batch/wip deleted');
  await page.waitForFunction(() => !document.querySelector('[data-testid="batch-bar"]'), null, { timeout: 5000 });
  // by default an unmerged branch goes at once
  await page.getByTestId('branch-batch/wip2').click({ modifiers: ['Meta'] });
  await page.getByTestId('batch-delete').click();
  await page.getByTestId('batch-delete-confirm').click();
  for (let i = 0; i < 50 && gitOut('branch', '--list', 'batch/wip2').trim(); i++) await page.waitForTimeout(200);
  expect(!gitOut('branch', '--list', 'batch/wip2').trim(), 'batch/wip2 deleted with the default');
  // Escape clears a selection
  await page.getByTestId('branch-batch/b').click({ modifiers: ['Meta'] });
  await page.getByTestId('batch-bar').waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="batch-bar"]'), null, { timeout: 3000 });
});

await check('a double click switches branches: in the branch list, and on a commit (a menu when it carries several)', async () => {
  await openRepo('alpha');
  await page.getByText('All Commits', { exact: true }).first().click();
  const head = () => gitOut('rev-parse', '--abbrev-ref', 'HEAD').trim();
  await page.waitForTimeout(600);
  // the branch list
  await page.getByTestId('branch-batch/b').dblclick();
  await page.waitForFunction(() => /Checked out batch\/b/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 10000 });
  expect(head() === 'batch/b', 'on batch/b: ' + head());
  // a commit with one other branch: straight to it
  await page.waitForTimeout(600);
  await page.getByText('Search feature work', { exact: true }).first().dblclick();
  await page.waitForFunction(() => /Checked out feature\/search/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 10000 });
  expect(head() === 'feature/search', 'on feature/search: ' + head());
  // a commit with several: a menu, then the chosen one
  await page.waitForTimeout(600);
  await page.getByText('Add app module', { exact: true }).first().dblclick();
  await page.getByText('Switch to main', { exact: true }).first().waitFor({ timeout: 3000 });
  expect((await page.getByText('Switch to feature/login', { exact: true }).count()) >= 1, 'the other branches are offered too');
  await page.getByText('Switch to main', { exact: true }).first().click();
  await page.waitForFunction(() => /Checked out main/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 10000 });
  expect(head() === 'main', 'back on main: ' + head());
});

const statusHas = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), re.source, { timeout: 15000 });
const headNow = () => gitOut('rev-parse', '--abbrev-ref', 'HEAD').trim();
/** branches made from the command line show up after a refresh (More → Refresh) */
const refreshUi = async () => {
  await page.getByText('More', { exact: true }).first().click();
  await page.getByText('Refresh', { exact: true }).first().click();
  await page.waitForTimeout(600);
};
// the batch check deleted most branches at main's commit: these are fresh ones (alpha has local changes, so the
// switches stay on one commit)
gitOut('checkout', '-q', 'main');
for (const b of ['dbl/one', 'dbl/two', 'q/one', 'q/two', 'q/three']) gitOut('branch', b);

await check('a slow double click still switches: the system’s click count decides, not the time between the handlers', async () => {
  await openRepo('alpha');
  await refreshUi();
  const box = await page.getByTestId('branch-dbl/one').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  // the first click kept the page busy (a large repository): its second click is handled 800 ms later
  await page.waitForTimeout(800);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await statusHas(/Checked out dbl\/one/);
  expect(headNow() === 'dbl/one', 'on dbl/one: ' + headNow());
  // two separate clicks are not a double click, however quick
  await page.getByTestId('branch-dbl/two').click();
  await page.waitForTimeout(200);
  await page.getByTestId('branch-dbl/two').click();
  await page.waitForTimeout(800);
  expect(headNow() === 'dbl/one', 'two single clicks do not check out: ' + headNow());
});

await check('a remote branch: a double click makes its local branch, tracking it (as Fork does)', async () => {
  gitOut('branch', 'from-origin', 'main');
  gitOut('push', '-q', 'origin', 'from-origin');
  gitOut('branch', '-D', 'from-origin');
  await refreshUi();
  await page.getByPlaceholder('filter branches').fill('from-origin');
  await page.waitForTimeout(400);
  await page.getByTestId('branch-origin/from-origin').dblclick();
  await statusHas(/Checked out from-origin \(tracks origin\/from-origin\)/);
  expect(headNow() === 'from-origin', 'on from-origin: ' + headNow());
  expect(gitOut('rev-parse', '--abbrev-ref', 'from-origin@{upstream}').trim() === 'origin/from-origin', 'tracks origin/from-origin');
  await page.getByPlaceholder('filter branches').fill('');
});

await check('local changes in the way of a switch: the error offers stash, switch and reapply', async () => {
  const dir = path.join(root, 'alpha');
  gitOut('checkout', '-q', 'main');
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  writeFileSync(path.join(dir, 'far.txt'), lines.join('\n') + '\n');
  gitOut('add', 'far.txt');
  gitOut('commit', '-q', '-m', 'Add far.txt');
  gitOut('branch', 'far-lines');
  gitOut('checkout', '-q', 'far-lines');
  writeFileSync(path.join(dir, 'far.txt'), ['line 1 on the branch', ...lines.slice(1)].join('\n') + '\n');
  gitOut('commit', '-q', '-am', 'Change the first line');
  gitOut('checkout', '-q', 'main');
  // a local change to the same file, far from the branch's change: git refuses the switch, a stash carries it over
  writeFileSync(path.join(dir, 'far.txt'), [...lines.slice(0, 11), 'line 12 changed here'].join('\n') + '\n');
  await refreshUi();
  await page.getByTestId('branch-far-lines').dblclick();
  await page.getByTestId('error-action').waitFor({ timeout: 10000 });
  // innerText is upper-cased by the button's style
  expect(/stash, switch and reapply/i.test(await page.getByTestId('error-action').innerText()), 'the action is offered');
  expect(headNow() === 'main', 'git refused: still on main');
  await page.getByTestId('error-action').click();
  await statusHas(/Checked out far-lines; local changes reapplied/);
  expect(headNow() === 'far-lines', 'on far-lines: ' + headNow());
  const far = readFileSync(path.join(dir, 'far.txt'), 'utf8');
  expect(far.startsWith('line 1 on the branch') && far.includes('line 12 changed here'), 'both changes in the file: ' + far);
  expect(!gitOut('stash', 'list').includes('Prong: before switching'), 'the stash was applied and dropped');
  // back to main with the fixture's own local changes: far.txt's change goes, far.txt is not on main's parent
  gitOut('checkout', '-q', '--', 'far.txt');
  gitOut('checkout', '-q', 'main');
  await refreshUi();
});

await check('the action queue: an action blocked by another git’s index.lock waits, says so, can be cancelled, runs when it goes', async () => {
  const lock = path.join(root, 'alpha/.git/index.lock');
  const before = headNow();
  writeFileSync(lock, '');
  try {
    await page.waitForTimeout(600);
    await page.getByTestId('branch-q/one').dblclick();
    await page.getByTestId('queue-status').waitFor({ timeout: 5000 });
    const shown = await page.getByTestId('queue-status').innerText();
    expect(/Waiting for index\.lock · Checkout q\/one/i.test(shown), 'what waits, for what: ' + shown);
    // a second action lines up behind it, and can be taken out
    await page.getByTestId('branch-q/two').dblclick();
    await page.waitForFunction(() => /1 more/.test(document.querySelector('[data-testid="queue-status"]')?.textContent ?? ''), null, { timeout: 5000 });
    await page.getByTestId('queue-status').click();
    await page.getByTestId('queue-panel').waitFor({ timeout: 3000 });
    expect((await page.getByTestId('queue-item-waiting-lock').count()) === 1 && (await page.getByTestId('queue-item-queued').count()) === 1, 'one waits for the lock, one for its turn');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'queue-panel.png') });
    await page.locator('[data-testid^="queue-cancel-"]').last().click();
    await page.waitForFunction(() => !/1 more/.test(document.querySelector('[data-testid="queue-status"]')?.textContent ?? ''), null, { timeout: 5000 });
    expect(headNow() === before, 'nothing ran while the lock was held');
  } finally {
    rmSync(lock, { force: true });
  }
  await statusHas(/Checked out q\/one/);
  expect(headNow() === 'q/one', 'ran once the lock went: ' + headNow());
  await page.waitForFunction(() => !document.querySelector('[data-testid="queue-status"]'), null, { timeout: 5000 });
  await page.waitForTimeout(1000);
  expect(headNow() === 'q/one', 'the cancelled one never ran');
});

await check('a lock left behind by a crash: once it is old, the queue list deletes it (after asking) and the action runs', async () => {
  const lock = path.join(root, 'alpha/.git/index.lock');
  writeFileSync(lock, '');
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(lock, old, old);
  try {
    await page.getByTestId('branch-q/three').dblclick();
    await page.getByTestId('queue-status').waitFor({ timeout: 5000 });
    await page.getByTestId('queue-status').click();
    await page.getByTestId('queue-remove-lock').waitFor({ timeout: 3000 });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'queue-stale-lock.png') });
    await page.getByTestId('queue-remove-lock').click();
    await page.getByText('Delete', { exact: true }).last().click(); // confirm
    await statusHas(/Checked out q\/three/);
    expect(!existsSync(lock), 'the lock is gone');
    expect(headNow() === 'q/three', 'on q/three: ' + headNow());
    gitOut('checkout', '-q', 'main');
  } finally {
    rmSync(lock, { force: true });
  }
});

await check('back in the window or on another tab: branches and commits made elsewhere show up without a refresh', async () => {
  await openRepo('alpha');
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.waitForTimeout(2200); // a read a moment ago is not repeated
  // a commit on a new branch, made in a terminal
  const sha = gitOut('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Made in a terminal').trim();
  gitOut('branch', 'from-terminal', sha);
  await page.waitForTimeout(500);
  expect(!(await visible('Made in a terminal')), 'not there until the window comes back');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByTestId('branch-from-terminal').waitFor({ timeout: 10000 });
  await waitText('Made in a terminal');
  // the macOS shell's signal that the app became active
  await page.waitForTimeout(2200);
  gitOut('branch', 'from-terminal-2', sha);
  await page.evaluate(() => window.dispatchEvent(new Event('prong-activate')));
  await page.getByTestId('branch-from-terminal-2').waitFor({ timeout: 10000 });
  // another tab is read when it is shown
  git(path.join(root, 'beta'), 'branch', 'beta-from-terminal');
  await page.getByTestId('tab-beta').click();
  await page.getByTestId('branch-beta-from-terminal').waitFor({ timeout: 10000 });
  await page.getByTestId('tab-alpha').click();
  await page.getByTestId('branch-from-terminal').waitFor({ timeout: 10000 });
});

await check('“Ask AI” in the error window hands the error to the agent: in the repository, with git’s output', async () => {
  rmSync(agentLog, { force: true });
  const alpha = path.join(root, 'alpha');
  const entries = () => (existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : '').split('\n---\n').filter((e) => e.trim());
  const waitEntries = async (n) => {
    for (let i = 0; i < 80 && entries().length < n; i++) await page.waitForTimeout(250);
    return entries();
  };
  // a checkout git refuses: a local change to far.txt, which far-lines changes too
  writeFileSync(path.join(alpha, 'far.txt'), 'changed here, in the way\n');
  try {
    await page.waitForTimeout(600);
    await page.getByTestId('branch-far-lines').dblclick();
    await page.getByTestId('error-ask-ai').waitFor({ timeout: 10000 });
    await page.getByTestId('error-ask-ai').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="error-dialog"]'), null, { timeout: 5000 });
    // the chat opens on the run: the question in Markdown — what failed, where, git's words in a code block
    await waitText('Разберись с ошибкой и исправь, если это безопасно');
    const question = page.getByTestId('agent-msg-user').last();
    const shown = await question.innerText();
    expect(shown.includes('Checkout far-lines failed') && /alpha · ветка main/i.test(shown), 'what and where: ' + shown);
    expect((await question.getByTestId('md-code').count()) === 1 && /would be overwritten by checkout/.test(await question.getByTestId('md-code').innerText()), 'git’s output as code');
    expect(!shown.includes('**') && !shown.includes('```'), 'no raw Markdown: ' + shown);
    const [first] = await waitEntries(1);
    // the agent ran in that repository, with what failed, where, git's own words and the rules
    expect(first.startsWith(`cwd: ${realpathSync(alpha)}\n`) || first.startsWith(`cwd: ${alpha}\n`), 'ran in alpha: ' + first.split('\n')[0]);
    expect(first.includes('resume: \n'), 'a new conversation');
    expect(first.includes(`Репозиторий: ${alpha}, текущая ветка main`), 'which repository and branch');
    expect(/would be overwritten by checkout/.test(first) && /без force-push/.test(first) && /### Причина/.test(first), 'output, rules, answer format');
    // the answer, rendered: bold, a list, a code block with a copy button; the steps folded into one row
    const answer = page.getByTestId('agent-msg-agent').last();
    await answer.getByTestId('md-code').waitFor({ timeout: 15000 });
    const said = await answer.innerText();
    expect(said.includes('Done: checked src/state/store.ts') && said.includes('git status') && !said.includes('**') && !said.includes('```'), 'rendered: ' + said);
    expect((await answer.getByTestId('md-code-copy').count()) === 1, 'the command can be copied');
    expect(/2 steps/.test(await answer.getByTestId('agent-steps').innerText()), 'steps folded');
    expect(!said.includes('/repo/src/state/store.ts'), 'steps hidden until unfolded');
    await answer.getByTestId('agent-steps').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="agent-msg-agent"]')].pop()?.innerText.includes('/repo/src/state/store.ts'), null, { timeout: 3000 });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'agent-markdown.png') });
    // a reply goes on with the same conversation, in the same repository
    await page.waitForTimeout(800);
    const input = page.getByPlaceholder('команда для репозитория или интерфейса');
    await input.fill('да, сделай');
    await input.press('Enter');
    const [, second] = await waitEntries(2);
    expect(!!second && second.includes('resume: fake-session') && (second.startsWith(`cwd: ${realpathSync(alpha)}\n`) || second.startsWith(`cwd: ${alpha}\n`)), 'continued in alpha: ' + (second ?? '').split('\n').slice(0, 2).join(' | '));
    await page.waitForTimeout(1500); // the fake run ends
  } finally {
    gitOut('checkout', '-q', '--', 'far.txt');
  }
  if (await page.getByTestId('agent-fold').count()) await page.getByTestId('agent-fold').click();
  await page.keyboard.press('Escape');
});

await check('Fetch, Pull, Push as in Fork: a click opens the dialog with its options; choices are remembered', async () => {
  const alpha = path.join(root, 'alpha');
  const origin = path.join(tmp, 'origins/alpha.git');
  // someone else's work on origin: a tag no branch reaches, and a branch with a new commit
  const other = path.join(tmp, 'other-clone');
  rmSync(other, { recursive: true, force: true });
  git(tmp, 'clone', '-q', origin, other);
  git(other, 'config', 'commit.gpgsign', 'false');
  git(other, 'switch', '-q', '-c', 'pull-src');
  writeFileSync(path.join(other, 'pulled.txt'), 'from someone else\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'Pulled from someone else');
  git(other, 'push', '-q', 'origin', 'pull-src');
  git(other, 'switch', '-q', '--detach');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'Tagged only');
  git(other, 'tag', 'v-unreachable');
  git(other, 'push', '-q', 'origin', 'v-unreachable');
  await openRepo('alpha');
  await page.getByText('All Commits', { exact: true }).first().click();
  // Fetch: the toolbar button opens the dialog; one remote, with all tags
  await page.getByText('Fetch', { exact: true }).first().click();
  await page.getByTestId('fetch-dialog').waitFor({ timeout: 5000 });
  await page.getByTestId('fetch-remote').click();
  await page.getByTestId('fetch-remote-list').waitFor({ timeout: 3000 });
  expect((await page.getByTestId('pick-').count()) === 1 && (await page.getByTestId('pick-origin').count()) === 1, 'all remotes, and origin');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'sync-fetch.png') });
  await page.getByTestId('pick-origin').click();
  await page.getByTestId('fetch-tags').click();
  await page.keyboard.press('Enter');
  await statusHas(/Fetching origin: done/);
  expect(gitOut('tag', '--list').includes('v-unreachable'), 'the tag no branch reaches came with "all tags"');
  // remembered for next time
  await page.getByText('Fetch', { exact: true }).first().click();
  await page.getByTestId('fetch-dialog').waitFor({ timeout: 5000 });
  expect((await page.getByTestId('fetch-remote').innerText()).includes('origin'), 'origin preselected');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="fetch-dialog"]'), null, { timeout: 3000 });

  // Pull: a chosen branch of origin into main, rebasing, local changes stashed around it
  const changesBefore = gitOut('status', '--porcelain').trim();
  expect(changesBefore.length > 0, 'alpha has local changes');
  await page.getByText('Pull', { exact: true }).first().click();
  await page.getByTestId('pull-dialog').waitFor({ timeout: 5000 });
  await page.getByTestId('pull-branch').click();
  await page.getByTestId('pull-branch-list').waitFor({ timeout: 3000 });
  // Escape closes the dropdown only; the dialog stays
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="pull-branch-list"]'), null, { timeout: 3000 });
  expect((await page.getByTestId('pull-dialog').count()) === 1, 'the dialog stays open');
  await page.getByTestId('pull-branch').click();
  await page.getByTestId('pick-pull-src').click();
  expect(/is not what main tracks/.test(await page.getByTestId('pull-dialog').innerText()), 'says it is not the upstream');
  await page.getByTestId('pull-dialog').getByText('Rebase', { exact: true }).click();
  await page.getByTestId('pull-autostash').click();
  expect(/go to the stash and come back/.test(await page.getByTestId('pull-dialog').innerText()), 'explains the stash');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'sync-pull.png') });
  await page.getByTestId('pull-go').click();
  await statusHas(/Pulling origin\/pull-src \(rebase\): done/);
  expect(gitOut('log', '--format=%s', 'main').includes('Pulled from someone else'), 'the pulled commit is on main');
  expect(gitOut('status', '--porcelain').trim() === changesBefore, 'local changes are back as they were');
  expect(gitOut('rev-parse', '--abbrev-ref', 'main@{upstream}').trim() === 'origin/main', 'the upstream stays');

  // Push: another local branch, under a new name on origin, tracking it
  await refreshUi();
  await page.getByText('Push', { exact: true }).first().click();
  await page.getByTestId('push-dialog').waitFor({ timeout: 5000 });
  await page.getByTestId('push-branch').click();
  await page.getByTestId('push-branch-list').waitFor({ timeout: 3000 });
  await page.getByTestId('pick-dbl/two').click();
  await page.getByTestId('push-remote-branch').fill('published/dbl-two');
  expect(/creates published\/dbl-two on origin/.test(await page.getByTestId('push-dialog').innerText()), 'says it creates the branch');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'sync-push.png') });
  await page.getByTestId('push-go').click();
  await statusHas(/Pushing dbl\/two to origin\/published\/dbl-two: done/);
  expect(git(origin, 'rev-parse', 'refs/heads/published/dbl-two').trim() === gitOut('rev-parse', 'dbl/two').trim(), 'on origin under the new name');
  expect(gitOut('rev-parse', '--abbrev-ref', 'dbl/two@{upstream}').trim() === 'origin/published/dbl-two', 'tracks it');
  expect(headNow() === 'main', 'the current branch is untouched');

  // the arrow next to Fetch: right away, no dialog
  await page.getByLabel('Fetch: quick actions').click();
  await page.getByText('Fetch all remotes now', { exact: true }).click();
  await statusHas(/Fetching all remotes: done/);
  expect((await page.getByTestId('fetch-dialog').count()) === 0, 'no dialog');
  rmSync(other, { recursive: true, force: true });
});

await check('branch names keep the case typed; a folder that exists in another case is used; the current branch shows even when HEAD spells it otherwise', async () => {
  await openRepo('alpha');
  await page.getByText('All Commits', { exact: true }).first().click();
  const folds = gitOut('config', '--bool', 'core.ignorecase').trim() === 'true';
  await page.getByText('Branch', { exact: true }).first().click();
  const input = page.getByPlaceholder('feature/…');
  await input.waitFor({ timeout: 5000 });
  expect((await input.getAttribute('autocapitalize')) === 'none' && (await input.getAttribute('autocorrect')) === 'off', 'no automatic capitals or corrections');
  await input.fill('DBL/three');
  if (folds) {
    await page.getByTestId('branch-case-note').waitFor({ timeout: 3000 });
    expect(/dbl\/ already exists.*the branch is dbl\/three/.test(await page.getByTestId('branch-case-note').innerText()), 'says where it goes');
  }
  await input.press('Enter');
  await statusHas(folds ? /Created branch dbl\/three/ : /Created branch DBL\/three/);
  expect(gitOut('symbolic-ref', 'HEAD').trim() === (folds ? 'refs/heads/dbl/three' : 'refs/heads/DBL/three'), 'HEAD names it as stored: ' + gitOut('symbolic-ref', 'HEAD'));
  if (folds) {
    // made in a terminal with another case: git lists dbl/…, HEAD says DBL/… — still the current branch
    gitOut('switch', '-q', '-c', 'DBL/typed-elsewhere');
    await refreshUi();
    await page.waitForFunction(() => /dbl\/typed-elsewhere/.test(document.querySelector('[data-testid="activity-branch"]')?.textContent ?? ''), null, { timeout: 5000 });
  }
  gitOut('switch', '-q', 'main');
  await refreshUi();
});

await check('Undo (⌘Z, the toolbar button): staging, a commit, a discard and a checkout are taken back; a stale one says so', async () => {
  const alpha = path.join(root, 'alpha');
  const src = path.join(alpha, 'src.txt');
  const srcBefore = readFileSync(src, 'utf8');
  try {
    await openRepo('alpha');
    // staging
    writeFileSync(path.join(alpha, 'undo-stage.txt'), 'stage me\n');
    await refreshUi();
    await page.getByText('Changes', { exact: true }).first().click();
    await page.getByTestId('file-unstaged-undo-stage.txt').click();
    await page.keyboard.press(' ');
    await page.getByTestId('file-staged-undo-stage.txt').waitFor({ timeout: 5000 });
    expect(/Undo Stage undo-stage\.txt/.test((await page.getByTestId('undo-button').getAttribute('aria-label')) ?? ''), 'the button says what it undoes');
    await page.keyboard.press('Meta+z');
    await page.getByTestId('file-unstaged-undo-stage.txt').waitFor({ timeout: 5000 });
    expect(!gitOut('diff', '--cached', '--name-only').includes('undo-stage.txt'), 'unstaged again');
    // a commit: gone, its changes stay staged
    gitOut('add', 'undo-stage.txt');
    await refreshUi();
    const headBefore = gitOut('rev-parse', 'HEAD').trim();
    await page.getByPlaceholder('Commit summary').fill('Commit to undo');
    await page.getByTestId('commit-button').click();
    await statusHas(/Committed/);
    expect(gitOut('log', '-1', '--format=%s').trim() === 'Commit to undo', 'committed');
    await page.getByTestId('undo-button').click();
    await statusHas(/Undone: Commit “Commit to undo”/);
    expect(gitOut('rev-parse', 'HEAD').trim() === headBefore, 'the commit is gone');
    expect(gitOut('diff', '--cached', '--name-only').includes('undo-stage.txt'), 'its changes stay staged');
    // a discard: back from Prong's copy
    writeFileSync(src, 'one\ntwo\nchanged, to be discarded\n');
    await refreshUi();
    await page.getByTestId('file-unstaged-src.txt').click({ button: 'right' });
    await page.getByText('Discard changes…', { exact: true }).click();
    await page.getByText('Discard', { exact: true }).last().click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="file-unstaged-src.txt"]'), null, { timeout: 5000 });
    expect(readFileSync(src, 'utf8') !== 'one\ntwo\nchanged, to be discarded\n', 'discarded');
    await page.keyboard.press('Meta+z');
    await statusHas(/Undone: Discard src\.txt/);
    expect(readFileSync(src, 'utf8') === 'one\ntwo\nchanged, to be discarded\n', 'the change is back');
    // a checkout
    await page.getByText('All Commits', { exact: true }).first().click();
    await page.waitForTimeout(600);
    await page.getByTestId('branch-dbl/two').dblclick();
    await statusHas(/Checked out dbl\/two/);
    await page.keyboard.press('Meta+z');
    await statusHas(/Undone: Checkout dbl\/two/);
    expect(headNow() === 'main', 'back on main: ' + headNow());
    // a command in a terminal moved HEAD: what is left is stale and says so instead of doing harm
    gitOut('commit', '-q', '--allow-empty', '-m', 'Made in a terminal, too');
    await refreshUi();
    await page.getByTestId('undo-button').click();
    await statusHas(/Cannot undo/);
  } finally {
    gitOut('reset', '-q', '--', 'undo-stage.txt');
    rmSync(path.join(alpha, 'undo-stage.txt'), { force: true });
    writeFileSync(src, srcBefore);
  }
});

await check('submodules follow a checkout and its undo; one moved by hand is left where it is', async () => {
  const supDir = path.join(root, 'superproject');
  const core = path.join(supDir, 'libs/core');
  const recorded = (rev) => git(supDir, 'rev-parse', `${rev}:libs/core`).trim();
  const coreHead = () => git(core, 'rev-parse', 'HEAD').trim();
  const byHand = coreHead(); // the fixture left it at "core: three", which no commit records
  git(core, 'checkout', '-q', recorded('HEAD'));
  git(supDir, 'branch', 'before-bump', 'HEAD~1');
  try {
    await openRepo('superproject');
    await refreshUi();
    await page.getByText('All Commits', { exact: true }).first().click();
    await page.waitForTimeout(600);
    await page.getByTestId('branch-before-bump').dblclick();
    await statusHas(/Updating submodules \(1\): done/);
    expect(coreHead() === recorded('before-bump'), 'the submodule followed the checkout');
    // undoing the checkout: back on main, the submodule follows again
    await page.keyboard.press('Meta+z');
    // the notice of the first update may still be up: ask git
    const until = async (f, what) => {
      for (let i = 0; i < 60 && !f(); i++) await page.waitForTimeout(250);
      expect(f(), what);
    };
    await until(() => git(supDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim() === 'main', 'back on main');
    await until(() => coreHead() === recorded('HEAD'), 'the submodule followed back');
    await page.waitForFunction(() => !document.querySelector('[data-testid="activity-op"]'), null, { timeout: 10000 });
    // moved by hand: left alone, and said so
    git(core, 'checkout', '-q', byHand);
    await page.waitForTimeout(600);
    await page.getByTestId('branch-before-bump').dblclick();
    await statusHas(/left where you put it/);
    expect(coreHead() === byHand, 'not moved');
  } finally {
    // Prong may still be running git there (a refresh, a submodule update): a few tries, never hiding the real failure
    for (let i = 0; i < 20; i++) {
      try {
        git(supDir, 'checkout', '-q', 'main');
        git(core, 'checkout', '-q', byHand);
        break;
      } catch (e) {
        if (i === 19) console.log('cleanup of the superproject failed: ' + String(e.stderr ?? e).slice(0, 300));
        await page.waitForTimeout(250);
      }
    }
  }
});

await check('the toolbar shows the branch and what runs, as in Fork', async () => {
  await openRepo('alpha');
  await page.getByTestId('activity-branch').waitFor({ timeout: 5000 });
  const shown = await page.getByTestId('activity-branch').innerText();
  expect(/main/.test(shown) && /origin\/main/.test(shown), 'branch and upstream: ' + shown);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'activity-idle.png'), clip: { x: 0, y: 0, width: 1440, height: 90 } });
  // a long operation: its name and a stop button in the box
  await page.getByLabel('Fetch: quick actions').click();
  await page.getByText('Fetch all remotes now', { exact: true }).click();
  await page.waitForFunction(() => /Fetching all remotes/.test(document.querySelector('[data-testid="activity-box"]')?.textContent ?? ''), null, { timeout: 5000 });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'activity-running.png'), clip: { x: 0, y: 0, width: 1440, height: 90 } });
  await statusHas(/Fetching all remotes: done/);
});

await check('one status panel, on the right of the toolbar where the palette field was: nothing at the bottom', async () => {
  await openRepo('alpha');
  await page.getByTestId('activity-box').waitFor({ timeout: 5000 });
  const box = await page.getByTestId('activity-box').boundingBox();
  const vp = page.viewportSize();
  expect(box.y < 90 && box.x + box.width > vp.width - 40, 'top right: ' + JSON.stringify(box));
  expect(!(await visible('command palette')), 'no palette field');
  // nothing below the repository view: the details panel reaches the bottom of the window
  const lowest = await page.evaluate(() => Math.max(...[...document.querySelectorAll('[data-testid="status-bar"], [data-testid="status-notice"], [data-testid="error-log-button"]')].map((e) => e.getBoundingClientRect().bottom)));
  expect(lowest < 100, 'status only at the top: ' + lowest);
  // ⌘K still opens the palette
  await page.keyboard.press('Meta+k');
  await page.getByPlaceholder(/command|type a command/i).first().waitFor({ timeout: 3000 }).catch(() => {});
  expect(await visible('Fetch…'), 'the palette opens');
  await page.keyboard.press('Escape');
  // the start screen has it too (status, errors, the engine)
  await page.getByTestId('home-button').click();
  await page.getByTestId('activity-box').waitFor({ timeout: 5000 });
  const home = await page.getByTestId('activity-box').boundingBox();
  expect(home.y < 120, 'at the top of the start screen: ' + home.y);
  await openRepo('alpha');
});

const versionsNow = async () => (await fetch(base + '/api/app/versions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources: appSources }) })).json();
const buildMark = () => page.evaluate(() => document.querySelector('meta[name="prong-build"]')?.getAttribute('content') ?? null);

await check('agent changes the interface: a version is recorded, the interface rebuilt, the window reloads and keeps the session', async () => {
  await openRepo('alpha');
  if (!(await page.getByTestId('agent-input').count())) await page.getByTestId('agent-button').click();
  const reloaded = page.waitForEvent('framenavigated', { timeout: 30000 }).catch((e) => e);
  await page.getByTestId('agent-input').fill('убери иконку темы с главного экрана edit-ui');
  await page.getByTestId('agent-input').press('Enter');
  await reloaded;
  await page.waitForSelector('meta[name="prong-build"]', { state: 'attached', timeout: 20000 });
  await page.getByTestId('agent-notice').first().waitFor({ timeout: 15000 });
  await waitText('Interface updated');
  await waitText('1 file edited');
  await waitText('All Commits'); // the repository tab came back after the reload
  expect(readFileSync(path.join(appSources, 'src/Toolbar.tsx'), 'utf8').includes('edited by fake agent'), 'the agent edited the sources');
  expect(!existsSync(path.join(appSources, '.git')), 'nothing written into the sources folder');
  const v = await versionsNow();
  expect(v.length === 1 && v[0].status === 'applied' && v[0].files[0].path === 'src/Toolbar.tsx', 'version v1 in the log: ' + JSON.stringify(v));
});

await check('reverting the version from its notice rebuilds and reloads again', async () => {
  const before = await buildMark();
  const reloaded = page.waitForEvent('framenavigated', { timeout: 30000 }).catch((e) => e);
  await page.getByText('revert v1', { exact: true }).first().click();
  await reloaded;
  await page.waitForFunction((b) => {
    const m = document.querySelector('meta[name="prong-build"]')?.getAttribute('content');
    return m && m !== b;
  }, before, { timeout: 20000 });
  const v = await versionsNow();
  expect(v[0].status === 'reverted', 'v1 reverted: ' + JSON.stringify(v));
  expect(readFileSync(path.join(appSources, 'src/Toolbar.tsx'), 'utf8') === 'export const themeButton = true;\n', 'sources back to the baseline');
  await waitText('re-apply v1');
  await page.getByTestId('agent-notice-close').first().click();
});

await check('a change that does not build is rolled back, the window stays as it was', async () => {
  const before = await buildMark();
  if (!(await page.getByTestId('agent-input').count())) await page.getByTestId('agent-button').click();
  await page.getByTestId('agent-input').fill('сделай тулбар компактнее edit-ui BREAK');
  await page.getByTestId('agent-input').press('Enter');
  await page.getByTestId('agent-notice').first().waitFor({ timeout: 15000 });
  await waitText('Interface build failed');
  expect((await buildMark()) === before, 'no reload into a broken build');
  expect(readFileSync(path.join(appSources, 'src/Toolbar.tsx'), 'utf8') === 'export const themeButton = true;\n', 'the broken edit was rolled back');
  // the agent's notice carries this failure; an error dialog, if one came up, is closed first
  if (await page.getByTestId('error-dialog').count()) await page.getByTestId('error-close').click();
  await page.getByTestId('agent-notice-close').first().click();
});

await browser.close();
engine.kill('SIGTERM');
if (failed) {
  console.log(`\n${failed} failed · screenshots in ${tmp}\n--- engine log ---\n${engineLog.slice(-2000)}`);
  process.exit(1);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`\ne2e: ${results.length} checks passed`);
