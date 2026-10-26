import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'prong-dbg-'));
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x' } }).toString();
const repo = path.join(tmp, 'repos', 'demo'); mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q', '-b', 'main'); writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
git(repo, 'branch', 'feature/one'); git(repo, 'branch', 'feature/two');
const bare = path.join(tmp, 'origin.git'); git(tmp, 'init', '-q', '--bare', bare); git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', '-q', 'origin', 'main', 'feature/one', 'feature/two');
const port = 8652;
const engine = spawn(process.execPath, [path.join(ROOT, 'server/dist/src/index.js')], { env: { ...process.env, PRONG_PORT: String(port), PRONG_STATE_DIR: path.join(tmp, 'state'), PRONG_WEB_DIR: path.join(ROOT, 'macos/build/web') }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
await fetch(`http://127.0.0.1:${port}/api/repos/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: repo, workspace: 'work' }) });
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.addInitScript((b) => (window.__PRONG_SERVER__ = b), `http://127.0.0.1:${port}`);
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.getByText('demo', { exact: true }).first().click();
await page.waitForTimeout(1500);
const has = async (s) => (await page.evaluate(() => document.body.innerText)).includes(s);
// 1. sidebar + : hover the Branches header, click the plus
const hdr = page.getByText('Branches', { exact: true }).first();
await hdr.hover();
await page.waitForTimeout(200);
const plus = page.locator('[aria-label="New branch"]');
console.log('plus buttons visible:', await plus.count());
if (await plus.count()) { await plus.first().hover(); await page.waitForTimeout(150); console.log('after hovering the plus, still there:', await plus.count()); await plus.first().click().catch((e) => console.log('click failed', e.message.split('\n')[0])); }
await page.waitForTimeout(400);
console.log('dialog after sidebar +:', await has('New branch') && (await page.locator('input[placeholder="feature/…"]').count()) > 0);
await page.keyboard.press('Escape');
// 2. toolbar Branch button
await page.getByText('Branch', { exact: true }).first().click();
await page.waitForTimeout(400);
console.log('dialog after toolbar Branch:', (await page.locator('input[placeholder="feature/…"]').count()) > 0);
if (await page.locator('input[placeholder="feature/…"]').count()) { await page.locator('input[placeholder="feature/…"]').fill('feature/three'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500); console.log('feature/three listed:', await has('three')); console.log(git(repo, 'branch')); }
// 3. delete a remote branch via its context menu
await page.getByText('origin', { exact: true }).first().click(); await page.waitForTimeout(500);
console.log(await page.evaluate(() => document.body.innerText.split('\n').filter((l) => /one|two|three|origin|feature/.test(l)).join(' | ')));
await browser.close(); engine.kill(); rmSync(tmp, { recursive: true, force: true });
