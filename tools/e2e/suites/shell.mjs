/**
 * The shell around the repositories, as a Fork user meets it: the start screen (workspaces, the repository list and
 * its menus, Open / Clone / Init, accounts, the status panel there), the tabs and the ⌘T repository list, opening a
 * repository (what the user picks while it loads stays), Clone, Preferences (accounts, SSH keys, General), the
 * layout (splitters, narrow and wide windows, interface scale) and the crash boundary.
 *
 * Checks start with their part ("shell · tabs: …"), so E2E_ONLY='shell · tabs' runs one part. Each part makes the
 * repositories it changes. Nothing reaches the machine or the network: "Reveal in Finder", the terminal, the
 * editor, GitHub, ssh-agent and `ssh -T` are answered by the page (`page.route`); the engine keeps git's global
 * settings in the run's own file (harness: GIT_CONFIG_GLOBAL) and its secrets in its state folder (test mode).
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { ROOT, base, page, check, expect, until, git, root, tmp, state, sshKeys, gitGlobal, finish, post, pageErrors, text } from '../harness.mjs';

const SHOTS = path.join(ROOT, '..', 'shots');
mkdirSync(SHOTS, { recursive: true });
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `shell-${n}.png`) }).catch(() => {});
const tid = (id) => page.getByTestId(id);
const has = async (id) => (await tid(id).count()) > 0;
const waitGone = (id, ms = 6000) => page.waitForFunction((id) => !document.querySelector(`[data-testid="${CSS.escape(id)}"]`), id, { timeout: ms });
const waitShown = (id, ms = 8000) => tid(id).first().waitFor({ timeout: ms });
const textOf = (id) => page.evaluate((id) => document.querySelector(`[data-testid="${CSS.escape(id)}"]`)?.textContent ?? null, id);
const statusText = () => page.evaluate(() => document.querySelector('[data-testid="status-bar"]')?.textContent ?? '');
const readJson = (f, fb) => {
  try {
    return JSON.parse(readFileSync(path.join(state, f), 'utf8'));
  } catch {
    return fb;
  }
};
const reposJson = () => readJson('repos.json', []);
const settings = () => fetch(base + '/api/settings').then((r) => r.json());
const sleep = (ms) => page.waitForTimeout(ms);
/** two clicks on one element within 450 ms count as a double click */
const settle = () => sleep(600);

/** a menu, dialog, picker or error left open by a failed check is closed before the next one */
async function calm() {
  for (let i = 0; i < 5 && (await page.locator('[data-testid="context-menu"], [data-testid="modal"], [data-testid="modal-error"], [data-testid="repo-picker"]').count()); i++) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }
}
const step = (name, fn) =>
  check(name, async () => {
    await calm();
    await fn();
  });

/** right click on `loc`: the menu's items with their state */
async function menuOf(loc) {
  await loc.click({ button: 'right' });
  await tid('context-menu').waitFor({ timeout: 3000 });
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="context-menu"] [data-testid="menu-item"]')].map((e) => ({ label: (e.firstElementChild?.firstElementChild ?? e).textContent.trim(), disabled: e.getAttribute('aria-disabled') === 'true' })),
  );
}
const labels = (items) => items.map((i) => `${i.label}${i.disabled ? ' (off)' : ''}`).join(' | ');
async function closeMenu() {
  await page.keyboard.press('Escape');
  await waitGone('context-menu');
}
/** right click on `loc`, then the item `label` (it must be there and enabled) */
async function menu(loc, label) {
  const items = await menuOf(loc);
  const it = items.find((i) => (label instanceof RegExp ? label.test(i.label) : i.label === label));
  expect(it && !it.disabled, `menu item ${label}: ${labels(items)}`);
  await page.locator('[data-testid="context-menu"] [data-testid="menu-item"]').filter({ hasText: label }).first().click();
  await waitGone('context-menu');
}
/** a dialog button is disabled */
const disabled = (id) => page.evaluate((id) => document.querySelector(`[data-testid="${CSS.escape(id)}"]`)?.getAttribute('aria-disabled') === 'true', id);
/** the value of an input by its testID */
const valueOf = (id) => page.evaluate((id) => document.querySelector(`[data-testid="${CSS.escape(id)}"]`)?.value ?? null, id);
/** the start screen's repository cards, in their order */
const cards = () => page.evaluate(() => [...document.querySelectorAll('[data-testid^="repo-card-"]')].map((e) => e.getAttribute('data-testid').slice('repo-card-'.length)));
/** the tabs in the bar (without group frames and arrows) */
const tabs = () => page.evaluate(() => [...document.querySelectorAll('[data-testid^="tab-"]')].map((e) => e.getAttribute('data-testid')).filter((id) => !/^tab-(group|arrow)-/.test(id)).map((id) => id.slice(4)));
const home = async () => {
  await calm();
  await tid('home-button').click();
  await waitShown('repo-filter');
  if (await valueOf('repo-filter')) await tid('repo-filter').fill('');
};
/** opens a repository from the start screen by its card and waits for its history */
async function open(name) {
  await home();
  await tid(`repo-card-${name}`).click();
  await waitShown('sidebar-commits', 15000);
  await page.waitForFunction(() => !/loading/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
}
const dirOf = (name) => path.join(root, name);
/** a repository of this suite: one commit of `files` (no page reload: `register()` lists them all at once) */
function repo(name, files = { 'README.md': `# ${name}\n` }, then) {
  const dir = dirOf(name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'user.name', 'Shell Suite');
  git(dir, 'config', 'user.email', 'shell@example.com');
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
  then?.(dir);
  return dir;
}
/** the scans of @work and @home register what is new in the fixtures folder; the page reloads to list it */
async function register() {
  for (const ws of ['work', 'home']) await post('/api/scan', { path: root, depth: 1, register: true, workspace: ws });
  await page.goto('about:blank');
  await page.goto(base, { waitUntil: 'load' });
  await waitShown('activity-box', 20000);
  await sleep(1200); // the saved session brings its tabs back a moment later
}
/** a reload, then the moment the saved session has brought its tabs back */
async function reload() {
  await page.reload({ waitUntil: 'load' });
  await waitShown('activity-box', 20000);
  await sleep(1500);
}
/** a fresh launch with no tabs (the session is saved half a second after a change: leave the page first) */
async function freshLaunch() {
  await page.goto('about:blank');
  await fetch(base + '/api/session', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  await page.goto(base, { waitUntil: 'load' });
  await waitShown('repo-filter', 20000);
}

/** GitHub stands in: one account (made up), its sign-in state, its repositories */
const fakeAcc = { id: 'github.com:sh-mock-user', host: 'github.com', login: 'sh-mock-user', name: 'Sh Mock', orgs: ['sh-org'] };
async function withAccount(state, fn, repos = []) {
  const routes = [
    ['**/api/accounts', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: [fakeAcc] }) : r.fallback())],
    ['**/api/accounts/check', (r) => r.fulfill({ json: { [fakeAcc.id]: { state } } })],
    ['**/api/github/repos', (r) => r.fulfill({ json: (JSON.parse(r.request().postData() ?? '{}').page ?? 1) === 1 ? repos : [] })],
    ['**/api/github/access', (r) => r.fulfill({ json: { kind: 'pat', installations: [] } })],
  ];
  for (const [u, h] of routes) await page.route(u, h);
  try {
    await reload();
    await home();
    await waitShown(`account-${fakeAcc.login}`, 10000);
    await fn();
  } finally {
    for (const [u, h] of routes) await page.unroute(u, h);
    await reload();
  }
}

/** what the page asked the system for (reveal, terminal, open in an app): answered here, never by the engine */
const systemCalls = [];
await page.route('**/api/system/**', (route) => {
  const req = route.request();
  systemCalls.push({ what: new URL(req.url()).pathname.split('/').pop(), body: req.postDataJSON() });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});
/** what the page asked ssh-agent and `ssh -T` for: answered here (the user's agent and known_hosts stay untouched) */
const sshCalls = [];
await page.route('**/api/ssh/agentAdd', (route) => {
  sshCalls.push({ what: 'agentAdd', body: route.request().postDataJSON() });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});
await page.route('**/api/ssh/test', (route) => {
  sshCalls.push({ what: 'test', body: route.request().postDataJSON() });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ opId: 'e2e-ssh-test' }) });
});
// GitHub is never called: a check that needs it answers it itself (a route added later wins)
await page.route('**/api/github/**', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"e2e: GitHub is not called"}' }));
await page.route('**/api/accounts', (route) => (route.request().method() === 'GET' ? route.continue() : route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"e2e: no sign-in without an answer of the check"}' })));
// the dialogs start at ~/work: a clone or an init outside the run's folder is refused here
const inRun = (p) => typeof p === 'string' && p.startsWith(tmp);
await page.route('**/api/repos/clone', (route) => (inRun(route.request().postDataJSON()?.dir) ? route.continue() : route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"e2e guard: a clone outside the run"}' })));
await page.route('**/api/repos/init', (route) => (inRun(route.request().postDataJSON()?.path) ? route.continue() : route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"e2e guard: an init outside the run"}' })));

/** a link the page would open in the browser (GitHub pages): recorded, never followed */
await page.addInitScript(() => {
  window.__opened = [];
  // as a browser does: a tab opened with the "noopener" feature gives no handle back (null)
  window.open = (u, _t, features) => (window.__opened.push(String(u)), /noopener/.test(String(features ?? '')) ? null : { opener: window, closed: false });
  // what the page copies (the clipboard of a headless browser is not readable)
  window.__copied = [];
  try {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => void window.__copied.push(String(t)), readText: async () => '' }, configurable: true });
  } catch {}
});

// ---------- repositories of this suite ----------

repo('sh-plain');
repo('sh-counts', { 'a.txt': 'one\n', 'b.txt': 'b\n' }, (d) => {
  writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\n');
  git(d, 'add', 'a.txt');
  writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\nthree\n'); // staged and changed again: one file
});
repo('sh-pin');
repo('sh-remove');
repo('sh-move');
repo('sh-zeta-deep', { 'src/x.txt': 'x\n' });
for (const n of ['sh-tab-a', 'sh-tab-b', 'sh-tab-c']) repo(n, { 'README.md': `# ${n}\n` }, (d) => {
  writeFileSync(path.join(d, 'second.txt'), '2\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', `Second commit of ${n}`);
});
repo('sh-load', { 'a.txt': 'a\n' }, (d) => {
  for (const m of ['Second', 'Third']) {
    writeFileSync(path.join(d, `${m}.txt`), m);
    git(d, 'add', '-A');
    git(d, 'commit', '-q', '-m', `${m} commit`);
  }
  writeFileSync(path.join(d, 'a.txt'), 'a\nchanged\n');
});
await register();

// ======================================================================================
// the start screen
// ======================================================================================

await step('shell · start: a repository never opened says so (not "1/1/1970"), names its branch, and shows no endless "…"', async () => {
  await home();
  await waitShown('repo-card-sh-plain');
  const when = await textOf('repo-when-sh-plain');
  expect(when && !/1970/.test(when) && /not opened|never/i.test(when), 'when: ' + when);
  const branch = await textOf('repo-branch-sh-plain');
  expect(branch === 'main', 'the branch before it is opened: ' + branch);
  const badge = await textOf('repo-changes-sh-plain');
  expect(badge !== '…', 'no "…" that never fills: ' + badge);
  await shot('start');
});

await step('shell · start: a click opens the repository in a tab on its newest commit; the card then counts each changed file once, "1 change"', async () => {
  await open('sh-counts');
  expect((await tabs()).includes('sh-counts'), 'a tab: ' + (await tabs()));
  await waitShown('selected-commit');
  expect((await tid('selected-commit').innerText()).includes('Initial commit'), 'the newest commit selected');
  await home();
  // a.txt is staged and changed again: two rows in Changes, one changed file
  await page.waitForFunction(() => /change/.test(document.querySelector('[data-testid="repo-changes-sh-counts"]')?.textContent ?? ''), null, { timeout: 8000 });
  const badge = await textOf('repo-changes-sh-counts');
  expect(badge === '1 change', 'one file: ' + badge);
  expect((await textOf('repo-when-sh-counts')) === 'now', 'opened now: ' + (await textOf('repo-when-sh-counts')));
});

await step('shell · start: the filter narrows by name and by path, says when nothing matches, and clearing it lists all again', async () => {
  await home();
  const all = await cards();
  await tid('repo-filter').fill('zeta');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="repo-card-"]').length === 1, null, { timeout: 3000 });
  expect((await cards())[0] === 'sh-zeta-deep', 'by name: ' + (await cards()));
  // by path: the folder of the fixtures is in every path
  await tid('repo-filter').fill(path.basename(root));
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="repo-card-"]').length === n, all.length, { timeout: 3000 });
  await tid('repo-filter').fill('no-such-repository-xyz');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="repo-card-"]').length === 0, null, { timeout: 3000 });
  const empty = (await textOf('repo-list-empty')) ?? '';
  expect(/match/i.test(empty) && empty.includes('no-such-repository-xyz') && !/yet/.test(empty), 'says nothing matches the filter, not that the workspace is empty: ' + empty);
  await tid('repo-filter').fill('');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="repo-card-"]').length === n, all.length, { timeout: 3000 });
});

await step('shell · start: Pin puts a repository first with a pin, it stays pinned after a reload, Unpin puts it back', async () => {
  await home();
  await menu(tid('repo-card-sh-pin'), 'Pin');
  await page.waitForFunction(() => document.querySelector('[data-testid^="repo-card-"]')?.getAttribute('data-testid') === 'repo-card-sh-pin', null, { timeout: 3000 });
  await until(() => reposJson().find((r) => r.name === 'sh-pin')?.pinned === true, 'the engine keeps the pin: ' + JSON.stringify(reposJson().find((r) => r.name === 'sh-pin')));
  await reload();
  await home();
  await waitShown('repo-card-sh-pin');
  expect((await cards())[0] === 'sh-pin', 'still first after a reload: ' + (await cards()).slice(0, 3));
  const items = await menuOf(tid('repo-card-sh-pin'));
  expect(items.some((i) => i.label === 'Unpin'), 'the menu offers Unpin: ' + labels(items));
  await page.locator('[data-testid="context-menu"] [data-testid="menu-item"]').filter({ hasText: 'Unpin' }).click();
  await until(() => !reposJson().find((r) => r.name === 'sh-pin')?.pinned, 'unpinned in the engine');
  await page.waitForFunction(() => document.querySelector('[data-testid^="repo-card-"]')?.getAttribute('data-testid') !== 'repo-card-sh-pin', null, { timeout: 3000 });
});

await step('shell · start: Remove from list takes the card away, the engine forgets it, and a rescan or a reload does not bring it back', async () => {
  await home();
  await menu(tid('repo-card-sh-remove'), 'Remove from list');
  await waitGone('repo-card-sh-remove');
  await until(() => !reposJson().some((r) => r.name === 'sh-remove' && !r.hidden), 'the engine no longer lists it');
  await tid('ws-rescan').click();
  await statusHasText(/Scanned/);
  await sleep(500);
  expect(!(await has('repo-card-sh-remove')), 'a rescan of the folder it is in does not bring it back');
  await reload();
  await home();
  expect(!(await has('repo-card-sh-remove')), 'nor a reload (the start scan)');
  expect(existsSync(dirOf('sh-remove')), 'nothing deleted on disk');
});

await step('shell · start: Move to @lab takes the repository out of @work into @lab, its tab closes', async () => {
  await open('sh-move');
  await home();
  await menu(tid('repo-card-sh-move'), 'Move to @lab');
  await waitGone('repo-card-sh-move');
  expect(!(await tabs()).includes('sh-move'), 'its tab closed: ' + (await tabs()));
  await until(() => reposJson().find((r) => r.name === 'sh-move')?.workspace === 'lab', 'the engine moved it');
  await tid('ws-lab').click();
  await waitShown('repo-card-sh-move');
  await tid('ws-work').click();
  await waitShown('repo-card-sh-plain');
});

await step('shell · start: Reveal in Finder and Open in Terminal from a card ask for that folder', async () => {
  await home();
  systemCalls.length = 0;
  await menu(tid('repo-card-sh-plain'), 'Reveal in Finder');
  await menu(tid('repo-card-sh-plain'), 'Open in Terminal');
  await until(() => systemCalls.length >= 2, 'two calls: ' + JSON.stringify(systemCalls));
  expect(systemCalls[0].what === 'reveal' && systemCalls[0].body.path === dirOf('sh-plain'), 'reveal that folder: ' + JSON.stringify(systemCalls[0]));
  expect(systemCalls[1].what === 'terminal' && systemCalls[1].body.path === dirOf('sh-plain'), 'a terminal there: ' + JSON.stringify(systemCalls[1]));
  // Open from the menu opens it, as a click does
  await menu(tid('repo-card-sh-plain'), 'Open');
  await waitShown('sidebar-commits', 15000);
  expect((await tabs()).includes('sh-plain'), 'opened');
});

/** the status panel shows text matching `re` */
async function statusHasText(re, ms = 15000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), re.source, { timeout: ms });
}

// ---------- workspaces ----------

await step('shell · workspaces: a row switches and is marked with its count; its menu has Switch, Edit…, Rescan folder, Delete', async () => {
  await home();
  await tid('ws-home').click();
  await page.waitForFunction(() => /@home/.test(document.querySelector('[data-testid="workspace-button"]')?.textContent?.toLowerCase().replace('@ ', '@') ?? ''), null, { timeout: 3000 }).catch(() => {});
  expect(/home/i.test(await tid('workspace-button').innerText()), 'the tab bar names @home: ' + (await tid('workspace-button').innerText()));
  expect((await text()).includes('@home ·'), 'the list is @home’s');
  const items = await menuOf(tid('ws-lab'));
  expect(['Switch', 'Edit…', 'Rescan folder', 'Delete'].every((l) => items.some((i) => i.label === l && !i.disabled)), 'every item, enabled: ' + labels(items));
  await page.locator('[data-testid="context-menu"] [data-testid="menu-item"]').filter({ hasText: 'Switch' }).click();
  await page.waitForFunction(() => /lab/i.test(document.querySelector('[data-testid="workspace-button"]')?.textContent ?? ''), null, { timeout: 3000 });
  await waitShown('repo-card-gamma');
  // the count next to a workspace is the number of its repositories
  const n = await page.evaluate(() => document.querySelector('[data-testid="ws-lab"]')?.innerText.trim().split(/\s+/).pop());
  expect(n === String(await page.locator('[data-testid^="repo-card-"]').count()), 'count ' + n);
  await menu(tid('ws-lab'), 'Edit…');
  await waitShown('ws-name');
  expect((await valueOf('ws-name')) === 'lab', 'edits lab');
  await page.keyboard.press('Escape');
  await waitGone('ws-name');
  // back to @work, whose tabs are open: the start screen stays, the tabs come back in the bar
  await tid('ws-work').click();
  await waitShown('repo-card-sh-plain');
  expect(await has('repo-filter'), 'still the start screen');
  expect((await tabs()).includes('sh-plain'), '@work’s tabs are back: ' + (await tabs()));
});

await step('shell · workspaces: New workspace refuses an empty or taken name; Create & switch makes it active, with the empty-list message', async () => {
  await home();
  await tid('ws-new').click();
  await waitShown('ws-name');
  expect(await disabled('ws-save'), 'an empty name is refused');
  await tid('ws-name').fill('work');
  expect(await disabled('ws-save'), 'a taken name is refused');
  await tid('ws-name').fill('sh-fresh');
  expect(!(await disabled('ws-save')), 'a new name is accepted');
  await page.keyboard.press('Enter');
  await waitGone('ws-name');
  await page.waitForFunction(() => /sh-fresh/i.test(document.querySelector('[data-testid="workspace-button"]')?.textContent ?? ''), null, { timeout: 3000 });
  const empty = (await textOf('repo-list-empty')) ?? '';
  expect(/No repositories in @sh-fresh yet/.test(empty), 'the empty workspace says so: ' + empty);
  await until(async () => (await fetch(base + '/api/workspaces').then((r) => r.json())).some((w) => w.name === 'sh-fresh'), 'saved in the engine');
});

await step('shell · workspaces: Edit renames, and a root folder with its depth scans the repositories into the workspace', async () => {
  await home();
  await tid('ws-sh-fresh').click({ button: 'right' });
  await page.locator('[data-testid="context-menu"] [data-testid="menu-item"]').filter({ hasText: 'Edit…' }).click();
  await waitShown('ws-name');
  await tid('ws-name').fill('sh-renamed');
  await tid('ws-root-input').fill(path.join(root, 'home-root'));
  await tid('ws-depth').fill('1');
  await tid('ws-save').click();
  await waitGone('ws-name');
  await waitShown('ws-sh-renamed');
  await waitShown('repo-card-gamma', 15000);
  const ws = (await fetch(base + '/api/workspaces').then((r) => r.json())).find((w) => w.name === 'sh-renamed');
  expect(ws && ws.rootPath === path.join(root, 'home-root') && ws.scanDepth === 1, 'saved: ' + JSON.stringify(ws));
  expect((await textOf('ws-root'))?.includes('home-root'), 'the folder is shown next to the title');
});

await step('shell · workspaces: Delete asks first, moves its repositories to another workspace, and stays deleted after a reload', async () => {
  await home();
  // a repository whose own workspace is the one deleted (opened into it), not only found by its scan
  const own = repo('sh-ws-own');
  await post('/api/repos/open', { path: own, workspace: (await fetch(base + '/api/workspaces').then((r) => r.json())).find((w) => w.name === 'sh-renamed').id });
  await reload();
  await home();
  await tid('ws-sh-renamed').click();
  await waitShown('repo-card-sh-ws-own', 15000);
  await menu(tid('ws-sh-renamed'), 'Delete');
  await waitShown('confirm-ok');
  expect(/Nothing is deleted on disk/.test((await textOf('confirm-message')) ?? ''), 'explains');
  await tid('confirm-ok').click();
  await waitGone('ws-sh-renamed');
  await until(async () => !(await fetch(base + '/api/workspaces').then((r) => r.json())).some((w) => w.name === 'sh-renamed'), 'gone in the engine');
  await reload();
  await home();
  const names = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="ws-"]')].map((e) => e.getAttribute('data-testid')));
  expect(!names.some((n) => /sh-renamed|ws-ws-/.test(n)), 'it does not come back (as its id) after a reload: ' + names);
  const entry = reposJson().find((r) => r.path === own);
  const ids = (await fetch(base + '/api/workspaces').then((r) => r.json())).map((w) => w.id);
  expect(entry && ids.includes(entry.workspace), 'its repository moved to a workspace that exists: ' + JSON.stringify(entry));
  await tid('ws-work').click();
  await waitShown('repo-card-sh-plain');
});

await step('shell · start: Rescan reports the repositories it found; Change folder… opens the workspace settings (no folder picker on the web)', async () => {
  await home();
  await tid('ws-rescan').click();
  await statusHasText(/Scanned/);
  expect(/repositories/.test(await statusText()), 'the count: ' + (await statusText()));
  await tid('ws-choose-folder').click();
  await waitShown('ws-root-input');
  expect((await valueOf('ws-root-input')) === root, 'the folder it scans: ' + (await valueOf('ws-root-input')));
  await page.keyboard.press('Escape');
  await waitGone('ws-root-input');
  await tid('ws-root').click();
  await waitShown('ws-root-input');
  await page.keyboard.press('Escape');
  await waitGone('ws-root-input');
});

await step('shell · workspaces: the @workspace menu in the tab bar switches (with that workspace’s tabs), and opens New workspace… and the settings', async () => {
  await open('sh-plain');
  await tid('workspace-button').click();
  await waitShown('workspace-menu');
  await page.locator('[data-testid="workspace-menu"]').getByText('@home', { exact: true }).click();
  await page.waitForFunction(() => /home/i.test(document.querySelector('[data-testid="workspace-button"]')?.textContent ?? ''), null, { timeout: 3000 });
  expect(!(await tabs()).includes('sh-plain'), '@home has its own tabs: ' + (await tabs()));
  await tid('workspace-button').click();
  await page.locator('[data-testid="workspace-menu"]').getByText('@work', { exact: true }).click();
  // switched from a repository: back in @work's repository
  await waitShown('sidebar-commits');
  expect((await tabs()).includes('sh-plain'), '@work’s tabs back');
  await tid('workspace-button').click();
  await page.getByText('New workspace…', { exact: true }).click();
  await waitShown('ws-name');
  expect((await valueOf('ws-name')) === '', 'a new one');
  await page.keyboard.press('Escape');
  await waitGone('ws-name');
  await tid('workspace-button').click();
  await page.getByText('@work settings…', { exact: true }).click();
  await waitShown('ws-name');
  expect((await valueOf('ws-name')) === 'work' && (await valueOf('ws-root-input')) === root, 'edits @work');
  await page.keyboard.press('Escape');
  await waitGone('ws-name');
  // Escape closes the menu
  await tid('workspace-button').click();
  await waitShown('workspace-menu');
  await page.keyboard.press('Escape');
  await waitGone('workspace-menu');
});

await step('shell · workspaces: Rescan folder from a workspace’s menu scans it', async () => {
  await home();
  await menu(tid('ws-lab'), 'Rescan folder');
  await statusHasText(/Scanned .*home-root/);
});

await step('shell · start: a dropped path opens that repository; a folder dropped without one says how to open it, and the window stays', async () => {
  await home();
  const drop = (data) => page.evaluate((data) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(data)) dt.setData(k, v);
    const zone = document.querySelector('[data-testid="drop-zone"]');
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    zone.dispatchEvent(over);
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    zone.dispatchEvent(ev);
    return { overTaken: over.defaultPrevented, dropTaken: ev.defaultPrevented };
  }, data);
  const r = await drop({ 'text/uri-list': `file://${encodeURI(dirOf('sh-zeta-deep'))}/` });
  expect(r.overTaken && r.dropTaken, 'the window takes the drop (the browser would open the file instead): ' + JSON.stringify(r));
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tab-sh-zeta-deep"]'), null, { timeout: 10000 });
  await home();
  // a folder from Finder: no path in a web page
  const r2 = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'some-folder'));
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('[data-testid="drop-zone"]').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(r2, 'taken, not opened by the browser');
  await statusHasText(/does not say where it is/);
  expect(page.url().startsWith(base), 'still Prong: ' + page.url());
  // a click on the zone opens the Open dialog
  await tid('drop-zone').click();
  await waitShown('open-path');
  await page.keyboard.press('Escape');
});

await step('shell · start: with the engine away the start screen says so and how to start it; it comes back by itself', async () => {
  const down = (route) => route.abort('connectionrefused');
  await page.route('**/api/health', down);
  const errors = pageErrors.length;
  try {
    await page.reload({ waitUntil: 'load' });
    await waitShown('engine-offline-hint', 15000);
    expect(/npm run server/.test((await textOf('engine-offline-hint')) ?? ''), 'how to start it');
    expect(/engine offline/.test(await statusText()), 'the status panel: ' + (await statusText()));
  } finally {
    await page.unroute('**/api/health', down);
  }
  // the page asks again every 5 s
  await waitGone('engine-offline-hint', 15000);
  await sleep(1500);
  pageErrors.splice(errors); // the refused connections were made on purpose
});

await step('shell · start: an account whose check could not be done says "not checked", not "ok"', async () => {
  await withAccount('error', async () => {
    await page.waitForFunction((id) => /not checked/i.test(document.querySelector(`[data-testid="${id}"]`)?.textContent ?? ''), `account-${fakeAcc.login}`, { timeout: 10000 });
  });
});

// ---------- open, init, clone from the start screen ----------

await step('shell · start: Open (the button and ⌘O): Enter opens the typed folder; a folder that is no repository says so and the dialog stays', async () => {
  await home();
  await page.keyboard.press('Meta+o');
  await waitShown('open-path', 3000);
  expect(!/myhouse/.test((await valueOf('open-path')) ?? ''), 'no stray default path: ' + (await valueOf('open-path')));
  await page.keyboard.press('Escape');
  await waitGone('open-path');
  await tid('action-open').click();
  await waitShown('open-path');
  const notRepo = path.join(tmp, 'not-a-repo');
  mkdirSync(notRepo, { recursive: true });
  await tid('open-path').fill(notRepo);
  await tid('open-go').click();
  await waitShown('error-dialog');
  expect(/Not a git repository/.test((await textOf('error-detail')) ?? ''), 'why: ' + (await textOf('error-detail')));
  await tid('error-close').click();
  await waitGone('error-dialog');
  expect(await has('open-path'), 'the dialog stays to fix the path');
  // a repository outside the scanned folder: registered in the active workspace and opened
  const outside = path.join(tmp, 'outside', 'sh-outside');
  mkdirSync(outside, { recursive: true });
  git(outside, 'init', '-q', '-b', 'main');
  git(outside, '-c', 'user.name=x', '-c', 'user.email=x@x', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'Outside commit');
  await tid('open-path').fill(outside);
  await tid('open-path').press('Enter');
  await waitGone('open-path');
  await waitShown('sidebar-commits', 15000);
  expect((await tabs()).includes('sh-outside'), 'its tab');
  await until(() => reposJson().some((r) => r.path === outside && r.workspace === 'work'), 'registered in @work');
});

await step('shell · start: the status panel there keeps the session’s errors: its ⚠ opens the log', async () => {
  await home();
  await waitShown('error-log-button');
  expect(/\d/.test(await tid('error-log-button').innerText()), 'a count: ' + (await tid('error-log-button').innerText()));
  await tid('error-log-button').click();
  await waitShown('error-dialog');
  expect(/Open repository failed/.test((await textOf('error-title')) ?? ''), 'the last error: ' + (await textOf('error-title')));
  await tid('error-close').click();
  await waitGone('error-dialog');
});

await step('shell · start: Init makes a repository on disk, lists it and opens it on its branch', async () => {
  await home();
  await tid('action-init').click();
  await waitShown('init-path');
  const dir = path.join(tmp, 'outside', 'sh-inited');
  await tid('init-path').fill(dir);
  await tid('init-go').click();
  await waitGone('init-path', 8000);
  await until(() => existsSync(path.join(dir, '.git')), 'a repository on disk');
  await waitShown('sidebar-changes', 15000);
  expect((await tabs()).includes('sh-inited'), 'opened in a tab: ' + (await tabs()));
  expect(!(await has('error-dialog')), 'no error: ' + (await textOf('error-detail')));
  await until(() => reposJson().some((r) => r.path === dir), 'registered');
  await page.waitForFunction(() => /main/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 8000 });
});

await step('shell · start: Clone opens from its button and from ⌘⇧N', async () => {
  await home();
  await page.keyboard.press('Meta+Shift+N');
  await waitShown('clone-url', 3000);
  await page.keyboard.press('Escape');
  await waitGone('clone-url');
  await tid('action-clone').click();
  await waitShown('clone-url');
  await page.keyboard.press('Escape');
  await waitGone('clone-url');
});

await step('shell · start: Add account and SSH keys open Preferences on their tabs', async () => {
  await home();
  await tid('accounts-add').click();
  await waitShown('accounts-token');
  await page.keyboard.press('Escape');
  await waitGone('accounts-token');
  await tid('accounts-ssh').click();
  await waitShown('ssh-generate');
  await page.keyboard.press('Escape');
  await waitGone('ssh-generate');
});

// ======================================================================================
// tabs and the ⌘T repository list
// ======================================================================================

const showing = (subject, ms = 10000) => page.waitForFunction((s) => (document.querySelector('[data-testid="commit-scroll"]')?.innerText ?? '').includes(s), subject, { timeout: ms });

await step('shell · tabs: each opened repository gets a tab, a click on a tab shows that repository', async () => {
  for (const n of ['sh-tab-a', 'sh-tab-b', 'sh-tab-c']) await open(n);
  const t = await tabs();
  for (const n of ['sh-tab-a', 'sh-tab-b', 'sh-tab-c']) expect(t.includes(n), `${n} has a tab: ${t}`);
  await tid('tab-sh-tab-a').click();
  await showing('Second commit of sh-tab-a');
  await tid('tab-sh-tab-c').click();
  await showing('Second commit of sh-tab-c');
  // the open repository's tab is the one marked
  const marked = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="tab-sh-tab-"]')].filter((e) => getComputedStyle(e.querySelector('div') ?? e).color && [...e.querySelectorAll('div')].some((d) => d.textContent === '▸' && getComputedStyle(d).color !== 'rgba(0, 0, 0, 0)')).map((e) => e.getAttribute('data-testid')));
  expect(marked.length === 1 && marked[0] === 'tab-sh-tab-c', 'one tab marked, the shown one: ' + marked);
});

await step('shell · tabs: the × of a tab that is not active closes it (it used to vanish under the pointer)', async () => {
  for (const n of ['sh-tab-a', 'sh-tab-b', 'sh-tab-c']) if (!(await tabs()).includes(n)) await open(n);
  await tid('tab-sh-tab-c').click();
  await showing('Second commit of sh-tab-c');
  await tid('tab-sh-tab-a').hover();
  await waitShown('close-tab-sh-tab-a', 2000);
  await tid('close-tab-sh-tab-a').click({ timeout: 3000 });
  await waitGone('tab-sh-tab-a', 3000);
  await showing('Second commit of sh-tab-c'); // the shown one stays
});

await step('shell · tabs: the × of the active tab closes it and shows its neighbour; closing the last one shows the start screen', async () => {
  for (const n of ['sh-tab-a', 'sh-tab-b', 'sh-tab-c']) if (!(await tabs()).includes(n)) await open(n);
  const order = await tabs();
  await tid('tab-sh-tab-b').click();
  await showing('Second commit of sh-tab-b');
  const next = order[order.indexOf('sh-tab-b') + 1] ?? order[order.indexOf('sh-tab-b') - 1];
  await tid('close-tab-sh-tab-b').click();
  await waitGone('tab-sh-tab-b');
  await showing(next.startsWith('sh-tab-') ? `Second commit of ${next}` : '');
  // close all of them: the start screen
  for (const n of await tabs()) {
    await tid(`tab-${n}`).click();
    await tid(`close-tab-${n}`).click();
    await waitGone(`tab-${n}`);
  }
  await waitShown('repo-filter');
});

await step('shell · tabs: closing a tab from the start screen keeps the start screen', async () => {
  await open('sh-tab-a');
  await open('sh-tab-b');
  await home();
  await tid('tab-sh-tab-b').hover();
  await tid('close-tab-sh-tab-b').click();
  await waitGone('tab-sh-tab-b');
  await sleep(300);
  expect(await has('repo-filter'), 'still the start screen (it used to jump into the next repository)');
});

await step('shell · tabs: ⌘W closes the active tab', async () => {
  await open('sh-tab-c');
  await showing('Second commit of sh-tab-c');
  await page.keyboard.press('Meta+w');
  await waitGone('tab-sh-tab-c');
});

await step('shell · tabs: the tab menu: Close, Close others, Reveal in Finder, Copy path', async () => {
  for (const n of ['sh-tab-a', 'sh-tab-b', 'sh-tab-c']) if (!(await tabs()).includes(n)) await open(n);
  const items = await menuOf(tid('tab-sh-tab-b'));
  for (const l of ['Close', 'Close others', 'Reveal in Finder', 'Copy path']) expect(items.some((i) => i.label === l && !i.disabled), `${l}: ${labels(items)}`);
  await closeMenu();
  systemCalls.length = 0;
  await menu(tid('tab-sh-tab-b'), 'Reveal in Finder');
  await until(() => systemCalls.some((c) => c.what === 'reveal' && c.body.path === dirOf('sh-tab-b')), 'reveals its folder: ' + JSON.stringify(systemCalls));
  await page.evaluate(() => (window.__copied.length = 0));
  await menu(tid('tab-sh-tab-b'), 'Copy path');
  await page.waitForFunction((p) => window.__copied.includes(p), dirOf('sh-tab-b'), { timeout: 3000 });
  await menu(tid('tab-sh-tab-b'), 'Close others');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="tab-"]')].filter((e) => !/^tab-(group|arrow)-/.test(e.getAttribute('data-testid'))).length === 1, null, { timeout: 3000 });
  expect((await tabs())[0] === 'sh-tab-b', 'only it is left: ' + (await tabs()));
  await menu(tid('tab-sh-tab-b'), 'Close');
  await waitGone('tab-sh-tab-b');
});

await step('shell · tabs: after a reload the tabs come back; closing the shown one shows the next one read, not an empty repository', async () => {
  for (const n of ['sh-tab-a', 'sh-tab-b']) await open(n);
  await tid('tab-sh-tab-a').click();
  await showing('Second commit of sh-tab-a');
  await sleep(800); // the session is saved half a second after a change
  await reload();
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tab-sh-tab-b"]'), null, { timeout: 10000 });
  await showing('Second commit of sh-tab-a');
  // sh-tab-b came back as a tab but was never shown: closing sh-tab-a must read it
  await tid('close-tab-sh-tab-a').click();
  await waitGone('tab-sh-tab-a');
  await showing('Second commit of sh-tab-b');
  await tid('close-tab-sh-tab-b').click();
  await waitShown('repo-filter');
});

await step('shell · tabs: a repository opened right after launch stays open and shown when the last session’s tabs come back', async () => {
  await open('sh-tab-a');
  await sleep(800);
  // the session answers late (in the app the engine is still asking Claude Code for its version)
  const late = async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  };
  await page.route('**/api/session', late);
  try {
    await page.reload({ waitUntil: 'load' });
    await waitShown('repo-card-sh-tab-c', 15000);
    await tid('repo-card-sh-tab-c').click();
    await showing('Second commit of sh-tab-c');
    await sleep(3500); // the saved session (sh-tab-a) comes back now
    await showing('Second commit of sh-tab-c');
    const t = await tabs();
    expect(t.includes('sh-tab-c') && t.includes('sh-tab-a'), 'both tabs: ' + t);
  } finally {
    await page.unroute('**/api/session', late);
  }
  for (const n of await tabs()) {
    await tid(`tab-${n}`).click();
    await tid(`close-tab-${n}`).click();
    await waitGone(`tab-${n}`);
  }
});

await step('shell · tabs: a tab of a repository deleted from disk says so, with Try again, Close tab and Remove from list', async () => {
  const dir = repo('sh-gone');
  await register();
  await open('sh-gone');
  await sleep(800);
  rmSync(dir, { recursive: true, force: true });
  await reload();
  await waitShown('repo-missing', 15000);
  await shot('gone');
  const t = (await textOf('repo-missing')) ?? '';
  expect(/Not a git repository any more/.test(t) && t.includes(dir), 'says what and where: ' + t);
  expect(!(await has('error-dialog')), 'no error dialog on top of it');
  expect(!/loading/i.test(await statusText()), 'not loading forever: ' + (await statusText()));
  // back where it was: Try again reads it
  repo('sh-gone');
  await tid('missing-retry').click();
  await waitGone('repo-missing', 10000);
  await showing('Initial commit');
  await sleep(1500); // its commit's files are read a moment later
  // gone again: Remove from list takes it off the list and closes the tab
  rmSync(dir, { recursive: true, force: true });
  await tid('tab-sh-gone').click();
  await refreshTab();
  await waitShown('repo-missing', 10000);
  await tid('missing-remove').click();
  await waitGone('tab-sh-gone');
  await home();
  expect(!(await has('repo-card-sh-gone')), 'off the list');
});

/** the active repository read again (More → Refresh) */
async function refreshTab() {
  await page.getByText('More', { exact: true }).first().click();
  await page.getByText('Refresh', { exact: true }).first().click();
  await sleep(600);
}

await step('shell · tabs: a repository and its submodule’s tab: the menu folds and unfolds the group and closes both', async () => {
  await open('superproject');
  await tid('submodule-libs/core').click();
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tab-libs/core"]'), null, { timeout: 10000 });
  await open('alpha'); // the group folds only while none of it is shown
  let items = await menuOf(tid('tab-superproject'));
  expect(items.some((i) => i.label === 'Close with submodules (2)') && items.some((i) => i.label === 'Collapse group'), labels(items));
  await page.locator('[data-testid="context-menu"] [data-testid="menu-item"]').filter({ hasText: 'Collapse group' }).click();
  await waitGone('tab-libs/core');
  items = await menuOf(tid('tab-superproject'));
  expect(items.some((i) => i.label === 'Expand group'), labels(items));
  await page.locator('[data-testid="context-menu"] [data-testid="menu-item"]').filter({ hasText: 'Expand group' }).click();
  await waitShown('tab-libs/core');
  await menu(tid('tab-superproject'), 'Close with submodules (2)');
  await waitGone('tab-superproject');
  expect(!(await tabs()).includes('libs/core'), 'both closed: ' + (await tabs()));
  await showing('Add app module'); // alpha still shown
});

await step('shell · tabs: with more tabs than fit, the bar scrolls with the wheel and keeps the active tab in view', async () => {
  await page.setViewportSize({ width: 1000, height: 800 });
  try {
    const names = ['alpha', 'beta', 'customer-analytics-dashboard', 'mobile-client-ios-and-android', 'payments-service-backend-api', 'superproject', 'sh-plain', 'sh-pin', 'sh-tab-a', 'sh-tab-b', 'sh-tab-c', 'sh-zeta-deep'];
    for (const n of names) await open(n);
    const bar = await page.evaluate(() => {
      const first = document.querySelector('[data-testid="tab-alpha"]');
      let el = first?.parentElement;
      while (el && !(el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'visible')) el = el.parentElement;
      return el ? { sw: el.scrollWidth, cw: el.clientWidth, left: el.scrollLeft } : null;
    });
    expect(bar, 'the bar overflows (and scrolls)');
    const active = await tid('tab-sh-zeta-deep').boundingBox();
    const agent = await page.locator('[data-testid="agent-button"], [data-testid="agent-bar"]').first().boundingBox();
    expect(active && active.x >= 0 && active.x + active.width <= agent.x + 1, 'the active tab is in view: ' + JSON.stringify(active));
    // a mouse wheel over the bar reaches the first tabs
    const first = await tid('tab-alpha').boundingBox();
    expect(first.x < 0 || first.x + first.width > agent.x, 'the first tab is scrolled away: ' + JSON.stringify(first));
    const box = await tid('tab-sh-zeta-deep').boundingBox();
    await page.mouse.move(box.x + 10, box.y + 8);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -200);
    await sleep(300);
    const after = await tid('tab-alpha').boundingBox();
    expect(after.x >= 0 && after.x + after.width <= agent.x + 1, 'the wheel brings the first tabs back: ' + JSON.stringify(after));
    await tid('tab-alpha').click();
    await showing('Add app module');
    await shot('tabs-overflow');
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

await step('shell · ⌘T: the repository list: open ones marked, typing narrows by name or path, nothing matching says so', async () => {
  await page.keyboard.press('Meta+t');
  await waitShown('repo-picker');
  const all = await page.locator('[data-testid^="picker-repo-"]').count();
  expect(all >= 10, 'this workspace’s repositories: ' + all);
  expect(/open/.test(await tid('picker-repo-alpha').innerText()), 'an open one is marked');
  expect(!/\bopen\b/.test(await tid('picker-repo-sh-counts').innerText().catch(() => '')) || (await tabs()).includes('sh-counts'), 'one without a tab is not');
  await page.keyboard.type('zeta');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="picker-repo-"]').length === 1, null, { timeout: 3000 });
  // by path: every repository of the run lives in a folder named prong-e2e-…, no name says so
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('prong-e2e');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="picker-repo-"]').length === n, all, { timeout: 3000 });
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('nothing-like-this');
  await page.waitForFunction(() => /Nothing matches/.test(document.querySelector('[data-testid="repo-picker"]')?.textContent ?? ''), null, { timeout: 3000 });
  await page.keyboard.press('Escape');
  await waitGone('repo-picker');
});

await step('shell · ⌘T: arrows keep the picked row in view in a short window, Enter opens it', async () => {
  await page.setViewportSize({ width: 1440, height: 420 });
  try {
    await page.keyboard.press('Meta+t');
    await waitShown('repo-picker');
    const n = await page.locator('[data-testid^="picker-repo-"]').count();
    for (let i = 0; i < n - 1; i++) await page.keyboard.press('ArrowDown');
    await sleep(200);
    const v = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid^="picker-repo-"]')];
      const cur = rows.find((r) => getComputedStyle(r.firstElementChild ?? r).backgroundColor !== 'rgba(0, 0, 0, 0)');
      let sc = cur?.parentElement;
      while (sc && !(sc.scrollHeight > sc.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      if (!cur || !sc) return { found: !!cur, scroller: !!sc };
      const a = cur.getBoundingClientRect();
      const b = sc.getBoundingClientRect();
      return { name: cur.getAttribute('data-testid'), last: rows[rows.length - 1].getAttribute('data-testid'), inView: a.top >= b.top - 1 && a.bottom <= b.bottom + 1 };
    });
    expect(v.name === v.last && v.inView, 'the last row is picked and in view: ' + JSON.stringify(v));
    const name = v.name.slice('picker-repo-'.length);
    await page.keyboard.press('Enter');
    await waitGone('repo-picker');
    await page.waitForFunction((n) => !!document.querySelector(`[data-testid="tab-${n}"]`), name, { timeout: 10000 });
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

await step('shell · ⌘T: the footer: Open folder…, Clone…, and the start page', async () => {
  await tid('new-tab').click();
  await waitShown('repo-picker');
  await page.locator('[data-testid="repo-picker"]').getByText('Open folder…', { exact: true }).click();
  await waitShown('open-path');
  await page.keyboard.press('Escape');
  await waitGone('open-path');
  await tid('new-tab').click();
  await page.locator('[data-testid="repo-picker"]').getByText('Clone…', { exact: true }).click();
  await waitShown('clone-url');
  await page.keyboard.press('Escape');
  await waitGone('clone-url');
  await tid('new-tab').click();
  await page.locator('[data-testid="repo-picker"] [aria-label="Start page"]').click();
  await waitShown('repo-filter');
  expect(!(await has('repo-picker')), 'closed');
});

await step('shell · ⌘T: Escape closes the list alone (the agent bar stays open)', async () => {
  await open('alpha');
  await page.keyboard.press('Meta+j');
  await waitShown('agent-bar', 3000).catch(() => {});
  const barOpen = await has('agent-input');
  await page.keyboard.press('Meta+t');
  await waitShown('repo-picker');
  await page.keyboard.press('Escape');
  await waitGone('repo-picker');
  if (barOpen) expect(await has('agent-input'), 'the agent bar is still open');
  await page.keyboard.press('Escape');
});

// ======================================================================================
// opening a repository
// ======================================================================================

/** the engine's answer to the repository read comes `ms` late */
async function slowSnapshot(ms, fn) {
  const late = async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue().catch(() => {});
  };
  await page.route('**/api/repo/snapshot', late);
  try {
    await fn();
  } finally {
    await page.unroute('**/api/repo/snapshot', late);
  }
}

await step('shell · open: Changes clicked while the repository loads stays (it used to jump back to All Commits)', async () => {
  await slowSnapshot(2500, async () => {
    await home();
    await tid('repo-card-sh-load').click();
    await waitShown('sidebar-changes', 10000);
    await tid('sidebar-changes').click();
    await sleep(3500);
  });
  await waitShown('commit-summary', 5000);
  expect(!(await has('commit-scroll')), 'still Changes, not the history');
});

await step('shell · open: a commit clicked while the repository loads stays selected', async () => {
  // read once (its last snapshot is kept), then a fresh window: the kept snapshot paints at once, git answers late
  await calm();
  if ((await tabs()).includes('sh-load')) {
    await tid('tab-sh-load').click();
    await tid('close-tab-sh-load').click();
  }
  await sleep(800);
  await reload();
  await slowSnapshot(3000, async () => {
    await home();
    await tid('repo-card-sh-load').click();
    await page.getByText('Second commit', { exact: true }).first().waitFor({ timeout: 8000 });
    await page.getByText('Second commit', { exact: true }).first().click();
    await sleep(3800);
  });
  await waitShown('selected-commit');
  expect((await tid('selected-commit').innerText()).includes('Second commit'), 'the picked commit: ' + (await tid('selected-commit').innerText()));
});

await step('shell · open: a repository with no commits yet names its branch, its history says there are none, Changes lists its files', async () => {
  const dir = path.join(root, 'sh-unborn');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'trunk');
  writeFileSync(path.join(dir, 'first.txt'), 'first\n');
  await register();
  await home();
  expect((await textOf('repo-branch-sh-unborn')) === 'trunk', 'the card names its branch: ' + (await textOf('repo-branch-sh-unborn')));
  await tid('repo-card-sh-unborn').click();
  await waitShown('sidebar-commits', 15000);
  await page.waitForFunction(() => /trunk/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 8000 });
  expect(/no commits yet/.test(await statusText()), 'says there are no commits yet: ' + (await statusText()));
  expect(!/…/.test(await statusText()), 'no "…": ' + (await statusText()));
  // its history says there is none yet (not that a filter hides it), with its uncommitted file
  await page.waitForFunction(() => /No commits yet\./.test(document.querySelector('[data-testid="commit-scroll"]')?.textContent ?? document.body.innerText), null, { timeout: 5000 });
  expect(!/No commits match/.test(await text()), 'not "No commits match the current filter"');
  await tid('sidebar-changes').click();
  await page.getByTestId('file-unstaged-first.txt').waitFor({ timeout: 5000 });
  await home();
  expect((await textOf('repo-changes-sh-unborn')) === '1 change', 'the card: ' + (await textOf('repo-changes-sh-unborn')));
});

// ======================================================================================
// Clone
// ======================================================================================

const clones = path.join(tmp, 'clones');
mkdirSync(clones, { recursive: true });
const bare = path.join(tmp, 'origins', 'sh-src.git');
mkdirSync(path.dirname(bare), { recursive: true });
execFileSync('git', ['clone', '-q', '--bare', dirOf('sh-plain'), bare]);
execFileSync('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: bare });
const ghBare = path.join(tmp, 'origins', 'sh-gh.git');
execFileSync('git', ['clone', '-q', '--bare', dirOf('sh-plain'), ghBare]);

async function openClone(source = 'URL') {
  await home();
  await tid('action-clone').click();
  await waitShown('clone-url');
  if (source) await page.locator('[data-testid="modal"]').getByText(source, { exact: true }).first().click();
}

await step('shell · clone: Clone is off until there is an address; the folder name follows the address and can be changed; the clone is listed in the workspace and opens', async () => {
  await openClone();
  expect(await disabled('clone-go'), 'off without an address');
  expect((await valueOf('clone-dir')) === root, 'the parent folder starts at the workspace’s folder (its scan finds the clone): ' + (await valueOf('clone-dir')));
  await tid('clone-url').fill(bare);
  await page.waitForFunction(() => document.querySelector('[data-testid="clone-name"]')?.value === 'sh-src', null, { timeout: 3000 });
  expect(!(await disabled('clone-go')), 'on with an address');
  await tid('clone-name').fill('sh-cloned');
  expect((await valueOf('clone-name')) === 'sh-cloned', 'the name can be typed (it used to ignore typing): ' + (await valueOf('clone-name')));
  await tid('clone-name').fill('');
  expect(await disabled('clone-go'), 'off without a name');
  await tid('clone-name').fill('sh-cloned');
  await tid('clone-dir').fill(clones);
  await tid('clone-name').press('Enter');
  await waitGone('clone-url', 8000);
  await statusHasText(/Cloning sh-cloned: done/, 30000);
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tab-sh-cloned"]'), null, { timeout: 15000 });
  expect(existsSync(path.join(clones, 'sh-cloned', 'README.md')), 'cloned into the folder under the typed name');
  await until(() => reposJson().some((r) => r.path === path.join(clones, 'sh-cloned') && r.workspace === 'work'), 'registered in @work');
  await home();
  await waitShown('repo-card-sh-cloned');
});

await step('shell · clone: a folder that exists already is refused with the reason; the dialog stays with what was typed', async () => {
  await openClone();
  await tid('clone-url').fill(bare);
  await tid('clone-name').fill('sh-cloned');
  await tid('clone-dir').fill(clones);
  await tid('clone-go').click();
  await waitShown('error-dialog');
  expect(/Already exists/.test((await textOf('error-detail')) ?? ''), 'why: ' + (await textOf('error-detail')));
  await tid('error-close').click();
  await waitGone('error-dialog');
  expect((await valueOf('clone-url')) === bare && (await valueOf('clone-name')) === 'sh-cloned', 'the dialog keeps the address and the name (it used to close)');
  await page.keyboard.press('Escape');
  await waitGone('clone-url');
});

await step('shell · clone: Partial clone and Clone submodules recursively go with the request; a partial clone gets the contents on demand', async () => {
  const sent = [];
  const spy = (route) => {
    sent.push(route.request().postDataJSON());
    return route.fallback();
  };
  await page.route('**/api/repos/clone', spy);
  try {
    await openClone();
    await tid('clone-url').fill(`file://${bare}`);
    await tid('clone-name').fill('sh-partial');
    await tid('clone-dir').fill(clones);
    await tid('clone-recursive').click();
    await tid('clone-partial').click();
    await tid('clone-go').click();
    await statusHasText(/Cloning sh-partial: done/, 30000);
    // a finished clone opens in a tab
    await page.waitForFunction(() => !!document.querySelector('[data-testid="tab-sh-partial"]'), null, { timeout: 15000 });
  } finally {
    await page.unroute('**/api/repos/clone', spy);
  }
  expect(sent.length === 1 && sent[0].partial === true && sent[0].recursive === false && sent[0].name === 'sh-partial', 'the request: ' + JSON.stringify(sent));
  expect(git(path.join(clones, 'sh-partial'), 'config', '--get', 'remote.origin.partialclonefilter').trim() === 'blob:none', 'a partial clone');
});

await step('shell · clone: Connection lists System default, the SSH keys and the accounts; Test says whether the address can be read with it', async () => {
  await openClone();
  await tid('clone-url').fill(bare);
  await tid('clone-connection').click();
  await waitShown('pick-default');
  for (const v of ['pick-default', 'pick-ssh:e2e_work', 'pick-ssh:e2e_personal']) expect(await has(v), v);
  await tid('pick-ssh:e2e_personal').click();
  expect(/SSH key e2e_personal/.test(await tid('clone-connection').innerText()), 'chosen: ' + (await tid('clone-connection').innerText()));
  await tid('clone-test').click();
  await page.waitForFunction(() => /Readable with this connection/.test(document.querySelector('[data-testid="clone-test-result"]')?.textContent ?? ''), null, { timeout: 20000 });
  await tid('clone-url').fill(path.join(tmp, 'origins', 'nothing-here.git'));
  expect(!(await has('clone-test-result')), 'a new address forgets the last result');
  await tid('clone-test').click();
  await page.waitForFunction(() => /Not readable with this connection/.test(document.querySelector('[data-testid="clone-test-result"]')?.textContent ?? ''), null, { timeout: 20000 });
  await tid('clone-url').fill('');
  expect(await disabled('clone-test'), 'no Test without an address');
  await page.locator('[data-testid="modal"]').getByText('Cancel', { exact: true }).click();
  await waitGone('clone-url');
});

await step('shell · clone: without an account the GitHub tab offers Connect GitHub, which opens Accounts; Choose… says the folder picker is in the macOS app', async () => {
  await openClone('');
  await waitShown('clone-connect-github');
  await tid('clone-choose').click();
  await statusHasText(/Folder picker is available in the macOS app/);
  await tid('clone-connect-github').click();
  await waitShown('accounts-token');
  await page.keyboard.press('Escape');
  await waitGone('accounts-token');
});

await step('shell · clone: GitHub (answered here): the list and its count, the filter, a click fills the address, a double click clones', async () => {
  const repos = [
    { fullName: 'sh-mock-user/sh-gh', sshUrl: ghBare, httpsUrl: '', private: true, pushedAt: '', description: '' },
    { fullName: 'sh-mock-user/other-thing', sshUrl: path.join(tmp, 'origins', 'other.git'), httpsUrl: '', private: false, pushedAt: '', description: '' },
  ];
  await withAccount('ok', async () => {
    await openClone('');
    await waitShown('clone-repo-sh-mock-user/sh-gh', 10000);
    expect(/2 repositories/.test(await tid('clone-count').innerText()), 'the count: ' + (await tid('clone-count').innerText()));
    expect(/private/.test(await tid('clone-repo-sh-mock-user/sh-gh').innerText()) && /public/.test(await tid('clone-repo-sh-mock-user/other-thing').innerText()), 'private / public');
    const filter = page.locator('[data-testid="modal"] input[placeholder="Filter repositories"]');
    await filter.fill('other');
    await waitGone('clone-repo-sh-mock-user/sh-gh');
    expect(/1 shown/.test(await tid('clone-count').innerText()), 'how many shown: ' + (await tid('clone-count').innerText()));
    await filter.fill('zzz');
    await page.locator('[data-testid="modal"]').getByText('nothing matches', { exact: true }).waitFor({ timeout: 3000 });
    await filter.fill('');
    await tid('clone-repo-sh-mock-user/sh-gh').click();
    expect((await valueOf('clone-url')) === ghBare && (await valueOf('clone-name')) === 'sh-gh', 'the address and the name: ' + (await valueOf('clone-url')) + ' / ' + (await valueOf('clone-name')));
    await tid('clone-dir').fill(clones);
    await settle();
    await tid('clone-repo-sh-mock-user/sh-gh').dblclick();
    await statusHasText(/Cloning sh-gh: done/, 30000);
    await page.waitForFunction(() => !!document.querySelector('[data-testid="tab-sh-gh"]'), null, { timeout: 15000 });
    expect(existsSync(path.join(clones, 'sh-gh', 'README.md')), 'cloned');
  }, repos);
});

await step('shell · clone: an account whose sign-in is gone says so with Sign in again…, and no endless "loading repositories…"', async () => {
  await withAccount('expired', async () => {
    await page.waitForFunction((id) => /sign in again/i.test(document.querySelector(`[data-testid="${id}"]`)?.textContent ?? ''), `account-${fakeAcc.login}`, { timeout: 10000 });
    await openClone('');
    await waitShown('clone-signin-expired');
    await sleep(1500);
    expect(!(await has('clone-loading')), 'no loading line under the notice');
    await page.keyboard.press('Escape');
  });
});

await step('shell · accounts: Sign in again of an account whose sign-in is gone opens the token form when the device sign-in has no client id', async () => {
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ githubClientId: '' }) });
  await withAccount('expired', async () => {
    await tid(`account-${fakeAcc.login}`).click();
    await waitShown('accounts-expired-note');
    await tid(`resign-${fakeAcc.login}`).click();
    await waitShown('token-input');
    expect((await valueOf('token-host')) === 'github.com', 'for its host');
    expect(!(await has('error-dialog')), 'no error (it used to fail for want of a client id)');
    await page.keyboard.press('Escape');
  });
});

// ======================================================================================
// Preferences: accounts
// ======================================================================================

await step('shell · prefs: ⌘, opens General, the user button opens Accounts, the sections switch, Escape closes', async () => {
  await home();
  await page.keyboard.press('Meta+,');
  await waitShown('scheme-amber');
  await tid('prefs-tab-github').click();
  await waitShown('accounts-token');
  await tid('prefs-tab-ssh').click();
  await waitShown('ssh-generate');
  await tid('prefs-tab-general').click();
  await waitShown('scheme-amber');
  await page.keyboard.press('Escape');
  await waitGone('scheme-amber');
  await page.locator('[aria-label="Accounts"]').click();
  await waitShown('accounts-token');
  await page.keyboard.press('Escape');
  await waitGone('accounts-token');
  await page.locator('[aria-label="Preferences (⌘,)"]').click();
  await waitShown('scheme-amber');
  await page.keyboard.press('Escape');
});

await step('shell · accounts: a token (GitHub answered here): Sign in is off until one is typed, Enter signs in, the account shows with its state and organizations', async () => {
  let signedIn = false;
  const posted = [];
  const routes = [
    ['**/api/accounts', (r) => {
      if (r.request().method() === 'POST') {
        posted.push(r.request().postDataJSON());
        signedIn = true;
        return r.fulfill({ json: fakeAcc });
      }
      return r.request().method() === 'GET' ? r.fulfill({ json: signedIn ? [fakeAcc] : [] }) : r.fallback();
    }],
    ['**/api/accounts/check', (r) => r.fulfill({ json: signedIn ? { [fakeAcc.id]: { state: 'ok' } } : {} })],
  ];
  for (const [u, h] of routes) await page.route(u, h);
  try {
    await home();
    await tid('accounts-add').click();
    await tid('accounts-token').click();
    await waitShown('token-input');
    expect(await disabled('token-signin'), 'off without a token');
    // where to make one: the page for a classic token with the scopes Prong needs, opened once
    await page.evaluate(() => (window.__opened.length = 0));
    systemCalls.length = 0;
    await tid('token-create').click();
    await page.waitForFunction(() => window.__opened.length > 0, null, { timeout: 3000 });
    const opened = await page.evaluate(() => window.__opened);
    expect(opened.length === 1 && /^https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo,read:org,admin:public_key/.test(opened[0]) && !systemCalls.some((c) => c.what === 'open'), 'opened once: ' + JSON.stringify(opened) + JSON.stringify(systemCalls));
    await tid('token-input').fill('   ');
    expect(await disabled('token-signin'), 'off with only spaces');
    await tid('token-input').fill('ghp_e2e_not_a_real_token');
    await tid('token-input').press('Enter');
    await waitShown(`account-card-${fakeAcc.login}`, 8000);
    expect(posted.length === 1 && posted[0].token === 'ghp_e2e_not_a_real_token' && posted[0].host === 'github.com', 'what was sent: ' + JSON.stringify(posted));
    const card = await tid(`account-card-${fakeAcc.login}`).innerText();
    expect(/orgs: sh-org/.test(card) && /\bok\b/.test(card), 'the card: ' + card);
    await statusHasText(/Signed in as sh-mock-user/);
    await page.keyboard.press('Escape');
    await waitShown(`account-${fakeAcc.login}`);
  } finally {
    for (const [u, h] of routes) await page.unroute(u, h);
  }
  await reload();
});

await step('shell · accounts: a token GitHub refuses: the error says why, the form stays', async () => {
  const refuse = (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 400, json: { error: 'GitHub /user → 401 {"message":"Bad credentials"}' } }) : r.fallback());
  await page.route('**/api/accounts', refuse);
  try {
    await home();
    await tid('accounts-add').click();
    await tid('accounts-token').click();
    await tid('token-input').fill('ghp_wrong');
    await tid('token-signin').click();
    await waitShown('error-dialog');
    expect(/Bad credentials/.test((await textOf('error-detail')) ?? ''), 'why: ' + (await textOf('error-detail')));
    await tid('error-close').click();
    await waitGone('error-dialog');
    expect((await valueOf('token-input')) === 'ghp_wrong', 'the form stays with the token');
    await tid('token-back').click();
    await waitShown('accounts-token');
    await page.keyboard.press('Escape');
  } finally {
    await page.unroute('**/api/accounts', refuse);
  }
});

await step('shell · accounts: Sign out asks the engine to forget the account, and it leaves the list', async () => {
  let gone = false;
  const deleted = [];
  const routes = [
    ['**/api/accounts', (r) => {
      if (r.request().method() === 'DELETE') {
        deleted.push(r.request().postDataJSON());
        gone = true;
        return r.fulfill({ json: { ok: true } });
      }
      return r.request().method() === 'GET' ? r.fulfill({ json: gone ? [] : [fakeAcc] }) : r.fallback();
    }],
    ['**/api/accounts/check', (r) => r.fulfill({ json: gone ? {} : { [fakeAcc.id]: { state: 'ok' } } })],
  ];
  for (const [u, h] of routes) await page.route(u, h);
  try {
    await reload();
    await home();
    await tid(`account-${fakeAcc.login}`).click();
    await waitShown(`signout-${fakeAcc.login}`);
    await tid(`signout-${fakeAcc.login}`).click();
    await waitGone(`account-card-${fakeAcc.login}`);
    expect(deleted.length === 1 && deleted[0].id === fakeAcc.id, 'forgot that account: ' + JSON.stringify(deleted));
    await page.keyboard.press('Escape');
    await waitGone(`account-${fakeAcc.login}`);
  } finally {
    for (const [u, h] of routes) await page.unroute(u, h);
  }
});

await step('shell · accounts: the device sign-in (GitHub answered here) shows the code and opens the page; Cancel stops asking GitHub', async () => {
  let polls = 0;
  const routes = [
    ['**/api/github/deviceStart', (r) => r.fulfill({ json: { device_code: 'e2e-device', user_code: 'SHEL-2E2E', verification_uri: 'https://github.com/login/device', expires_in: 120, interval: 0 } })],
    ['**/api/github/devicePoll', (r) => (polls++, r.fulfill({ json: { done: false, error: 'authorization_pending' } }))],
  ];
  for (const [u, h] of routes) await page.route(u, h);
  try {
    await home();
    await page.evaluate(() => ((window.__copied.length = 0), (window.__opened.length = 0)));
    systemCalls.length = 0;
    await tid('accounts-add').click();
    await tid('client-id').fill('Iv1.e2e-not-real');
    await tid('accounts-device').click();
    await page.waitForFunction(() => /SHEL-2E2E/.test(document.querySelector('[data-testid="device-code"]')?.textContent ?? ''), null, { timeout: 8000 });
    await page.waitForFunction(() => window.__copied.includes('SHEL-2E2E'), null, { timeout: 3000 });
    await until(async () => (await page.evaluate(() => window.__opened.includes('https://github.com/login/device'))) || systemCalls.some((c) => c.body?.path === 'https://github.com/login/device'), 'the page opens');
    const opened = (await page.evaluate(() => window.__opened.length)) + systemCalls.filter((c) => c.body?.path === 'https://github.com/login/device').length;
    expect(opened === 1, 'opened once, not twice: ' + opened);
    await until(() => polls >= 1, 'GitHub is asked', 6000);
    await tid('device-cancel').click();
    await waitShown('accounts-device');
    const at = polls;
    await sleep(3500);
    expect(polls === at, `no more questions after Cancel: ${at} → ${polls}`);
    expect((await settings()).githubClientId === 'Iv1.e2e-not-real', 'the client id is kept');
    await page.keyboard.press('Escape');
  } finally {
    for (const [u, h] of routes) await page.unroute(u, h);
  }
});

await step('shell · accounts: the OAuth client id is saved with its button', async () => {
  await home();
  await tid('accounts-add').click();
  await tid('client-id').fill('Iv1.e2e-saved');
  await tid('client-id-save').click();
  await until(async () => (await settings()).githubClientId === 'Iv1.e2e-saved', 'saved in the engine settings');
  await statusHasText(/Client id saved/);
  await page.keyboard.press('Escape');
});

// ======================================================================================
// Preferences: SSH keys
// ======================================================================================

await step('shell · ssh: the keys of the SSH folder are listed with their type and fingerprint', async () => {
  await home();
  await tid('accounts-ssh').click();
  for (const k of ['e2e_work', 'e2e_personal']) {
    await waitShown(`ssh-key-${k}`);
    const t = await tid(`ssh-key-${k}`).innerText();
    expect(/ed25519/.test(t) && /SHA256:/.test(t), `${k}: ${t}`);
  }
  await page.keyboard.press('Escape');
});

await step('shell · ssh: Generate refuses a name with a folder, an option or one taken; a new key is made in the SSH folder (not ~/.ssh) and listed', async () => {
  const name = 'sh_e2e_new_key';
  expect(!existsSync(path.join(homedir(), '.ssh', name)), 'no such key in ~/.ssh before');
  await home();
  await tid('accounts-ssh').click();
  await tid('ssh-generate').click();
  await waitShown('ssh-gen-name');
  for (const bad of ['../evil', '-oProxyCommand', 'e2e_work', 'x.pub', '']) {
    await tid('ssh-gen-name').fill(bad);
    expect(await disabled('ssh-gen-go'), `refused: "${bad}"`);
  }
  expect(await has('ssh-gen-problem'), 'says why');
  await tid('ssh-gen-name').fill(name);
  expect(!(await disabled('ssh-gen-go')), 'accepted');
  await tid('ssh-gen-go').click();
  await waitShown(`ssh-key-${name}`, 15000);
  expect(existsSync(path.join(sshKeys, name)) && existsSync(path.join(sshKeys, name + '.pub')), 'in the SSH folder the list reads');
  expect(!existsSync(path.join(homedir(), '.ssh', name)), 'not in ~/.ssh');
  // the engine refuses a path, whatever the page sends
  const r = await fetch(base + '/api/ssh/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '../sh-probe-outside-key', type: 'ed25519' }) });
  expect(r.status >= 400 && !existsSync(path.join(sshKeys, '..', 'sh-probe-outside-key')), 'the engine refuses a path: ' + r.status);
  await page.keyboard.press('Escape');
});

await step('shell · ssh: the key type is chosen (ECDSA), Back leaves the form, Refresh reads the folder again', async () => {
  const name = 'sh_e2e_ecdsa';
  await home();
  await tid('accounts-ssh').click();
  await tid('ssh-generate').click();
  await tid('ssh-gen-back').click();
  await waitShown('ssh-generate');
  await tid('ssh-generate').click();
  await tid('ssh-gen-name').fill(name);
  await page.locator('[data-testid="modal"]').getByText('ECDSA', { exact: true }).click();
  await tid('ssh-gen-go').click();
  await waitShown(`ssh-key-${name}`, 15000);
  expect(/ecdsa/i.test(await tid(`ssh-key-${name}`).innerText()), 'an ECDSA key: ' + (await tid(`ssh-key-${name}`).innerText()));
  // a key made outside Prong shows after Refresh
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'outside', '-f', path.join(sshKeys, 'sh_e2e_outside')]);
  expect(!(await has('ssh-key-sh_e2e_outside')), 'not yet');
  await tid('ssh-refresh').click();
  await waitShown('ssh-key-sh_e2e_outside');
  await page.keyboard.press('Escape');
});

await step('shell · ssh: Add to GitHub with an account (GitHub answered here) uploads the public key and says it is on GitHub', async () => {
  const sent = [];
  const add = (r) => (sent.push(r.request().postDataJSON()), r.fulfill({ json: { id: 1 } }));
  await page.route('**/api/github/addKey', add);
  try {
    await withAccount('ok', async () => {
      await tid('accounts-ssh').click();
      expect(!(await disabled('ssh-github-e2e_work')), 'on with an account');
      await tid('ssh-github-e2e_work').click();
      await page.locator('[data-testid="ssh-key-e2e_work"]').getByText('On GitHub', { exact: true }).waitFor({ timeout: 5000 });
      const pub = readFileSync(path.join(sshKeys, 'e2e_work.pub'), 'utf8').trim();
      expect(sent.length === 1 && sent[0].accountId === fakeAcc.id && sent[0].key === pub && /e2e_work/.test(sent[0].title), 'what was sent: ' + JSON.stringify(sent));
      await page.keyboard.press('Escape');
    });
  } finally {
    await page.unroute('**/api/github/addKey', add);
  }
});

await step('shell · ssh: In ssh-agent asks for that key (answered here: the user’s ssh-agent is not touched)', async () => {
  sshCalls.length = 0;
  await home();
  await tid('accounts-ssh').click();
  await tid('ssh-agent-e2e_work').click();
  await until(() => sshCalls.some((c) => c.what === 'agentAdd' && c.body.name === 'e2e_work'), 'asked for e2e_work: ' + JSON.stringify(sshCalls));
  await statusHasText(/Added e2e_work to ssh-agent/);
  await page.keyboard.press('Escape');
});

await step('shell · ssh: Copy public key copies it; Test ssh asks for the host typed; Add to GitHub needs an account', async () => {
  await home();
  await tid('accounts-ssh').click();
  await page.evaluate(() => (window.__copied.length = 0));
  await tid('ssh-copy-e2e_personal').click();
  const pub = readFileSync(path.join(sshKeys, 'e2e_personal.pub'), 'utf8').trim();
  await page.waitForFunction((p) => window.__copied.includes(p), pub, { timeout: 3000 });
  expect(await disabled('ssh-github-e2e_personal'), 'Add to GitHub is off without an account');
  sshCalls.length = 0;
  await tid('ssh-host').fill('git.example.invalid');
  expect(/git\.example\.invalid/i.test(await tid('ssh-test-e2e_personal').innerText()), 'the button names the host');
  await tid('ssh-test-e2e_personal').click();
  await until(() => sshCalls.some((c) => c.what === 'test' && c.body.host === 'git.example.invalid'), 'asked for that host: ' + JSON.stringify(sshCalls));
  await page.keyboard.press('Escape');
  await statusHasText(/Testing ssh to git\.example\.invalid/);
  // the stand-in test never ends: stop it
  await tid('activity-stop').click();
  await page.waitForFunction(() => !/Testing ssh/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 5000 });
});

// ======================================================================================
// Preferences: General
// ======================================================================================

const zoomNow = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-zoomroot]')).zoom);
const bodyBg = () => page.evaluate(() => document.body.style.backgroundColor);

await step('shell · prefs: each colour scheme applies at once and is remembered after a reload (the palette’s Next colour scheme too)', async () => {
  await home();
  await page.keyboard.press('Meta+,');
  const seen = new Set();
  for (const id of ['phosphor', 'ice', 'solar', 'paper', 'amber']) {
    await tid(`scheme-${id}`).click();
    await until(async () => (await settings()).ui.theme === id, `${id} saved`);
    seen.add(await bodyBg());
  }
  expect(seen.size === 5, 'five different window colours: ' + [...seen]);
  await tid('scheme-ice').click();
  await until(async () => (await settings()).ui.theme === 'ice', 'ice saved');
  const ice = await bodyBg();
  await page.keyboard.press('Escape');
  await reload();
  expect((await bodyBg()) === ice, 'ice after a reload');
  // the command palette's "Next colour scheme"
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('Next colour scheme');
  await page.keyboard.press('Enter');
  await until(async () => (await settings()).ui.theme === 'solar', 'the next one (solar) saved: ' + (await settings()).ui.theme);
  await reload();
  expect((await bodyBg()) !== ice, 'still the next one after a reload');
  await page.keyboard.press('Meta+,');
  await tid('scheme-amber').click();
  await until(async () => (await settings()).ui.theme === 'amber', 'back to amber');
  await page.keyboard.press('Escape');
});

await step('shell · prefs: interface scale from the buttons, ⌘+ ⌘− ⌘0 and Reset, remembered after a reload; the window still fits', async () => {
  await open('alpha');
  await page.keyboard.press('Meta+,');
  await page.locator('[data-testid="modal"]').getByText('110%', { exact: true }).click();
  await until(async () => (await zoomNow()) === '1.1', 'zoom 1.1: ' + (await zoomNow()));
  await until(async () => (await settings()).ui.uiScale === 1.1, 'saved');
  await tid('scale-reset').click();
  await until(async () => (await zoomNow()) === '1', 'reset');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Equal');
  await until(async () => (await zoomNow()) === '1.1', '⌘+ → 110 %');
  await page.keyboard.press('Meta+Equal');
  await until(async () => (await zoomNow()) === '1.25', '⌘+ → 125 %');
  await page.keyboard.press('Meta+Minus');
  await until(async () => (await zoomNow()) === '1.1', '⌘− → 110 %');
  await page.keyboard.press('Meta+Equal');
  await until(async () => (await settings()).ui.uiScale === 1.25, 'saved 1.25');
  await reload();
  await until(async () => (await zoomNow()) === '1.25', 'remembered: ' + (await zoomNow()));
  const fits = await page.evaluate(() => {
    const st = document.querySelector('[data-testid="activity-box"]')?.getBoundingClientRect();
    return { w: innerWidth, sw: document.documentElement.scrollWidth, right: st?.right ?? 0, bottom: document.querySelector('[data-zoomroot]').getBoundingClientRect().bottom, h: innerHeight };
  });
  expect(fits.sw <= fits.w && fits.right <= fits.w + 1 && fits.bottom <= fits.h + 1, 'fits the window at 125 %: ' + JSON.stringify(fits));
  await shot('scale-125');
  await page.keyboard.press('Meta+Digit0');
  await until(async () => (await zoomNow()) === '1', '⌘0 → 100 %');
  await until(async () => (await settings()).ui.uiScale === 1, 'saved 1');
});

await step('shell · prefs: Lists, avatars, pull mode and the submodules setting are saved in the engine settings at once', async () => {
  await home();
  await page.keyboard.press('Meta+,');
  const modal = page.locator('[data-testid="modal"]');
  await modal.getByText('List', { exact: true }).click();
  await until(async () => (await settings()).ui.fileView === 'list', 'list');
  await modal.getByText('Tree', { exact: true }).click();
  await until(async () => (await settings()).ui.fileView === 'tree', 'tree');
  await tid('pref-avatars').click();
  await until(async () => (await settings()).avatars === false, 'avatars off');
  await tid('pref-avatars').click();
  await until(async () => (await settings()).avatars === true, 'avatars on');
  for (const [label, mode] of [['Merge', 'merge'], ['Fast-forward only', 'ff'], ['Rebase', 'rebase']]) {
    await modal.getByText(label, { exact: true }).click();
    await until(async () => (await settings()).pullMode === mode, `pull mode ${mode}`);
  }
  await tid('pref-auto-submodules').click();
  await until(async () => (await settings()).autoUpdateSubmodules === false, 'submodules off');
  await tid('pref-auto-submodules').click();
  await until(async () => (await settings()).autoUpdateSubmodules === true, 'submodules on');
  await page.keyboard.press('Escape');
});

await step('shell · prefs: Git identity shows the global one; Save writes it to git’s global settings (the run’s own file, never ~/.gitconfig)', async () => {
  const userCfg = path.join(homedir(), '.gitconfig');
  const hash = () => (existsSync(userCfg) ? createHash('sha1').update(readFileSync(userCfg)).digest('hex') : 'none');
  const before = hash();
  // the engine must take its global settings from the run's file, or Save would write ~/.gitconfig: proven first
  writeFileSync(gitGlobal, readFileSync(gitGlobal, 'utf8') + '[shelle2e]\n\tprobe = yes\n');
  const probe = await post('/api/repo/globalConfig', { path: dirOf('sh-plain'), key: 'shelle2e.probe' });
  expect(probe.value === 'yes', 'the engine reads the run’s global file (else Save is not pressed): ' + JSON.stringify(probe));
  const globalGet = (k) => {
    try {
      return execFileSync('git', ['config', '--global', '--get', k], { cwd: tmp, env: { ...process.env, GIT_CONFIG_GLOBAL: gitGlobal } }).toString().trim();
    } catch {
      return '';
    }
  };
  await home();
  await page.keyboard.press('Meta+,');
  await page.waitForFunction(() => document.querySelector('[data-testid="identity-name"]')?.getAttribute('placeholder') !== '', null, { timeout: 5000 }).catch(() => {});
  expect((await valueOf('identity-name')) === globalGet('user.name'), `shows the global name: "${await valueOf('identity-name')}" vs "${globalGet('user.name')}"`);
  await tid('identity-name').fill('Shell Suite Person');
  await tid('identity-email').fill('shell-person@example.com');
  await tid('identity-save').click();
  await statusHasText(/Git identity saved/);
  expect(globalGet('user.name') === 'Shell Suite Person' && globalGet('user.email') === 'shell-person@example.com', 'written: ' + readFileSync(gitGlobal, 'utf8'));
  expect(hash() === before, '~/.gitconfig untouched');
  await page.keyboard.press('Escape');
});

await step('shell · prefs: external tools are saved; Open in Terminal and Open in editor use them', async () => {
  await home();
  await page.keyboard.press('Meta+,');
  await tid('tool-editor').fill('Sublime Text');
  await tid('tool-terminal').fill('iTerm');
  await tid('tool-diff').fill('Kaleidoscope');
  await tid('tools-save').click();
  await until(async () => {
    const s = await settings();
    return s.editor === 'Sublime Text' && s.terminal === 'iTerm' && s.diffTool === 'Kaleidoscope';
  }, 'saved');
  await statusHasText(/External tools saved/);
  await page.keyboard.press('Escape');
  systemCalls.length = 0;
  await menu(tid('repo-card-sh-plain'), 'Open in Terminal');
  await until(() => systemCalls.some((c) => c.what === 'terminal' && c.body.app === 'iTerm'), 'the terminal chosen: ' + JSON.stringify(systemCalls));
  // the Preferences fields show what is saved when opened again
  await page.keyboard.press('Meta+,');
  expect((await valueOf('tool-editor')) === 'Sublime Text', 'shown again');
  await tid('tool-editor').fill('Visual Studio Code');
  await tid('tool-terminal').fill('Terminal');
  await tid('tool-diff').fill('');
  await tid('tools-save').click();
  await until(async () => (await settings()).terminal === 'Terminal', 'back to the defaults');
  await page.keyboard.press('Escape');
});

// ======================================================================================
// layout
// ======================================================================================

async function drag(id, dx, dy) {
  const b = await tid(id).boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  await sleep(150);
}
const widthOf = async (id) => Math.round((await tid(id).boundingBox()).width);

await step('shell · layout: the sidebar splitter drags within 170–420 px and keeps its width after a reload', async () => {
  await open('alpha');
  const w0 = await widthOf('sidebar-column');
  await drag('sidebar-splitter', 60, 0);
  const w1 = await widthOf('sidebar-column');
  expect(Math.abs(w1 - (w0 + 60)) <= 3, `follows the pointer: ${w0} → ${w1}`);
  await drag('sidebar-splitter', 800, 0);
  expect((await widthOf('sidebar-column')) === 420, 'at most 420: ' + (await widthOf('sidebar-column')));
  await drag('sidebar-splitter', -800, 0);
  expect((await widthOf('sidebar-column')) === 170, 'at least 170: ' + (await widthOf('sidebar-column')));
  await drag('sidebar-splitter', 110, 0);
  const w = await widthOf('sidebar-column');
  await until(async () => (await settings()).ui.sidebarWidth === w, 'saved ' + w);
  await reload();
  await waitShown('sidebar-column', 15000);
  expect(Math.abs((await widthOf('sidebar-column')) - w) <= 1, `the same after a reload: ${w} → ${await widthOf('sidebar-column')}`);
  await drag('sidebar-splitter', 230 - w, 0);
});

await step('shell · layout: the splitter under the history keeps the details’ share after a reload', async () => {
  await open('alpha');
  await tid('sidebar-commits').click();
  await waitShown('details-splitter');
  const top0 = (await tid('details-splitter').boundingBox()).y;
  await drag('details-splitter', 0, -120);
  const top1 = (await tid('details-splitter').boundingBox()).y;
  expect(Math.abs(top1 - (top0 - 120)) <= 4, `follows the pointer: ${top0} → ${top1}`);
  await sleep(500);
  await reload();
  await waitShown('details-splitter', 15000);
  const top2 = (await tid('details-splitter').boundingBox()).y;
  expect(Math.abs(top2 - top1) <= 4, `the same place after a reload (it used to go back): ${top1} → ${top2}`);
  await drag('details-splitter', 0, top0 - top2);
});

await step('shell · layout: ⌘B hides the sidebar and shows it again', async () => {
  await open('alpha');
  await waitShown('sidebar');
  await page.keyboard.press('Meta+b');
  await waitGone('sidebar');
  await page.keyboard.press('Meta+b');
  await waitShown('sidebar');
});

await step('shell · layout: at 125 % the sidebar splitter still follows the pointer', async () => {
  await open('alpha');
  await page.keyboard.press('Meta+Equal');
  await page.keyboard.press('Meta+Equal');
  await until(async () => (await zoomNow()) === '1.25', '125 %');
  try {
    const w0 = (await tid('sidebar-column').boundingBox()).width;
    await drag('sidebar-splitter', 50, 0);
    const w1 = (await tid('sidebar-column').boundingBox()).width;
    expect(Math.abs(w1 - (w0 + 50)) <= 4, `the edge stays under the pointer: ${w0} → ${w1}`);
    await drag('sidebar-splitter', -50, 0);
  } finally {
    await page.keyboard.press('Meta+Digit0');
    await until(async () => (await zoomNow()) === '1', '100 %');
  }
});

/** nothing sticks out of the window, and these controls do not overlap */
async function fits(ids) {
  return page.evaluate((ids) => {
    const boxes = ids.map((id) => [id, document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()]).filter(([, b]) => b && b.width);
    const out = boxes.filter(([, b]) => b.left < -1 || b.right > innerWidth + 1).map(([id, b]) => `${id} ${Math.round(b.left)}–${Math.round(b.right)}`);
    const overlap = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [a, A] = boxes[i];
      const [b, B] = boxes[j];
      if (A.left < B.right - 1 && B.left < A.right - 1 && A.top < B.bottom - 1 && B.top < A.bottom - 1) overlap.push(`${a}×${b}`);
    }
    return { scroll: document.documentElement.scrollWidth - innerWidth, out, overlap };
  }, ids);
}

await step('shell · layout: a narrow window (1000×700): the start screen and a repository fit, nothing overlaps', async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  try {
    await home();
    await sleep(300);
    let f = await fits(['ws-root', 'ws-choose-folder', 'ws-rescan', 'repo-filter', 'activity-box', 'repo-card-sh-plain']);
    await shot('narrow-start');
    expect(f.scroll <= 0 && !f.out.length && !f.overlap.length, 'start screen: ' + JSON.stringify(f));
    await open('alpha');
    f = await fits(['sidebar', 'activity-box', 'agent-button', 'new-tab', 'commit-scroll']);
    await shot('narrow-repo');
    expect(f.scroll <= 0 && !f.out.length, 'repository: ' + JSON.stringify(f));
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

await step('shell · layout: a wide window (1920×1080) fills the window', async () => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  try {
    await open('alpha');
    const r = await page.evaluate(() => {
      const root = document.querySelector('[data-zoomroot]').getBoundingClientRect();
      const st = document.querySelector('[data-testid="activity-box"]').getBoundingClientRect();
      return { w: Math.round(root.width), h: Math.round(root.height), statusRight: Math.round(st.right) };
    });
    expect(r.w === 1920 && r.h === 1080 && r.statusRight > 1800, 'the app fills the window: ' + JSON.stringify(r));
    await home();
    expect((await fits(['repo-filter', 'activity-box'])).out.length === 0, 'start screen in the window');
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

// ======================================================================================
// the crash boundary
// ======================================================================================

await step('shell · crash: a repository view that cannot draw what came comes back by itself; when it keeps failing, Retry reads the repository again', async () => {
  let bad = true;
  // a branch without a name: the sidebar cannot draw it
  const broken = async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    if (bad && Array.isArray(j.refs) && j.refs.length) j.refs = j.refs.map((x, i) => (i === 0 ? { ...x, name: null } : x));
    await route.fulfill({ response: r, json: j });
  };
  await page.route('**/api/repo/snapshot', broken);
  const errors = pageErrors.length;
  try {
    await home();
    await tid('repo-card-sh-tab-a').click();
    await page.getByText('Repository crashed', { exact: true }).waitFor({ timeout: 15000 });
    expect(await has('crash-retry') && (await has('crash-ask-ai')), 'Retry and Ask AI');
    expect(/Cannot read properties of null/.test(await text()), 'the message');
    // the tab bar and the start screen button still work
    expect(await has('home-button') && (await tabs()).includes('sh-tab-a'), 'the rest of the window stays');
    bad = false;
    await tid('crash-retry').click();
    await showing('Second commit of sh-tab-a', 15000);
    expect(!(await page.getByText('Repository crashed', { exact: true }).count()), 'back');
  } finally {
    bad = false;
    await page.unroute('**/api/repo/snapshot', broken);
    pageErrors.splice(errors); // the crashes were made on purpose
  }
});

await step('shell · no page errors in the whole run', async () => {
  // the refusals the checks provoke (a folder that is no repository, one that exists) are logged by the browser
  const real = pageErrors.filter((e) => !/Failed to load resource: the server responded with a status of 400/.test(e));
  expect(real.length === 0, real.slice(0, 5).join('\n'));
});

await finish('shell');
