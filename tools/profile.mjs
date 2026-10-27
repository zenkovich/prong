#!/usr/bin/env node
/**
 * Performance profile of Prong against a real (large) repository.
 *
 *   node tools/profile.mjs <repo> [--web <dir>] [--out <dir>] [--browser chromium|webkit] [--only id,id] [--label text]
 *
 * Starts the built engine (server/dist) with a throw-away state folder, opens the repository in a headless browser
 * and runs the everyday scenarios one after another: open, scroll, select commits and files, branch / tag / remote
 * clicks at growing depth, the branch filter, sidebar groups, search, merge collapsing, Changes, stashes, tabs.
 * Read-only for the repository: nothing is staged, committed, checked out or fetched.
 *
 * Per scenario: time until the expected result, time until the page is idle again, main-thread blocking,
 * engine calls, DOM / SVG size, JS heap and (Chromium) style/layout/script time and the hottest functions.
 * A scenario that never settles is reported as FROZEN; the page is then reloaded and the run continues.
 * Build the web UI without minification for readable function names:
 *   npx expo export --platform web --no-minify --output-dir <dir>
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const REPO = path.resolve(argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) ?? '.');
const WEB = path.resolve(opt('--web', path.join(ROOT, 'macos/build/web')));
const OUT = path.resolve(opt('--out', mkdtempSync(path.join(tmpdir(), 'prong-profile-'))));
const BROWSER = opt('--browser', 'chromium');
const ONLY = opt('--only', '')?.split(',').filter(Boolean) ?? [];
const LABEL = opt('--label', '');
const ENGINE = path.join(ROOT, 'server/dist/src/index.js');
const ROW = 22;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the repository: pick targets at known depths of the full date-ordered history ----------

const git = (...a) => execFileSync('git', a, { cwd: REPO, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
console.log(`repository ${REPO}`);
const order = git('rev-list', '--date-order', '--all').trim().split('\n');
const pos = new Map(order.map((s, i) => [s, i]));
const refs = git('for-each-ref', '--format=%(refname)%09%(objectname)%09%(*objectname)', 'refs/heads', 'refs/remotes', 'refs/tags')
  .trim()
  .split('\n')
  .map((l) => {
    const [full, oid, peeled] = l.split('\t');
    const sha = peeled || oid;
    const kind = full.startsWith('refs/heads/') ? 'branch' : full.startsWith('refs/remotes/') ? 'remote' : 'tag';
    const name = full.replace(/^refs\/(heads|remotes|tags)\//, '');
    return { name, kind, sha, pos: pos.get(sha) ?? -1 };
  })
  .filter((r) => r.pos >= 0 && !r.name.endsWith('/HEAD'));
let headBranch = '';
try {
  headBranch = git('symbolic-ref', '--short', 'HEAD').trim();
} catch {
  /* detached */
}
const closest = (list, lo, hi, want) => list.filter((r) => r.pos >= lo && r.pos <= hi).sort((a, b) => Math.abs(a.pos - want) - Math.abs(b.pos - want))[0];
const locals = refs.filter((r) => r.kind === 'branch');
const target = {
  near: closest(locals.filter((r) => r.name !== headBranch), 1, 290, 150) ?? locals.find((r) => r.name === headBranch),
  mid: closest(locals, 1000, 6000, 3500),
  far: closest(locals, 6000, 30000, 8000),
  tagFar: closest(refs.filter((r) => r.kind === 'tag'), 10000, 60000, 18000),
  remoteDeep: closest(refs.filter((r) => r.kind === 'remote'), 60000, Infinity, 150000),
  funnel2: closest(locals, 1, 2000, 250),
};
const subject = (sha) => git('log', '-1', '--format=%s', sha).trim();
const filesOf = (sha) => git('show', '--format=', '--name-only', '-m', '--first-parent', sha).trim().split('\n').filter(Boolean);
// an ordinary commit with a handful of files, and the merge with the most files among the newest merges
let normal = null;
for (const sha of order.slice(3, 200)) {
  const parents = git('rev-list', '--parents', '-n1', sha).trim().split(' ').length - 1;
  if (parents !== 1) continue;
  const f = filesOf(sha);
  if (f.length >= 2 && f.length <= 40) {
    normal = { sha, files: f };
    break;
  }
}
let bigMerge = null;
for (const sha of git('rev-list', '--merges', '--date-order', '--all', '-n', '30').trim().split('\n')) {
  if ((pos.get(sha) ?? 1e9) > 280) continue;
  const n = Number(execFileSync('sh', ['-c', `git diff --name-only ${sha}^1 ${sha} | wc -l`], { cwd: REPO }).toString().trim());
  if (!bigMerge || n > bigMerge.files) bigMerge = { sha, files: n };
}
const stashes = git('stash', 'list', '--format=%gs').trim().split('\n').filter(Boolean);
console.log(
  'targets:',
  JSON.stringify({ commits: order.length, refs: refs.length, head: headBranch, ...Object.fromEntries(Object.entries(target).map(([k, v]) => [k, v && `${v.name} @${v.pos}`])), normal: normal && `${normal.sha.slice(0, 8)} @${pos.get(normal.sha)} (${normal.files.length} files)`, bigMerge: bigMerge && `${bigMerge.sha.slice(0, 8)} @${pos.get(bigMerge.sha)} (${bigMerge.files} files)` }),
);

// ---------- engine ----------

const state = mkdtempSync(path.join(tmpdir(), 'prong-profile-state-'));
// ports away from the app's (8790–8799); only an engine that says it listens on the chosen port counts, so a
// taken port can never hand the run someone's real Prong
let port = 18600 + Math.floor(Math.random() * 1000);
let base = `http://127.0.0.1:${port}`;
let engine;
let engineLog = '';
async function startEngine() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const child = spawn(process.execPath, ['--max-old-space-size=8192', ENGINE], { env: { ...process.env, PRONG_PORT: String(port), PRONG_STATE_DIR: state, PRONG_WEB_DIR: WEB, PRONG_SOURCES_DEFAULT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const ok = await new Promise((resolve) => {
      const onData = (b) => {
        engineLog += b;
        if (engineLog.includes(`listening on http://127.0.0.1:${port}`)) resolve(true);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', () => resolve(false));
      setTimeout(() => resolve(false), 20000);
    });
    if (ok) {
      engine = child;
      return;
    }
    child.kill('SIGKILL');
    port = 18600 + Math.floor(Math.random() * 1000);
    base = `http://127.0.0.1:${port}`;
  }
  throw new Error('engine did not start:\n' + engineLog);
}
async function engineAlive() {
  try {
    return (await fetch(base + '/api/health', { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}
await startEngine();
// whatever happens (a browser that fails to launch, an exception), the engine goes with this process
process.on('exit', () => {
  try {
    engine.kill('SIGKILL');
  } catch {}
});
// no avatar lookups over the network: the numbers must not depend on Gravatar
await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatars: false }) });
await fetch(base + '/api/repos/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: REPO }) });

// ---------- browser ----------

const cachedChrome = () => {
  const cache = path.join(homedir(), 'Library/Caches/ms-playwright');
  try {
    const d = readdirSync(cache).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop();
    const p = d && path.join(cache, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
    return p && existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
};
const isChromium = BROWSER === 'chromium';
const browser = isChromium ? await chromium.launch({ executablePath: process.env.CHROME ?? cachedChrome(), headless: true }) : await webkit.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addInitScript((b) => {
  window.__PRONG_SERVER__ = b;
  // instrumentation: engine calls (fetch) and main-thread blocking (a 50 ms heartbeat that notices gaps)
  const P = (window.__prof = { api: [], inflight: 0, lastApi: 0, gaps: [], lastBusy: 0 });
  const of = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const url = String(a[0] instanceof Request ? a[0].url : a[0]).replace(/^https?:\/\/[^/]+/, '');
    const t = performance.now();
    P.inflight++;
    try {
      return await of(...a);
    } finally {
      P.inflight--;
      P.lastApi = performance.now();
      P.api.push({ url, ms: P.lastApi - t, at: t });
    }
  };
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - last > 100) {
      P.gaps.push({ at: last, ms: now - last - 50 });
      P.lastBusy = now;
    }
    last = now;
  }, 50);
}, base);

let page;
let cdp = null;
async function newPage() {
  page = await context.newPage();
  page.on('pageerror', (e) => notes.push('page error: ' + e.message.slice(0, 160)));
  if (isChromium) {
    cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  }
}
const notes = [];
const TIMEOUT = Symbol('timeout');
/** page.evaluate that gives up when the page is frozen */
const evalT = (fn, arg, ms = 4000) => Promise.race([page.evaluate(fn, arg).catch((e) => ({ __error: String(e) })), sleep(ms).then(() => TIMEOUT)]);
const cdpT = (m, p, ms = 15000) => (cdp ? Promise.race([cdp.send(m, p).catch(() => null), sleep(ms).then(() => null)]) : Promise.resolve(null));

async function metrics() {
  const m = await cdpT('Performance.getMetrics');
  const o = {};
  for (const x of m?.metrics ?? []) o[x.name] = x.value;
  return o;
}
async function pageStats() {
  const s = await evalT(() => {
    const t = document.body.innerText;
    const m = t.match(/(\d+) of (\d+)\+? commits/);
    return { dom: document.getElementsByTagName('*').length, svg: document.querySelectorAll('svg *').length, listed: m ? Number(m[2]) : null, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
  });
  return s === TIMEOUT || s?.__error ? {} : s;
}
/**
 * Waits for quiet (no engine call in flight, no main-thread block for 600 ms) and returns when the last activity
 * of the scenario ended, counted from its start (page clock): the time until the page was idle again.
 */
async function settle(t0, cap) {
  const deadline = t0 + cap;
  while (Date.now() < deadline) {
    const s = await evalT(() => ({ inflight: window.__prof.inflight, lastBusy: window.__prof.lastBusy, lastApi: window.__prof.lastApi, start: window.__prof.start ?? 0, now: performance.now() }));
    if (s !== TIMEOUT && !s.__error && s.inflight === 0 && s.now - s.lastBusy > 600 && s.now - s.lastApi > 400) return Math.round(Math.max(0, Math.max(s.lastBusy, s.lastApi) - s.start));
    await sleep(100);
  }
  return null;
}
async function until(pred, arg, t0, cap) {
  while (Date.now() < t0 + cap) {
    const ok = await evalT(pred, arg);
    if (ok === true) return Date.now() - t0;
    if (ok && typeof ok === 'object' && ok.notice) return { ms: Date.now() - t0, notice: ok.notice };
    await sleep(50);
  }
  return null;
}
function topFunctions(profile, n = 6) {
  if (!profile) return [];
  const self = new Map();
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    const cf = node.callFrame;
    if (cf.functionName === '(idle)') continue;
    const file = cf.url ? cf.url.split('/').pop().replace(/-[0-9a-f]{16,}/, '') : '';
    const key = `${cf.functionName || '(anonymous)'}${file ? ` ${file}:${cf.lineNumber + 1}` : ''}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => `${k} ${Math.round(ms)}ms`);
}

// ---------- UI actions ----------

const repoName = path.basename(REPO);
async function openRepo() {
  await page.goto(base, { waitUntil: 'load' });
  await page.getByText(repoName, { exact: true }).first().click({ timeout: 30000 });
}
const newestSubject = subject(order[0]);
const listShows = (s) => (document.querySelector('[data-testid="commit-scroll"]')?.innerText ?? '').includes(s);
async function recover(why) {
  notes.push(why);
  if (!(await engineAlive())) {
    notes.push('engine is down — restarting it');
    try {
      engine.kill('SIGKILL');
    } catch {}
    await startEngine();
  }
  await Promise.race([page.close({ runBeforeUnload: false }).catch(() => {}), sleep(5000)]);
  await newPage();
  await openRepo();
  await until(listShows, newestSubject, Date.now(), 120000);
  await settle(Date.now(), 60000);
}
/** scroll the history so the row of `sha` is on screen, then click it; resolves with the moment of the click */
async function clickCommit(sha) {
  const s = subject(sha);
  const idx = pos.get(sha) ?? 0;
  await evalT((y) => {
    const sc = document.querySelector('[data-testid="commit-scroll"]');
    if (sc) sc.scrollTop = Math.max(0, y - 200);
  }, (idx + 1) * ROW);
  await sleep(500);
  const box = await evalT((s) => {
    const sc = document.querySelector('[data-testid="commit-scroll"]');
    if (!sc) return null;
    const r0 = sc.getBoundingClientRect();
    const hits = [...sc.querySelectorAll('div')].filter((d) => d.children.length === 0 && d.textContent === s).map((d) => d.getBoundingClientRect()).filter((r) => r.top >= r0.top && r.bottom <= r0.bottom);
    return hits[0] ? { x: hits[0].x + 20, y: hits[0].y + hits[0].height / 2 } : null;
  }, s);
  if (!box || box === TIMEOUT || box.__error) throw new Error('commit row not on screen: ' + s);
  await evalT(() => (window.__prof.mark = performance.now()));
  const t1 = Date.now();
  await page.mouse.click(box.x, box.y);
  return t1;
}
/** the "Filter files" box of the commit details narrows a long file list */
async function sidebarFilterFiles(text) {
  const box = page.getByPlaceholder('Filter files');
  if (await box.count()) {
    await box.first().fill(text);
    await sleep(400);
  }
}
async function sidebarFilter(text) {
  const input = page.getByPlaceholder('filter branches');
  await input.fill(text);
}
async function clickRef(r) {
  let row = page.getByTestId(`branch-${r.name}`);
  if (r.kind === 'tag') row = page.getByTestId('group-tags').getByText(r.name, { exact: true });
  if (!(await row.count())) {
    await sidebarFilter(r.kind === 'remote' ? r.name.split('/').slice(1).join('/') : r.name);
    await sleep(300);
    row = r.kind === 'tag' ? page.getByTestId('group-tags').getByText(r.name, { exact: true }) : page.getByTestId(`branch-${r.name}`);
  }
  await row.first().scrollIntoViewIfNeeded({ timeout: 10000 });
  return row.first();
}
const revealed = (s) => {
  const row = document.querySelector('[data-testid="selected-commit"]');
  if (row && row.innerText.includes(s)) return true;
  const t = document.body.innerText;
  for (const n of ['Older than the loaded history', 'Hidden by the branch filter', 'Too deep in the history']) if (t.includes(n)) return { notice: n };
  return false;
};
const apiDone = (op) => window.__prof.api.some((a) => a.url.includes(op) && a.at >= window.__prof.mark);

// ---------- scenarios ----------

const S = [];
const sc = (id, title, run, cap = 60000) => S.push({ id, title, run, cap });

sc('open', 'open the repository (cold engine cache)', async (t0) => {
  await openRepo();
  return until(listShows, newestSubject, t0, 120000);
}, 120000);
sc('scroll', 'scroll the history: 40 wheel steps of 600 px', async (t0) => {
  const r = await page.getByTestId('commit-scroll').boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await evalT(() => {
    const f = (window.__frames = []);
    const tick = (ts) => {
      f.push(ts);
      if (f.length < 100000 && !window.__stopFrames) requestAnimationFrame(tick);
    };
    window.__stopFrames = false;
    requestAnimationFrame(tick);
  });
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 600);
    await sleep(30);
  }
  const ms = Date.now() - t0;
  const fr = await evalT(() => {
    window.__stopFrames = true;
    const f = window.__frames;
    let gap = 0;
    for (let i = 1; i < f.length; i++) gap = Math.max(gap, f[i] - f[i - 1]);
    return { fps: f.length > 1 ? Math.round((f.length - 1) / ((f[f.length - 1] - f[0]) / 1000)) : 0, maxGap: Math.round(gap) };
  }, undefined, 30000);
  return { ms, notice: fr === TIMEOUT ? 'frames: page frozen' : `${fr.fps} fps, longest frame ${fr.maxGap} ms` };
});
sc('select-commit', 'select an ordinary commit', async (t0) => {
  if (!normal) return { ms: 0, notice: 'no ordinary commit found' };
  const t1 = await clickCommit(normal.sha);
  return until(apiDone, 'commitFiles', t1, 60000);
});
sc('select-file', 'select a file of that commit', async (t0) => {
  if (!normal) return { ms: 0, notice: 'no ordinary commit found' };
  const file = normal.files[normal.files.length > 1 ? 1 : 0];
  const leaf = file.split('/').pop();
  const box = await evalT((leaf) => {
    const d = document.querySelector('[data-testid="commit-description"]');
    const below = d ? d.getBoundingClientRect().bottom : 0;
    const hits = [...document.querySelectorAll('div')].filter((e) => e.children.length === 0 && e.textContent === leaf).map((e) => e.getBoundingClientRect()).filter((r) => r.top > below).sort((a, b) => a.x - b.x);
    return hits[0] ? { x: hits[0].x + 5, y: hits[0].y + hits[0].height / 2 } : null;
  }, leaf);
  if (!box || box === TIMEOUT) return { ms: 0, notice: 'file row not found' };
  await page.mouse.click(box.x, box.y);
  return until((f) => [...document.querySelectorAll('div')].some((e) => e.children.length === 0 && e.textContent === f), file, t0, 30000);
});
/** right-click the row of `normal`'s second file in the commit details and pick a menu item */
async function fileMenu(item) {
  const file = normal.files[normal.files.length > 1 ? 1 : 0];
  const leaf = file.split('/').pop();
  const box = await evalT((leaf) => {
    const d = document.querySelector('[data-testid="commit-description"]');
    const below = d ? d.getBoundingClientRect().bottom : 0;
    const hits = [...document.querySelectorAll('div')].filter((e) => e.children.length === 0 && e.textContent === leaf).map((e) => e.getBoundingClientRect()).filter((r) => r.top > below && r.height > 0).sort((a, b) => a.x - b.x);
    return hits[0] ? { x: hits[0].x + 5, y: hits[0].y + hits[0].height / 2 } : null;
  }, leaf);
  if (!box || box === TIMEOUT) throw new Error('file row not found: ' + file);
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await evalT(() => (window.__prof.mark = performance.now()));
  const t1 = Date.now();
  await page.getByText(item, { exact: true }).first().click();
  return { t1, file };
}
sc('file-history', 'file history of a file (context menu)', async () => {
  if (!normal) return { ms: 0, notice: 'no ordinary commit found' };
  const { t1, file } = await fileMenu('File history');
  const r = await until(() => /History of .* · [1-9]\d* commits/.test(document.body.innerText) && window.__prof.api.some((a) => a.url.includes('logFile') && a.at >= window.__prof.mark), undefined, t1, 120000);
  const n = await evalT(() => (document.body.innerText.match(/History of .* · (\d+) commits/) ?? [])[1]);
  await page.getByText('Close', { exact: true }).first().click().catch(() => {});
  return r === null ? null : { ms: r, notice: `${file}: ${n} commits` };
}, 150000);
sc('blame', 'blame a file (context menu)', async () => {
  if (!normal) return { ms: 0, notice: 'no ordinary commit found' };
  const { t1, file } = await fileMenu('Blame');
  const r = await until(() => window.__prof.api.some((a) => a.url.includes('blame') && a.at >= window.__prof.mark) && !document.body.innerText.includes('loading…'), undefined, t1, 120000);
  const lines = await evalT(() => (document.body.innerText.match(/(\d+) lines · (\d+) authors?/) ?? [''])[0]);
  await page.getByText('Close', { exact: true }).first().click().catch(() => {});
  return r === null ? null : { ms: r, notice: `${file}: ${lines === TIMEOUT ? '?' : lines || 'no blame shown'}` };
}, 150000);
sc('hover-sidebar', 'move the pointer over 30 sidebar rows', async (t0) => {
  for (let y = 240; y < 900; y += 22) await page.mouse.move(120, y);
  return Date.now() - t0;
});
sc('tags-open', 'open the Tags group', async (t0) => {
  await page.getByTestId('group-tags').getByText('Tags', { exact: true }).first().click();
  return Date.now() - t0;
});
sc('select-with-tags', 'select another commit while Tags is open', async (t0) => {
  const t1 = await clickCommit(order[6]);
  return until(apiDone, 'commitFiles', t1, 60000);
});
sc('tags-close', 'close the Tags group', async (t0) => {
  await page.getByTestId('group-tags').getByText('Tags', { exact: true }).first().click();
  return Date.now() - t0;
});
sc('remotes-open', 'open the Remotes group', async (t0) => {
  await page.getByTestId('group-remotes').getByText('Remotes', { exact: true }).first().click();
  return Date.now() - t0;
});
sc('filter-type', 'type "925" into the branch filter', async (t0) => {
  await page.getByPlaceholder('filter branches').pressSequentially('925', { delay: 60 });
  return Date.now() - t0;
});
sc('filter-clear', 'clear the branch filter text', async (t0) => {
  await page.getByPlaceholder('filter branches').fill('');
  return Date.now() - t0;
});
for (const [id, key, title] of [
  ['click-near', 'near', 'click a branch near the top'],
  ['click-mid', 'mid', 'click a branch ~3500 commits deep'],
  ['click-far', 'far', 'click a branch ~8000 commits deep'],
  ['click-tag', 'tagFar', 'click a tag ~18000 commits deep'],
  ['click-remote', 'remoteDeep', 'click a remote branch >60000 commits deep'],
]) {
  sc(id, `${title}`, async (t0) => {
    const r = target[key];
    if (!r) return { ms: 0, notice: 'no such ref' };
    const row = await clickRef(r);
    const t1 = Date.now();
    await row.click();
    const s = subject(r.sha);
    const res = await until(revealed, s, t1, 120000);
    await sidebarFilter('');
    if (res === null) return null;
    const ms = typeof res === 'number' ? res : res.ms;
    return { ms: ms + (t1 - t0), notice: `${r.name} @${r.pos}${typeof res === 'object' ? ' → ' + res.notice : ''}` };
  }, 150000);
}
sc('funnel-one', 'funnel: show only one branch', async (t0) => {
  const r = target.far ?? target.mid;
  const row = await clickRef(r);
  await row.hover();
  await evalT(() => (window.__prof.mark = performance.now()));
  await page.getByTestId(`funnel-${r.name}`).click();
  const res = await until((n) => !!document.querySelector(`[data-testid="filter-chip-${n}"]`) && window.__prof.api.some((a) => a.url.includes('logPage') && a.at >= window.__prof.mark), r.name, t0, 60000);
  await sidebarFilter('');
  return res;
});
sc('funnel-two', 'funnel: add a second branch', async (t0) => {
  const r = target.funnel2;
  if (!r) return { ms: 0, notice: 'no second branch' };
  const row = await clickRef(r);
  await row.hover();
  await evalT(() => (window.__prof.mark = performance.now()));
  await page.getByTestId(`funnel-${r.name}`).click();
  const res = await until((n) => !!document.querySelector(`[data-testid="filter-chip-${n}"]`) && window.__prof.api.some((a) => a.url.includes('logPage') && a.at >= window.__prof.mark), r.name, t0, 60000);
  await sidebarFilter('');
  return res;
});
sc('funnel-clear', 'clear the branch filter', async (t0) => {
  await page.getByTestId('clear-branch-filter').click();
  return until(() => !document.querySelector('[data-testid="branch-filter-bar"]'), undefined, t0, 60000);
});
sc('search', 'search commits for "ANR", then clear', async (t0) => {
  const input = page.getByPlaceholder('search commits: message, author, sha');
  await input.pressSequentially('ANR', { delay: 60 });
  await settle(Date.now(), 30000);
  await input.fill('');
  return Date.now() - t0;
});
sc('collapse-merges', 'collapse all merges', async (t0) => {
  await page.locator('[aria-label="Collapse all merges"]').first().click();
  return Date.now() - t0;
});
sc('expand-merges', 'expand all merges', async (t0) => {
  await page.locator('[aria-label="Expand all merges"]').first().click();
  return Date.now() - t0;
});
sc('select-big-merge', 'select the merge with the most changed files', async (t0) => {
  if (!bigMerge) return { ms: 0, notice: 'no merge found' };
  const t1 = await clickCommit(bigMerge.sha);
  const r = await until(apiDone, 'commitFiles', t1, 120000);
  if (r === null) return null;
  // what the page shows: the file count in the details, or an error notice
  const shown = await evalT(() => (document.body.innerText.match(/FILES\s*(\d+)/i) ?? [])[1] ?? (document.body.innerText.match(/failed[^\n]*/i) ?? [''])[0]);
  return { ms: r, notice: `${bigMerge.files} files; details show: ${shown === TIMEOUT ? 'page busy' : shown || '?'}` };
}, 150000);
sc('big-merge-file', 'select a file of that merge (diff on demand)', async (t0) => {
  if (!bigMerge) return { ms: 0, notice: 'no merge found' };
  const file = execFileSync('sh', ['-c', `git diff --name-only ${bigMerge.sha}^1 ${bigMerge.sha} | grep -E '\\.(cs|txt|json|md|py|ts|js|xml|yaml|cpp|h)$' | head -1`], { cwd: REPO }).toString().trim();
  if (!file) return { ms: 0, notice: 'no text file in the merge' };
  await sidebarFilterFiles(file.split('/').pop());
  const leaf = file.split('/').pop();
  const box = await evalT((leaf) => {
    const d = document.querySelector('[data-testid="commit-description"]');
    const below = d ? d.getBoundingClientRect().bottom : 0;
    const hits = [...document.querySelectorAll('div')].filter((e) => e.children.length === 0 && e.textContent === leaf).map((e) => e.getBoundingClientRect()).filter((r) => r.top > below && r.height > 0).sort((a, b) => a.x - b.x);
    return hits[0] ? { x: hits[0].x + 5, y: hits[0].y + hits[0].height / 2 } : null;
  }, leaf);
  if (!box || box === TIMEOUT) return { ms: 0, notice: 'file row not found: ' + file };
  await evalT(() => (window.__prof.mark = performance.now()));
  const t1 = Date.now();
  await page.mouse.click(box.x, box.y);
  const r = await until((f) => [...document.querySelectorAll('div')].some((e) => e.children.length === 0 && e.textContent === f) && !document.body.innerText.includes('Loading the diff'), file, t1, 60000);
  return r === null ? null : { ms: r, notice: file };
}, 90000);
sc('changes', 'open Changes and select the first change', async (t0) => {
  await page.getByText('Changes', { exact: true }).first().click();
  await sleep(300);
  return Date.now() - t0;
});
sc('stash', 'select a stash', async (t0) => {
  if (!stashes.length) return { ms: 0, notice: 'no stashes' };
  await evalT(() => (window.__prof.mark = performance.now()));
  await page.getByText('All Commits', { exact: true }).first().click();
  const group = page.getByTestId('group-stashes');
  if (!(await group.getByText(/\{0\}/).count())) await group.getByText('Stashes', { exact: true }).first().click();
  await sleep(300);
  await evalT(() => (window.__prof.mark = performance.now()));
  const t1 = Date.now();
  await group.getByText(/\{0\}/).first().click();
  return until(apiDone, 'stashFiles', t1, 60000);
});
sc('tab-switch', 'go Home and back to the repository', async (t0) => {
  await page.getByTestId('home-button').click();
  await page.getByText(repoName, { exact: true }).first().click();
  return until(listShows, '', t0, 60000);
});

// ---------- run ----------

await newPage();
const rows = [];
for (const s of S) {
  if (ONLY.length && !ONLY.includes(s.id) && s.id !== 'open') continue;
  notes.length = 0;
  await evalT(() => {
    if (!window.__prof) return;
    window.__prof.api = [];
    window.__prof.gaps = [];
    window.__prof.start = performance.now();
  }).catch(() => {});
  const m0 = await metrics();
  if (cdp) await cdpT('Profiler.start');
  const t0 = Date.now();
  let res;
  let error = null;
  try {
    res = await Promise.race([s.run(t0), sleep(s.cap).then(() => null)]);
  } catch (e) {
    error = String(e?.message ?? e).split('\n')[0];
  }
  const resultMs = res == null ? null : typeof res === 'number' ? res : res.ms;
  const settled = error ? null : await settle(t0, s.cap);
  const prof = cdp ? await cdpT('Profiler.stop', undefined, 30000) : null;
  const m1 = await metrics();
  const p = await evalT(() => ({ api: window.__prof.api, gaps: window.__prof.gaps }));
  const live = p !== TIMEOUT && !p?.__error;
  const gaps = live ? p.gaps : [];
  const api = live ? p.api : [];
  const stats = await pageStats();
  const d = (k) => (m1[k] != null && m0[k] != null ? Math.round((m1[k] - m0[k]) * 1000) : null);
  const row = {
    id: s.id,
    title: s.title,
    resultMs,
    settledMs: settled,
    frozen: settled === null && !error,
    blockedMs: Math.round(gaps.reduce((a, g) => a + g.ms, 0)),
    longestBlockMs: Math.round(Math.max(0, ...gaps.map((g) => g.ms))),
    script: d('ScriptDuration'),
    style: d('RecalcStyleDuration'),
    layout: d('LayoutDuration'),
    api: api.length,
    slowestApi: api.sort((a, b) => b.ms - a.ms).slice(0, 2).map((a) => `${a.url.replace(/^\/api\/(repo\/)?/, '').split('?')[0]} ${Math.round(a.ms)}ms`),
    ...stats,
    top: topFunctions(prof?.profile),
    notice: res && typeof res === 'object' ? res.notice : undefined,
    error,
    notes: [...notes],
  };
  rows.push(row);
  console.log(`${row.frozen ? 'FROZEN' : error ? 'ERROR ' : 'ok    '} ${s.id.padEnd(18)} result ${String(resultMs ?? '—').padStart(6)} ms  idle ${String(settled ?? '—').padStart(6)} ms  blocked ${String(row.blockedMs).padStart(6)} ms (max ${row.longestBlockMs})  dom ${row.dom ?? '?'} svg ${row.svg ?? '?'} commits ${row.listed ?? '?'}${row.notice ? '  · ' + row.notice : ''}${error ? '  · ' + error : ''}`);
  try {
    await page.screenshot({ path: path.join(OUT, `${String(rows.length).padStart(2, '0')}-${s.id}.png`), timeout: 10000 });
  } catch {}
  if (row.frozen || error || !(await engineAlive())) await recover(row.frozen ? `${s.id}: page frozen, reloaded` : error ? `${s.id}: ${error}` : `${s.id}: engine died`);
}

// ---------- report ----------

const fmt = (v) => (v == null ? '—' : String(v));
const md = [
  `# Prong profile${LABEL ? ` — ${LABEL}` : ''}`,
  '',
  `${REPO} · ${order.length} commits · ${refs.length} refs · ${BROWSER} · ${new Date().toISOString()}`,
  '',
  '| scenario | result ms | idle ms | blocked ms | longest block | script / style / layout ms | engine calls | DOM | SVG | commits | heap MB | note |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.title} | ${fmt(r.resultMs)} | ${r.frozen ? '**FROZEN**' : fmt(r.settledMs)} | ${r.blockedMs} | ${r.longestBlockMs} | ${fmt(r.script)} / ${fmt(r.style)} / ${fmt(r.layout)} | ${r.api}${r.slowestApi.length ? ` (${r.slowestApi.join(', ')})` : ''} | ${fmt(r.dom)} | ${fmt(r.svg)} | ${fmt(r.listed)} | ${fmt(r.heap)} | ${[r.notice, r.error, ...r.notes].filter(Boolean).join('; ')} |`),
  '',
  '## Hottest functions (self time)',
  '',
  ...rows.filter((r) => r.top.length).map((r) => `- **${r.id}**: ${r.top.join(' · ')}`),
];
writeFileSync(path.join(OUT, 'report.md'), md.join('\n') + '\n');
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ repo: REPO, browser: BROWSER, label: LABEL, target, normal, bigMerge, rows }, null, 2));
console.log(`\nreport: ${path.join(OUT, 'report.md')}`);
await browser.close();
engine.kill();
process.exit(0);
