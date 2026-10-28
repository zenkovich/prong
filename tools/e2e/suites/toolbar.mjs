/**
 * The toolbar, as a Fork user works it: every button and its ▾ menu (Fetch, Pull, Push, Stash, Branch, Merge, Rebase,
 * More), the dialogs they open (fields, validation, Enter / Escape, what is remembered, the result in git), the
 * status panel in each of its states (branch and ↑↓, a running operation with Stop and its output, the queue and a
 * lock wait, notices, the error counter, merge / rebase / cherry-pick in progress with Continue and Abort, the engine
 * offline), Undo of each kind of action, the error dialog, the connection dialog, the command palette and every
 * global shortcut, and the toolbar at narrow widths.
 *
 * Each part works in repositories of its own (made here), with bare repositories as their servers — no network.
 * Check names start with the part ("toolbar · pull: …"), so E2E_ONLY='toolbar · pull' runs one part.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ROOT, base, port, page, check, expect, openRepo, until, git, root, tmp, freshRepo, finish, refreshUi, undoLabel, pageErrors, post, sshKeys } from '../harness.mjs';

const SHOTS = path.join(ROOT, '..', 'shots');
mkdirSync(SHOTS, { recursive: true });
const shot = (n, clip) => page.screenshot({ path: path.join(SHOTS, `toolbar-${n}.png`), ...(clip ? { clip } : {}) }).catch(() => {});
const tid = (id) => page.getByTestId(id);
const has = async (id) => (await tid(id).count()) > 0;
const waitGone = (id, ms = 6000) => page.waitForFunction((id) => !document.querySelector(`[data-testid="${CSS.escape(id)}"]`), id, { timeout: ms });
const waitShown = (id, ms = 6000) => tid(id).first().waitFor({ timeout: ms });
const settle = () => page.waitForTimeout(600);
const headOf = (dir) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
const shaOf = (dir, rev) => git(dir, 'rev-parse', rev).trim();
const refExists = (dir, ref) => {
  try {
    git(dir, 'rev-parse', '--verify', '-q', ref);
    return true;
  } catch {
    return false;
  }
};
const upOf = (dir, b) => {
  try {
    return git(dir, 'rev-parse', '--abbrev-ref', `${b}@{upstream}`).trim();
  } catch {
    return '';
  }
};
const statusText = () => page.evaluate(() => document.querySelector('[data-testid="status-bar"]')?.textContent ?? '');
/** the status panel shows `re` (within 15 s); a failure says what it showed instead */
async function statusHas(re) {
  try {
    await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), re.source, { timeout: 15000 });
  } catch {
    throw new Error(`the status panel never showed ${re}: it shows “${await statusText()}”${(await has('error-dialog')) ? ` and the error “${await tid('error-title').innerText()}”` : ''}`);
  }
}
const disabledBtn = (id) => page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-disabled') === 'true', id);
/** a Checkbox is ticked when it draws its check mark */
const ticked = (id) => page.evaluate((id) => !!document.querySelector(`[data-testid="${id}"] svg`), id);
const dialogText = (id) => tid(id).innerText();

/** a menu, dialog or error left open by a failed check is closed before the next one */
async function calm() {
  for (let i = 0; i < 5 && (await page.locator('[data-testid="context-menu"], [data-testid="modal"], [data-testid="modal-error"], [data-testid="repo-picker"]').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}
const step = (name, fn) =>
  check(name, async () => {
    await calm();
    await fn();
  });

/** the items of the open context menu: label (its first text) and state */
const menuItems = () =>
  page.evaluate(() => [...document.querySelectorAll('[data-testid="context-menu"] [data-testid="menu-item"]')].map((e) => ({ label: (e.firstElementChild?.firstElementChild ?? e).textContent.trim(), shortcut: e.firstElementChild?.children[1]?.textContent?.trim() ?? '', disabled: e.getAttribute('aria-disabled') === 'true' })));
const labels = (items) => items.map((i) => `${i.label}${i.disabled ? ' (off)' : ''}`).join(' | ');
/** opens a toolbar button's ▾ menu (or More's) and returns its items */
async function quickMenu(button) {
  await tid(button).click();
  await waitShown('context-menu', 3000);
  return menuItems();
}
async function closeMenu() {
  await page.keyboard.press('Escape');
  await waitGone('context-menu');
}
/** a toolbar menu's item: it must be there and on */
async function pick(button, label) {
  const items = await quickMenu(button);
  const it = items.find((i) => (label instanceof RegExp ? label.test(i.label) : i.label === label));
  if (!it || it.disabled) await closeMenu();
  expect(it, `the menu has “${label}”: ${labels(items)}`);
  expect(!it.disabled, `“${it.label}” is on`);
  await tid('context-menu').getByText(it.label, { exact: true }).click();
  await waitGone('context-menu');
}
/**
 * After a reload the saved session brings the last tab back a moment later: wait for it, or a click on the start
 * screen is thrown back to that tab.
 */
async function settleReload() {
  await page.waitForSelector('[data-testid="sidebar"], [data-testid="activity-box"]', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
}
async function open(name) {
  await settleReload();
  await openRepo(name);
  await page.waitForFunction((n) => [...document.querySelectorAll('[data-testid^="tab-"]')].some((e) => e.textContent.includes(n)), name, { timeout: 8000 }).catch(() => {});
  await waitShown('activity-branch', 8000).catch(() => {});
}
/** a bare repository standing in for a server */
function bare(name) {
  const dir = path.join(tmp, `origins/${name}.git`);
  mkdirSync(path.dirname(dir), { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'main', dir);
  return dir;
}
/** a second clone of `origin` (someone else pushing) */
function otherClone(origin, name) {
  const dir = path.join(tmp, `others/${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  git(tmp, 'clone', '-q', origin, dir);
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}
function commit(dir, file, content, msg) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', msg);
  return shaOf(dir, 'HEAD');
}
/** a repository with a server of its own (and someone else's clone of it), its main pushed and tracked */
async function syncRepo(name, files) {
  const dir = await freshRepo(name, files ?? { 'a.txt': 'one\ntwo\nthree\n' });
  const origin = bare(name);
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  const other = otherClone(origin, name);
  return { dir, origin, other };
}
/** a script standing in for ssh: it answers like a server that refuses us (no network is touched) */
function fakeSsh(name, message) {
  const p = path.join(tmp, `fake-ssh-${name}.sh`);
  writeFileSync(p, `#!/bin/sh\necho "${message}" >&2\nexit 255\n`);
  chmodSync(p, 0o755);
  return p;
}
/** the engine's system calls (Terminal, Finder, editor) are answered here: nothing is opened on this Mac */
const systemCalls = [];
await page.route('**/api/system/{terminal,reveal,open}', async (route) => {
  systemCalls.push({ what: route.request().url().split('/').pop(), body: route.request().postDataJSON() });
  await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
/** every element of `ids` lies inside the window and none overlaps another */
async function layoutProblems(ids) {
  return page.evaluate((ids) => {
    const out = [];
    const boxes = ids.map((id) => [id, document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()]).filter(([, b]) => b && b.width > 0);
    for (const [id, b] of boxes) if (b.left < 0 || b.right > window.innerWidth + 0.5) out.push(`${id} outside the window (${Math.round(b.left)}–${Math.round(b.right)})`);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, p] = boxes[i];
        const [c, q] = boxes[j];
        if (p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5) out.push(`${a} overlaps ${c}`);
      }
    return out;
  }, ids);
}
const BUTTONS = ['toolbar-fetch', 'toolbar-pull', 'toolbar-push', 'toolbar-stash', 'toolbar-branch', 'toolbar-merge', 'toolbar-rebase', 'toolbar-more'];
const settings = async () => (await fetch(base + '/api/settings')).json();
/** no rebase is under way (git moves HEAD commit by commit before it moves the branch) */
const rebaseOver = (dir) => !existsSync(path.join(dir, '.git/rebase-merge')) && !existsSync(path.join(dir, '.git/rebase-apply'));
const isAncestor = (dir, a, b) => {
  try {
    git(dir, 'merge-base', '--is-ancestor', a, b);
    return true;
  } catch {
    return false;
  }
};

// ======================================================================================== buttons
let B;
await step('toolbar · buttons: every button is there with its name; at 1000 px the names stay, below it they turn into icons named on hover; nothing overlaps the status panel', async () => {
  B = await syncRepo('tb-buttons');
  await open('tb-buttons');
  await shot('1440', { x: 0, y: 0, width: 1440, height: 80 });
  const names = { 'toolbar-fetch': 'Fetch', 'toolbar-pull': 'Pull', 'toolbar-push': 'Push', 'toolbar-stash': 'Stash', 'toolbar-branch': 'Branch', 'toolbar-merge': 'Merge', 'toolbar-rebase': 'Rebase', 'toolbar-more': 'More' };
  try {
    for (const w of [1440, 1000, 900, 760]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(300);
      for (const [id, name] of Object.entries(names)) {
        const t = (await tid(id).innerText()).trim();
        const label = await tid(id).getAttribute('aria-label');
        if (w >= 1000) expect(t.toLowerCase().startsWith(name.toLowerCase()), `${w} px: ${id} says ${name}: “${t}”`);
        else expect(label === name && !t.toLowerCase().includes(name.toLowerCase()), `${w} px: ${id} is an icon named ${name} (label ${label}, text “${t}”)`);
      }
      const problems = await layoutProblems([...BUTTONS, 'activity-box', 'toolbar-fetch-menu', 'toolbar-pull-menu', 'toolbar-push-menu']);
      expect(problems.length === 0, `${w} px: ${problems.join(', ')}`);
      if (w < 1440) await shot(String(w), { x: 0, y: 0, width: w, height: 80 });
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

await step('toolbar · buttons: the ▾ next to Fetch, Pull and Push sits at the middle of its button, not at the top', async () => {
  for (const b of ['fetch', 'pull', 'push']) {
    const d = await page.evaluate((b) => {
      const arrow = document.querySelector(`[data-testid="toolbar-${b}-menu"] svg`)?.getBoundingClientRect();
      const icon = document.querySelector(`[data-testid="toolbar-${b}"] svg`)?.getBoundingClientRect();
      return arrow && icon ? Math.abs(arrow.top + arrow.height / 2 - (icon.top + icon.height / 2)) : null;
    }, b);
    expect(d !== null && d <= 2, `${b}: the arrow is ${d} px off the middle of the button`);
  }
});

await step('toolbar · buttons: the sidebar button and ⌘B hide and show the sidebar', async () => {
  await page.getByLabel('Toggle sidebar (⌘B)').click();
  await waitGone('sidebar');
  await page.getByLabel('Toggle sidebar (⌘B)').click();
  await waitShown('sidebar');
  await page.keyboard.press('Meta+b');
  await waitGone('sidebar');
  await page.keyboard.press('Meta+b');
  await waitShown('sidebar');
});

await step('toolbar · buttons: Pull counts the commits to pull, Push the commits to push, Stash the changed files (a file staged and edited again is one)', async () => {
  commit(B.other, 'b.txt', 'b\n', 'Theirs one');
  commit(B.other, 'c.txt', 'c\n', 'Theirs two');
  git(B.other, 'push', '-q', 'origin', 'main');
  commit(B.dir, 'mine.txt', 'mine\n', 'Mine');
  git(B.dir, 'fetch', '-q', 'origin');
  writeFileSync(path.join(B.dir, 'a.txt'), 'one\ntwo\nthree\nstaged\n');
  git(B.dir, 'add', 'a.txt');
  writeFileSync(path.join(B.dir, 'a.txt'), 'one\ntwo\nthree\nstaged\nand edited again\n');
  writeFileSync(path.join(B.dir, 'new.txt'), 'new\n');
  await refreshUi();
  const badge = async (id) => ((await tid(id).innerText()).match(/(\d+)\s*$/) ?? [])[1];
  await page.waitForFunction(() => /\d\s*$/.test(document.querySelector('[data-testid="toolbar-pull"]')?.innerText ?? ''), null, { timeout: 5000 });
  expect((await badge('toolbar-pull')) === '2', 'two to pull: ' + (await tid('toolbar-pull').innerText()));
  expect((await badge('toolbar-push')) === '1', 'one to push: ' + (await tid('toolbar-push').innerText()));
  expect((await badge('toolbar-stash')) === '2', 'a.txt and new.txt are two changed files: ' + (await tid('toolbar-stash').innerText()));
  // the panel says the same
  const panel = await tid('activity-branch').innerText();
  expect(/main[\s\S]*↑1[\s\S]*↓2[\s\S]*origin\/main/.test(panel), 'ahead and behind: ' + panel);
});

// ======================================================================================== fetch
let F;
await step('toolbar · fetch: the ▾ menu fetches all remotes or one of them right away; Fetch… opens the dialog', async () => {
  F = await syncRepo('tb-fetch');
  const up2 = bare('tb-fetch-up2');
  git(F.dir, 'remote', 'add', 'upstream2', up2);
  const up2Clone = otherClone(up2, 'tb-fetch-up2');
  commit(up2Clone, 'u.txt', 'u\n', 'On upstream2');
  git(up2Clone, 'push', '-q', 'origin', 'HEAD:side');
  git(F.other, 'switch', '-q', '-c', 'newb');
  commit(F.other, 'n.txt', 'n\n', 'New branch on origin');
  git(F.other, 'push', '-q', 'origin', 'newb');
  await open('tb-fetch');
  const items = await quickMenu('toolbar-fetch-menu');
  expect(labels(items) === 'Fetch all remotes now | Fetch origin now | Fetch upstream2 now | Fetch…', 'the items: ' + labels(items));
  expect(items.find((i) => i.label === 'Fetch…').shortcut === '⌘⇧F', 'Fetch… shows its shortcut');
  await tid('context-menu').getByText('Fetch upstream2 now', { exact: true }).click();
  await statusHas(/Fetching upstream2: done/);
  expect(refExists(F.dir, 'refs/remotes/upstream2/side'), 'upstream2’s branch came');
  expect(!refExists(F.dir, 'refs/remotes/origin/newb'), 'origin was not fetched');
  await pick('toolbar-fetch-menu', 'Fetch all remotes now');
  await statusHas(/Fetching all remotes: done/);
  expect(refExists(F.dir, 'refs/remotes/origin/newb'), 'and now origin’s new branch');
  await pick('toolbar-fetch-menu', 'Fetch…');
  await waitShown('fetch-dialog');
  await page.keyboard.press('Escape');
  await waitGone('fetch-dialog');
});

await step('toolbar · fetch: the dialog — remote (all or one, with its address), Prune and tags as ticked; Enter fetches, Escape does not; the ticks are remembered', async () => {
  // a branch deleted on the server: prune takes it away, a fetch without prune keeps it
  git(F.dir, 'fetch', '-q', 'origin');
  expect(refExists(F.dir, 'refs/remotes/origin/newb'), 'origin/newb is here');
  git(F.other, 'push', '-q', 'origin', '--delete', 'newb');
  git(F.other, 'switch', '-q', 'main');
  git(F.other, 'tag', 'v-far', 'main');
  git(F.other, 'push', '-q', 'origin', 'v-far');
  await tid('toolbar-fetch').click();
  await waitShown('fetch-dialog');
  await tid('fetch-remote').click();
  await waitShown('fetch-remote-list');
  const opts = await page.evaluate(() => [...document.querySelectorAll('[data-testid="fetch-remote-list"] [data-testid^="pick-"]')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  expect(opts.length === 3 && /All remotes/.test(opts[0]) && /origin .*origins\/tb-fetch\.git/.test(opts[1]) && /upstream2/.test(opts[2]), 'all, then each remote with its address: ' + opts.join(' | '));
  await tid('pick-origin').click();
  expect((await dialogText('fetch-dialog')).includes('tb-fetch.git'), 'the chosen remote’s address under it');
  // Escape: nothing fetched
  await page.keyboard.press('Escape');
  await waitGone('fetch-dialog');
  await page.waitForTimeout(400);
  expect(refExists(F.dir, 'refs/remotes/origin/newb'), 'Escape fetched nothing');
  // origin, prune off, tags on: Enter
  await tid('toolbar-fetch').click();
  await waitShown('fetch-dialog');
  expect((await tid('fetch-remote').innerText()).includes('All remotes'), 'a dialog closed with Escape remembers nothing');
  await tid('fetch-remote').click();
  await tid('pick-origin').click();
  expect(await ticked('fetch-prune'), 'Prune starts ticked');
  await tid('fetch-prune').click();
  await tid('fetch-tags').click();
  await page.keyboard.press('Enter');
  await statusHas(/Fetching origin: done/);
  // Enter did not also press the toolbar's Fetch button, which still had the focus: it used to open the dialog again
  await page.waitForTimeout(300);
  expect(!(await has('fetch-dialog')), 'the dialog does not open again after Enter');
  expect(refExists(F.dir, 'refs/remotes/origin/newb'), 'without prune the deleted branch stays');
  expect(refExists(F.dir, 'refs/tags/v-far'), 'all tags came');
  // remembered: origin, prune off, tags on; prune now
  await tid('toolbar-fetch').click();
  await waitShown('fetch-dialog');
  expect((await tid('fetch-remote').innerText()).includes('origin'), 'origin remembered');
  expect(!(await ticked('fetch-prune')) && (await ticked('fetch-tags')), 'prune off and tags on remembered');
  await tid('fetch-prune').click();
  await tid('fetch-go').click();
  await statusHas(/Fetching origin: done/);
  await until(async () => !refExists(F.dir, 'refs/remotes/origin/newb'), 'prune removed the branch deleted on the server');
  // put the defaults back for the other parts
  await tid('toolbar-fetch').click();
  await waitShown('fetch-dialog');
  await tid('fetch-remote').click();
  await tid('pick-').click();
  await tid('fetch-tags').click();
  await page.keyboard.press('Enter');
  await statusHas(/Fetching all remotes: done/);
});

await step('toolbar · fetch: Stop really stops a fetch that hangs (git is killed); a click on it shows its output', async () => {
  git(F.dir, 'config', 'remote.origin.uploadpack', 'sleep 25; git-upload-pack');
  try {
    await pick('toolbar-fetch-menu', 'Fetch origin now');
    await page.waitForFunction(() => /Fetching origin/.test(document.querySelector('[data-testid="activity-op"]')?.textContent ?? ''), null, { timeout: 5000 });
    expect(await disabledBtn('toolbar-fetch'), 'Fetch is off while it runs');
    await tid('activity-op').click();
    await waitShown('op-log', 3000);
    expect(/Fetching origin/i.test(await tid('op-log').innerText()), 'the output popover names it');
    await shot('fetch-running', { x: 700, y: 0, width: 740, height: 300 });
    // Escape closes it (it has no backdrop to click); a click on the operation opens it again
    await page.keyboard.press('Escape');
    await waitGone('op-log', 2000);
    await tid('activity-op').click();
    await waitShown('op-log', 3000);
    const started = Date.now();
    await tid('activity-stop').click();
    await statusHas(/Fetching origin: stopped/);
    // it used to go on to the end (25 s here) and then say "done"
    expect(Date.now() - started < 8000, `stopped in ${Date.now() - started} ms`);
    await waitGone('op-log', 3000);
    expect(!(await disabledBtn('toolbar-fetch')), 'Fetch is on again');
  } finally {
    git(F.dir, 'config', '--unset', 'remote.origin.uploadpack');
  }
});

await step('toolbar · fetch: while another git holds index.lock the fetch says it waits for it (the queue lists it), then runs once it goes', async () => {
  const lock = path.join(F.dir, '.git/index.lock');
  writeFileSync(lock, '');
  try {
    await pick('toolbar-fetch-menu', 'Fetch origin now');
    await page.waitForFunction(() => /Waiting for index\.lock · Fetching origin/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 5000 });
    await tid('queue-status').click();
    await waitShown('queue-panel', 3000);
    expect(await has('queue-item-waiting-lock'), 'the queue lists it as waiting for the lock');
    expect(/index\.lock is held by another git process/.test(await tid('queue-panel').innerText()), 'and says why');
    await shot('fetch-lock', { x: 700, y: 0, width: 740, height: 300 });
    await page.keyboard.press('Escape');
    await waitGone('queue-panel', 2000);
    await tid('queue-status').click();
    await waitShown('queue-panel', 3000);
  } finally {
    rmSync(lock, { force: true });
  }
  await statusHas(/Fetching origin: done/);
  await waitGone('queue-panel', 5000);
});

await step('toolbar · fetch: the server refusing our key — the error says so, points at Connection, and Connection… opens it; an unknown host key is explained otherwise', async () => {
  const dir = await freshRepo('tb-ssh');
  git(dir, 'remote', 'add', 'origin', 'git@example.invalid:team/tb-ssh.git');
  git(dir, 'config', 'core.sshCommand', fakeSsh('denied', 'git@example.invalid: Permission denied (publickey).'));
  await open('tb-ssh');
  await pick('toolbar-fetch-menu', 'Fetch origin now');
  await waitShown('error-dialog', 10000);
  expect((await tid('error-title').innerText()) === 'Fetching origin failed', 'title: ' + (await tid('error-title').innerText()));
  expect(/Permission denied \(publickey\)/.test(await tid('error-detail').innerText()), 'git’s words in full');
  expect(/Pick the SSH key .* under Connection/.test(await tid('error-hint').innerText()), 'what to do: ' + (await tid('error-hint').innerText()));
  await shot('error-publickey');
  await tid('error-connection').click();
  await waitGone('error-dialog');
  await waitShown('connection-dialog');
  await page.keyboard.press('Escape');
  await waitGone('connection-dialog');
  git(dir, 'config', 'core.sshCommand', fakeSsh('hostkey', 'Host key verification failed.'));
  await pick('toolbar-fetch-menu', 'Fetch origin now');
  await page.waitForFunction(() => /Host key verification failed/.test(document.querySelector('[data-testid="error-detail"]')?.textContent ?? ''), null, { timeout: 10000 });
  expect(/known_hosts/.test(await tid('error-hint').innerText()), 'the host key, not our key: ' + (await tid('error-hint').innerText()));
  expect(!(await has('error-connection')), 'no Connection button: no key of ours fixes it');
  await tid('error-close').click();
});

await step('toolbar · fetch: with no remote, the dialog says so and cannot fetch; the quick items of Fetch, Pull and Push are off and say why', async () => {
  await freshRepo('tb-noremote');
  await open('tb-noremote');
  await tid('toolbar-fetch').click();
  await waitShown('fetch-dialog');
  expect(/has no remotes/.test(await dialogText('fetch-dialog')), 'says there are no remotes');
  expect(await disabledBtn('fetch-go'), 'Fetch is off');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(!/Fetching/.test(await statusText()), 'Enter fetches nothing');
  await page.keyboard.press('Escape');
  const want = { 'toolbar-fetch-menu': 'Fetch now — no remotes', 'toolbar-pull-menu': 'Pull now — main tracks nothing', 'toolbar-push-menu': 'Push now — no remotes' };
  for (const [b, label] of Object.entries(want)) {
    const items = await quickMenu(b);
    expect(items[0].label === label && items[0].disabled, `${b}: ${labels(items)}`);
    await closeMenu();
  }
  for (const [b, d, text] of [['toolbar-pull', 'pull-dialog', /no remotes to pull from/], ['toolbar-push', 'push-dialog', /has no remotes/]]) {
    await tid(b).click();
    await waitShown(d);
    expect(text.test(await dialogText(d)), `${d} says why: ${await dialogText(d)}`);
    await page.keyboard.press('Escape');
    await waitGone(d);
  }
});

// ======================================================================================== pull
let P;
await step('toolbar · pull: the ▾ menu names the upstream and the mode; Pull … now brings the new commit, and Undo (⌘Z) takes the pull back', async () => {
  P = await syncRepo('tb-pull');
  commit(P.other, 'theirs.txt', 'theirs\n', 'Theirs to pull');
  git(P.other, 'push', '-q', 'origin', 'main');
  await open('tb-pull');
  const mode = (await settings()).pullMode;
  const items = await quickMenu('toolbar-pull-menu');
  expect(labels(items) === `Pull origin/main now (${mode === 'ff' ? 'fast-forward' : mode}) | Pull with merge | Pull with rebase | Fast-forward only | Pull…`, 'the items: ' + labels(items));
  await tid('context-menu').getByText(items[0].label, { exact: true }).click();
  const before = shaOf(P.dir, 'HEAD');
  await statusHas(/Pulling.*: done/);
  await until(async () => git(P.dir, 'log', '-1', '--format=%s').trim() === 'Theirs to pull', 'the commit is pulled');
  await page.waitForFunction(() => /Undo Pull origin\/main/.test(document.querySelector('[data-testid="undo-button"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 5000 });
  expect(/= origin\/main/.test(await tid('activity-branch').innerText()), 'the panel: up to date with origin/main');
  await page.keyboard.press('Meta+z');
  await statusHas(/Undone: Pull origin\/main/);
  expect(shaOf(P.dir, 'HEAD') === before, 'back where it was');
  git(P.dir, 'reset', '-q', '--hard', 'origin/main');
});

await step('toolbar · pull: diverged — Pull with rebase replays mine on top, with merge makes a merge commit, Fast-forward only stops and says to merge or rebase', async () => {
  const diverge = (n) => {
    commit(P.other, `t${n}.txt`, 't\n', `Theirs ${n}`);
    git(P.other, 'push', '-q', 'origin', 'main');
    commit(P.dir, `m${n}.txt`, 'm\n', `Mine ${n}`);
  };
  diverge(1);
  await refreshUi();
  await pick('toolbar-pull-menu', 'Fast-forward only');
  await waitShown('error-dialog', 10000);
  expect(/Pulling.*failed/.test(await tid('error-title').innerText()), 'it failed: ' + (await tid('error-title').innerText()));
  expect(/pull with Merge or Rebase/.test(await tid('error-hint').innerText()), 'and says what to do: ' + (await has('error-hint') ? await tid('error-hint').innerText() : 'no hint'));
  await tid('error-close').click();
  expect(git(P.dir, 'log', '-1', '--format=%s').trim() === 'Mine 1', 'nothing changed');
  await pick('toolbar-pull-menu', 'Pull with rebase');
  await statusHas(/Pulling.*rebase.*: done/);
  await until(async () => git(P.dir, 'log', '--format=%s', '-2').trim() === 'Mine 1\nTheirs 1', 'mine on top of theirs');
  expect(git(P.dir, 'rev-list', '--merges', 'HEAD').trim() === '', 'no merge commit');
  diverge(2);
  await refreshUi();
  await pick('toolbar-pull-menu', 'Pull with merge');
  await statusHas(/Pulling.*merge.*: done/);
  await until(async () => git(P.dir, 'rev-list', '--merges', 'HEAD').trim().split('\n').filter(Boolean).length === 1, 'a merge commit');
});

await step('toolbar · pull: the dialog — the upstream first, what will come, Into the current branch, the mode (remembered as the pull mode), local changes counted once; Enter pulls, Escape closes', async () => {
  git(P.dir, 'push', '-q', 'origin', 'main');
  git(P.other, 'pull', '-q', '--no-rebase', 'origin', 'main');
  commit(P.other, 'x.txt', 'x\n', 'Theirs x');
  commit(P.other, 'y.txt', 'y\n', 'Theirs y');
  git(P.other, 'push', '-q', 'origin', 'main');
  git(P.other, 'switch', '-q', '-c', 'feat');
  commit(P.other, 'f.txt', 'f\n', 'Feature');
  git(P.other, 'push', '-q', 'origin', 'feat');
  git(P.other, 'switch', '-q', 'main');
  git(P.dir, 'fetch', '-q', 'origin');
  // a file staged and edited again, and a new one: two changed files
  writeFileSync(path.join(P.dir, 'a.txt'), 'one\ntwo\nthree\nstaged\n');
  git(P.dir, 'add', 'a.txt');
  writeFileSync(path.join(P.dir, 'a.txt'), 'one\ntwo\nthree\nstaged\nedited\n');
  writeFileSync(path.join(P.dir, 'new.txt'), 'new\n');
  await refreshUi();
  await tid('toolbar-pull').click();
  await waitShown('pull-dialog');
  expect((await tid('pull-remote').innerText()).includes('origin'), 'origin');
  expect(/main\s*upstream/.test(await tid('pull-branch').innerText()), 'its upstream branch, marked: ' + (await tid('pull-branch').innerText()));
  let text = await dialogText('pull-dialog');
  expect(/2 new commits from origin\/main/.test(text), 'what comes: ' + text);
  expect(/2 local changes: git stops if/.test(text), 'two local changes (one file staged and edited again counts once): ' + text);
  await tid('pull-autostash').click();
  expect(/2 local changes go to the stash and come back/.test(await dialogText('pull-dialog')), 'autostash explained');
  await tid('pull-autostash').click();
  // another branch of the remote: pulled this once, the upstream stays
  await tid('pull-branch').click();
  await waitShown('pull-branch-list');
  const branches = await page.evaluate(() => [...document.querySelectorAll('[data-testid="pull-branch-list"] [data-testid^="pick-"]')].map((e) => e.getAttribute('data-testid').slice(5)));
  expect(branches[0] === 'main' && branches.includes('feat'), 'the upstream first: ' + branches.join(', '));
  await tid('pick-feat').click();
  expect(/origin\/feat is not what main tracks \(origin\/main\): it is pulled in this once, the upstream stays/.test(await dialogText('pull-dialog')), 'says it is not the upstream');
  await page.keyboard.press('Escape');
  await waitGone('pull-dialog');
  expect(git(P.dir, 'log', '-1', '--format=%s').trim() !== 'Theirs y', 'Escape pulled nothing');
  // the mode: Merge, Enter; it becomes the pull mode the ▾ menu uses
  await tid('toolbar-pull').click();
  await waitShown('pull-dialog');
  const before = (await settings()).pullMode;
  const other = before === 'merge' ? 'rebase' : 'merge';
  await tid(`pull-mode-${other}`).click();
  await waitShown(`pull-mode-${other}-on`, 2000);
  await tid('pull-autostash').click();
  await page.keyboard.press('Enter');
  await statusHas(/Pulling.*: done/);
  await until(async () => git(P.dir, 'log', '--format=%s', 'main').includes('Theirs y'), 'pulled');
  expect(git(P.dir, 'status', '--porcelain').includes('new.txt'), 'local changes are back');
  await until(async () => (await settings()).pullMode === other, 'the mode is the pull mode now');
  await tid('toolbar-pull').click();
  await waitShown(`pull-mode-${other}-on`);
  expect(await ticked('pull-autostash'), 'autostash remembered');
  await page.keyboard.press('Escape');
  const items = await quickMenu('toolbar-pull-menu');
  expect(items[0].label.endsWith(`(${other})`), 'the quick pull uses it: ' + items[0].label);
  await closeMenu();
  git(P.dir, 'reset', '-q', '--hard');
  rmSync(path.join(P.dir, 'new.txt'), { force: true });
});

await step('toolbar · pull: a pull that conflicts says so; the panel shows the merge in progress (whole, at 1000 px too) and Abort takes it back', async () => {
  git(P.dir, 'reset', '-q', '--hard', 'origin/main');
  commit(P.other, 'a.txt', 'one\nTHEIRS\nthree\n', 'Theirs edits a');
  git(P.other, 'push', '-q', 'origin', 'main');
  const mine = commit(P.dir, 'a.txt', 'one\nMINE\nthree\n', 'Mine edits a');
  await refreshUi();
  await pick('toolbar-pull-menu', 'Pull with merge');
  await waitShown('error-dialog', 10000);
  expect(/stopped on conflicts/.test(await tid('error-title').innerText()), 'it stopped on conflicts: ' + (await tid('error-title').innerText()));
  const detail = await tid('error-detail').innerText();
  // the conflict is on git's stdout: it used to be left out, and progress lines filled the window instead
  expect(/CONFLICT \(content\): Merge conflict in a\.txt/.test(detail), 'git’s conflict report: ' + detail.slice(0, 300));
  expect(!/Counting objects:\s+\d+%/.test(detail), 'no progress lines: ' + detail.slice(0, 300));
  expect(/Resolve the conflicted files/.test(await tid('error-hint').innerText()), 'what to do');
  await tid('error-close').click();
  await page.waitForFunction(() => /merging/i.test(document.querySelector('[data-testid="op-state"]')?.textContent ?? ''), null, { timeout: 8000 });
  expect(!(await has('op-continue')), 'a merge goes on with a commit, not Continue');
  try {
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.waitForTimeout(300);
    await shot('merge-1000', { x: 300, y: 0, width: 700, height: 80 });
    const fit = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="op-state"]');
      const body = document.querySelector('[data-testid="activity-branch"]').getBoundingClientRect();
      const abort = document.querySelector('[data-testid="op-abort"]').getBoundingClientRect();
      const counter = document.querySelector('[data-testid="error-log-button"]')?.getBoundingClientRect();
      return { cut: s.scrollWidth > s.clientWidth + 1, text: s.textContent, abortInside: abort.right <= body.right + 0.5 && abort.width > 10, onCounter: !!counter && abort.right > counter.left + 0.5 };
    });
    expect(!fit.cut, 'the state is not cut off: ' + fit.text);
    expect(fit.abortInside, 'Abort is inside the panel');
    expect(!fit.onCounter, 'Abort is not drawn over the error counter');
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await tid('op-abort').click();
  await waitGone('op-state', 8000);
  expect(!existsSync(path.join(P.dir, '.git/MERGE_HEAD')) && shaOf(P.dir, 'HEAD') === mine, 'the merge is gone, HEAD is mine');
});

await step('toolbar · pull: with HEAD detached, the dialog explains, the quick items are off and say why, the panel says where HEAD is', async () => {
  git(P.dir, 'checkout', '-q', '--detach', 'HEAD~1');
  await refreshUi();
  const sha = shaOf(P.dir, 'HEAD').slice(0, 7);
  await page.waitForFunction((s) => (document.querySelector('[data-testid="activity-branch"]')?.textContent ?? '').includes(`detached at ${s}`), sha, { timeout: 5000 });
  await tid('toolbar-pull').click();
  await waitShown('pull-dialog');
  expect(/HEAD is detached/.test(await dialogText('pull-dialog')), 'explained');
  expect(await disabledBtn('pull-go'), 'Pull is off');
  await page.keyboard.press('Escape');
  for (const [b, label] of [['toolbar-pull-menu', 'Pull now — HEAD is detached'], ['toolbar-push-menu', 'Push now — HEAD is detached']]) {
    const items = await quickMenu(b);
    expect(items[0].label === label && items[0].disabled, `${b}: ${labels(items)}`);
    await closeMenu();
  }
  git(P.dir, 'checkout', '-q', 'main');
  await refreshUi();
});

// ======================================================================================== push
let U;
await step('toolbar · push: the ▾ menu pushes the branch to its upstream, and with all tags', async () => {
  U = await syncRepo('tb-push');
  const mine = commit(U.dir, 'p.txt', 'p\n', 'To push');
  git(U.dir, 'tag', 'v-push');
  await open('tb-push');
  const items = await quickMenu('toolbar-push-menu');
  expect(labels(items) === 'Push main → origin/main now | Push with all tags | Push…', 'the items: ' + labels(items));
  await tid('context-menu').getByText('Push main → origin/main now', { exact: true }).click();
  await statusHas(/Pushing main to origin\/main: done/);
  expect(shaOf(U.origin, 'main') === mine, 'on the server');
  await page.waitForFunction(() => !/\d\s*$/.test(document.querySelector('[data-testid="toolbar-push"]')?.innerText ?? '1'), null, { timeout: 5000 });
  expect(!refExists(U.origin, 'refs/tags/v-push'), 'no tag yet');
  await pick('toolbar-push-menu', 'Push with all tags');
  await statusHas(/Pushing main to origin\/main: done/);
  await until(async () => refExists(U.origin, 'refs/tags/v-push'), 'the tag is on the server');
});

await step('toolbar · push: the dialog — a new branch is created there and tracked; a bad name is refused; the list ▾ picks a branch of the remote; Force turns red and warns; Enter pushes, Escape closes', async () => {
  git(U.dir, 'switch', '-q', '-c', 'topic');
  const topic = commit(U.dir, 'topic.txt', 't\n', 'Topic work');
  await refreshUi();
  await tid('toolbar-push').click();
  await waitShown('push-dialog');
  expect(/topic\s*current/.test(await tid('push-branch').innerText()), 'the current branch first: ' + (await tid('push-branch').innerText()));
  expect((await tid('push-remote-branch').inputValue()) === 'topic', 'the same name on the remote');
  expect(/creates topic on origin/.test(await dialogText('push-dialog')), 'what will happen');
  expect(await ticked('push-track'), 'tracking it is ticked (it has no upstream)');
  // a bad name: said, and Push is off
  await tid('push-remote-branch').fill('bad..name');
  expect(/Not a valid branch name/.test(await dialogText('push-dialog')) && (await disabledBtn('push-go')), 'refused');
  // a branch of the remote from the list: updates it, which topic does not track
  await tid('push-remote-branch-pick').click();
  await waitShown('push-remote-branch-list');
  await tid('push-remote-branch-list').getByTestId('pick-main').click();
  expect((await tid('push-remote-branch').inputValue()) === 'main', 'picked');
  expect(/updates origin\/main, which topic does not track/.test(await dialogText('push-dialog')), 'what will happen: ' + (await dialogText('push-dialog')));
  // force: the button and the warning
  await tid('push-force').click();
  expect((await tid('push-go').innerText()).toLowerCase() === 'force push', 'the button says Force push');
  expect(/is overwritten with topic/.test(await dialogText('push-dialog')), 'and warns');
  await shot('push-force');
  await page.keyboard.press('Escape');
  await waitGone('push-dialog');
  expect(!refExists(U.origin, 'refs/heads/topic') && shaOf(U.origin, 'main') !== topic, 'Escape pushed nothing');
  // again, as it starts: Enter
  await tid('toolbar-push').click();
  await waitShown('push-dialog');
  expect(!(await ticked('push-force')), 'force is never remembered');
  await tid('push-tags').click();
  await page.keyboard.press('Enter');
  await statusHas(/Pushing topic to origin\/topic: done/);
  await page.waitForTimeout(300);
  expect(!(await has('push-dialog')), 'the dialog does not open again after Enter');
  expect(shaOf(U.origin, 'topic') === topic, 'created on the server');
  expect(upOf(U.dir, 'topic') === 'origin/topic', 'and tracked');
  await page.waitForFunction(() => /topic.*= origin\/topic/.test(document.querySelector('[data-testid="activity-branch"]')?.textContent ?? ''), null, { timeout: 5000 });
  // “Push all tags” is remembered; force never is
  await tid('toolbar-push').click();
  await waitShown('push-dialog');
  expect((await ticked('push-tags')) && !(await ticked('push-force')), 'tags remembered, force not');
  await tid('push-tags').click();
  await page.keyboard.press('Escape');
  await waitGone('push-dialog');
  git(U.dir, 'switch', '-q', 'main');
  await refreshUi();
});

await step('toolbar · push: rejected because the server has commits we do not — the error says to pull first; Force push then overwrites it', async () => {
  git(U.other, 'pull', '-q', '--no-rebase', 'origin', 'main');
  commit(U.other, 'other.txt', 'o\n', 'Pushed by someone else');
  git(U.other, 'push', '-q', 'origin', 'main');
  const mine = commit(U.dir, 'mine2.txt', 'm\n', 'Mine, not pushed');
  git(U.dir, 'fetch', '-q', 'origin');
  await refreshUi();
  await pick('toolbar-push-menu', 'Push main → origin/main now');
  await waitShown('error-dialog', 10000);
  expect((await tid('error-title').innerText()) === 'Pushing main to origin/main failed', 'title: ' + (await tid('error-title').innerText()));
  expect(/rejected/.test(await tid('error-detail').innerText()), 'git’s words');
  expect(/Pull \(or fetch and rebase\) first, then push/.test(await tid('error-hint').innerText()), 'what to do');
  await tid('error-close').click();
  expect(shaOf(U.origin, 'main') !== mine, 'the server kept its commit');
  await tid('toolbar-push').click();
  await waitShown('push-dialog');
  expect(/1 commit to push · 1 commit on origin\/main are not here: pull first, or force push/.test(await dialogText('push-dialog')), 'the dialog warns too: ' + (await dialogText('push-dialog')));
  await tid('push-force').click();
  await tid('push-go').click();
  await statusHas(/Pushing main to origin\/main \(force\): done|Pushing main to origin\/main: done/);
  await until(async () => shaOf(U.origin, 'main') === mine, 'force-pushed');
});

await step('toolbar · push: the server refusing the push (a hook, a protected branch) is not explained as “pull first”', async () => {
  const hook = path.join(U.origin, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "GL-HOOK-ERR: protected branch: pushing to main is not allowed" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  try {
    commit(U.dir, 'mine3.txt', 'm\n', 'Refused by the server');
    await refreshUi();
    await pick('toolbar-push-menu', 'Push main → origin/main now');
    await waitShown('error-dialog', 10000);
    expect(/remote rejected|pre-receive hook declined/.test(await tid('error-detail').innerText()), 'git’s words');
    const hint = await tid('error-hint').innerText();
    expect(/server refused the push/.test(hint) && !/Pull/.test(hint), 'the server said no: ' + hint);
    await tid('error-close').click();
  } finally {
    rmSync(hook, { force: true });
  }
});

// ======================================================================================== stash
let S;
await step('toolbar · stash: the dialog counts the changed files once, without new files when they are left out; a message and Enter stash them; Undo puts them back', async () => {
  S = await syncRepo('tb-stash');
  writeFileSync(path.join(S.dir, 'a.txt'), 'one\ntwo\nthree\nstaged\n');
  git(S.dir, 'add', 'a.txt');
  writeFileSync(path.join(S.dir, 'a.txt'), 'one\ntwo\nthree\nstaged\nedited\n');
  writeFileSync(path.join(S.dir, 'new.txt'), 'new\n');
  await open('tb-stash');
  await tid('toolbar-stash').click();
  await waitShown('stash-message');
  expect((await tid('stash-count').innerText()) === '2 changed files will be stashed.', 'a.txt and new.txt: ' + (await tid('stash-count').innerText()));
  await tid('stash-untracked').click();
  expect((await tid('stash-count').innerText()) === '1 changed file will be stashed.', 'without the new file: ' + (await tid('stash-count').innerText()));
  await tid('stash-untracked').click();
  await tid('stash-message').fill('wip one');
  await page.keyboard.press('Enter');
  await statusHas(/Saved working directory to stash/);
  await until(async () => git(S.dir, 'stash', 'list').includes('wip one') && git(S.dir, 'status', '--porcelain').trim() === '', 'stashed, the working copy is clean');
  await page.waitForFunction(() => /Undo Stash “wip one”/.test(document.querySelector('[data-testid="undo-button"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 5000 });
  await tid('undo-button').click();
  await statusHas(/Undone: Stash “wip one”/);
  await until(async () => git(S.dir, 'stash', 'list').trim() === '' && git(S.dir, 'status', '--porcelain').includes('new.txt'), 'the changes are back, the stash is gone');
});

await step('toolbar · stash: Keep staged changes stashes them and leaves the index as it was', async () => {
  await refreshUi();
  git(S.dir, 'add', 'a.txt');
  await refreshUi();
  await tid('toolbar-stash').click();
  await waitShown('stash-message');
  await tid('stash-keep').click();
  // Enter with the focus on the checkbox: the dialog's default button, not a second tick
  await page.keyboard.press('Enter');
  await statusHas(/Saved working directory to stash/);
  await until(async () => git(S.dir, 'stash', 'list').trim() !== '', 'stashed');
  expect(git(S.dir, 'diff', '--cached', '--name-only').trim() === 'a.txt', 'a.txt stays staged');
  git(S.dir, 'stash', 'drop', '-q');
  git(S.dir, 'reset', '-q', '--hard');
  git(S.dir, 'clean', '-fdq');
});

await step('toolbar · stash: only new files changed and “Include untracked” off — it says so and cannot stash nothing', async () => {
  writeFileSync(path.join(S.dir, 'only-new.txt'), 'n\n');
  await refreshUi();
  await tid('toolbar-stash').click();
  await waitShown('stash-message');
  expect((await tid('stash-count').innerText()) === '1 changed file will be stashed.', 'the new file: ' + (await tid('stash-count').innerText()));
  await tid('stash-untracked').click();
  expect(/Only new \(untracked\) files are changed/.test(await tid('stash-count').innerText()), 'says why: ' + (await tid('stash-count').innerText()));
  // it used to stash "nothing" and announce "Saved working directory to stash"
  expect(await disabledBtn('stash-go'), 'Stash is off');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  expect(git(S.dir, 'stash', 'list').trim() === '' && (await has('stash-message')), 'Enter does nothing');
  await page.keyboard.press('Escape');
  rmSync(path.join(S.dir, 'only-new.txt'));
});

// ======================================================================================== branch
await step('toolbar · branch: the dialog says why a name cannot be used (spaces, "..", ".lock", a name in use, in another case too) and takes what git takes', async () => {
  await refreshUi();
  await tid('toolbar-branch').click();
  await waitShown('branch-name');
  expect(/From:\s*[0-9a-f]{7}\s*\(main\)/.test(await tid('branch-from').innerText()), 'starts at HEAD, on main: ' + (await tid('branch-from').innerText()));
  expect(await disabledBtn('branch-create'), 'Create is off with no name');
  const cases = [
    ['has space', /Invalid branch name\s*: no spaces/],
    ['a..b', /no \.\./],
    ['topic.lock', /\.lock/],
    ['-x', /cannot start with -/],
    ['a//b', /\/ only between parts/],
    ['main', /A branch named main already exists/],
    // another case is the same file on this disk
    ['MAIN', /A branch named main already exists/],
  ];
  for (const [name, why] of cases) {
    await tid('branch-name').fill(name);
    const note = (await has('branch-note')) ? await tid('branch-note').innerText() : (await has('branch-exists')) ? await tid('branch-exists').innerText() : '';
    expect(why.test(note), `“${name}”: ${note || 'no reason given'}`);
    expect(await disabledBtn('branch-create'), `“${name}”: Create is off`);
  }
  // names git takes that the dialog used to refuse
  for (const name of ['fix#12', 'release+1', 'feature/über']) {
    await tid('branch-name').fill(name);
    expect(!(await has('branch-note')) && !(await has('branch-exists')) && !(await disabledBtn('branch-create')), `“${name}” is a valid name`);
  }
  await page.keyboard.press('Escape');
});

await step('toolbar · branch: Enter creates the branch and checks it out; unticked, it stays on the current one; Undo takes it back', async () => {
  await tid('toolbar-branch').click();
  await waitShown('branch-name');
  await tid('branch-name').fill('feature/new');
  await page.keyboard.press('Enter');
  await statusHas(/Created branch feature\/new/);
  await until(async () => headOf(S.dir) === 'feature/new', 'checked out');
  await page.waitForFunction(() => /feature\/new/.test(document.querySelector('[data-testid="activity-branch"]')?.textContent ?? ''), null, { timeout: 5000 });
  await page.keyboard.press('Meta+z');
  await statusHas(/Undone: Create branch feature\/new/);
  await until(async () => headOf(S.dir) === 'main' && !refExists(S.dir, 'refs/heads/feature/new'), 'back on main, the branch gone');
  await tid('toolbar-branch').click();
  await waitShown('branch-name');
  await tid('branch-name').fill('keep-here');
  await tid('branch-checkout').click();
  await tid('branch-create').click();
  await statusHas(/Created branch keep-here/);
  await until(async () => refExists(S.dir, 'refs/heads/keep-here'), 'created');
  expect(headOf(S.dir) === 'main', 'still on main');
  git(S.dir, 'branch', '-q', '-D', 'keep-here');
  await refreshUi();
});

// ======================================================================================== merge
let M;
await step('toolbar · merge: the list leaves out the current branch; --no-ff and --squash exclude each other; Enter merges; Undo takes the merge back', async () => {
  M = await syncRepo('tb-merge');
  git(M.dir, 'switch', '-q', '-c', 'side');
  commit(M.dir, 'side.txt', 's\n', 'Side work');
  git(M.dir, 'switch', '-q', 'main');
  commit(M.dir, 'main2.txt', 'm\n', 'Main work');
  await open('tb-merge');
  await tid('toolbar-merge').click();
  await waitShown('merge-dialog');
  expect(!(await has('branch-pick-main')) && (await has('branch-pick-side')), 'main (current) is not offered, side is');
  expect(await disabledBtn('merge-go'), 'nothing picked: off');
  await tid('branch-pick-side').click();
  expect((await tid('merge-go').innerText()).toLowerCase() === 'merge into main', 'names the target');
  await tid('merge-no-ff').click();
  await tid('merge-squash').click();
  expect((await ticked('merge-squash')) && !(await ticked('merge-no-ff')), 'squash unticks --no-ff');
  await tid('merge-no-ff').click();
  expect((await ticked('merge-no-ff')) && !(await ticked('merge-squash')), '--no-ff unticks squash');
  const before = shaOf(M.dir, 'HEAD');
  await page.keyboard.press('Enter');
  await statusHas(/Merged side/);
  await until(async () => git(M.dir, 'rev-list', '--parents', '-1', 'HEAD').trim().split(' ').length === 3, 'a merge commit');
  await page.waitForFunction(() => /Undo Merge side/.test(document.querySelector('[data-testid="undo-button"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 5000 });
  await tid('undo-button').click();
  await statusHas(/Undone: Merge side/);
  await until(async () => shaOf(M.dir, 'HEAD') === before, 'the merge is taken back');
});

await step('toolbar · merge: a squash stages the changes and says to commit them (it said "Merged")', async () => {
  await tid('toolbar-merge').click();
  await waitShown('merge-dialog');
  await tid('branch-pick-side').click();
  await tid('merge-squash').click();
  const before = shaOf(M.dir, 'HEAD');
  await tid('merge-go').click();
  await statusHas(/Squashed side into the staged changes/);
  await until(async () => git(M.dir, 'diff', '--cached', '--name-only').trim() === 'side.txt', 'side’s change is staged');
  expect(shaOf(M.dir, 'HEAD') === before, 'no commit made');
  git(M.dir, 'reset', '-q', '--hard');
  await refreshUi();
});

// ======================================================================================== rebase
let R;
await step('toolbar · rebase: the dialog counts what is replayed; Autostash (ticked) carries local changes over, unticked git refuses; Enter rebases; Undo takes it back', async () => {
  R = await syncRepo('tb-rebase');
  git(R.dir, 'switch', '-q', '-c', 'feat');
  commit(R.dir, 'f1.txt', '1\n', 'Feat one');
  commit(R.dir, 'f2.txt', '2\n', 'Feat two');
  git(R.dir, 'switch', '-q', 'main');
  commit(R.dir, 'm.txt', 'm\n', 'Main moves on');
  git(R.dir, 'switch', '-q', 'feat');
  writeFileSync(path.join(R.dir, 'a.txt'), 'one\ntwo\nthree\nlocal\n');
  await open('tb-rebase');
  await tid('toolbar-rebase').click();
  await waitShown('rebase-dialog');
  await tid('branch-pick-main').click();
  expect((await tid('rebase-note').innerText()) === '2 commits will be replayed on top of main', 'counts: ' + (await tid('rebase-note').innerText()));
  expect(await ticked('rebase-autostash'), 'autostash ticked (what it does)');
  expect(!(await ticked('rebase-merges')), 'merges are not kept unless asked');
  // unticked: git refuses because of the local change
  await tid('rebase-autostash').click();
  await page.keyboard.press('Enter');
  await waitShown('error-dialog', 10000);
  expect(/unstaged changes|commit or stash/i.test(await tid('error-detail').innerText()), 'git refuses: ' + (await tid('error-detail').innerText()));
  await tid('error-close').click();
  const before = shaOf(R.dir, 'HEAD');
  await tid('toolbar-rebase').click();
  await waitShown('rebase-dialog');
  await tid('branch-pick-main').click();
  await page.keyboard.press('Enter');
  await statusHas(/Rebased onto main/);
  await until(async () => rebaseOver(R.dir) && git(R.dir, 'log', '--format=%s', '-3').trim() === 'Feat two\nFeat one\nMain moves on', 'replayed on main');
  expect(readFileSync(path.join(R.dir, 'a.txt'), 'utf8').includes('local'), 'the local change came along');
  await page.keyboard.press('Meta+z');
  await statusHas(/Undone: Rebase onto main/);
  await until(async () => shaOf(R.dir, 'HEAD') === before, 'back as it was');
  git(R.dir, 'checkout', '-q', '--', 'a.txt');
});

await step('toolbar · rebase: a branch behind the target, with nothing of its own, is fast-forwarded (the button used to be off: “0 commits”)', async () => {
  git(R.dir, 'switch', '-q', '-c', 'behind', 'main~1');
  await refreshUi();
  await tid('toolbar-rebase').click();
  await waitShown('rebase-dialog');
  await tid('branch-pick-main').click();
  expect(/behind has no commits of its own: it moves up to main \(fast-forward\)/.test(await tid('rebase-note').innerText()), 'says so: ' + (await tid('rebase-note').innerText()));
  expect(!(await disabledBtn('rebase-run')), 'Rebase is on');
  await tid('rebase-run').click();
  await statusHas(/Rebased onto main/);
  await until(async () => rebaseOver(R.dir) && shaOf(R.dir, 'HEAD') === shaOf(R.dir, 'main'), 'moved up to main');
  git(R.dir, 'switch', '-q', 'feat');
  git(R.dir, 'branch', '-q', '-D', 'behind');
  await refreshUi();
});

await step('toolbar · rebase: Preserve merges keeps a merge commit; without it the history comes out flat', async () => {
  git(R.dir, 'switch', '-q', '-c', 'inner', 'feat');
  commit(R.dir, 'i.txt', 'i\n', 'Inner work');
  git(R.dir, 'switch', '-q', 'feat');
  git(R.dir, 'merge', '-q', '--no-ff', '-m', 'Merge inner', 'inner');
  const before = shaOf(R.dir, 'HEAD');
  await refreshUi();
  for (const keep of [true, false]) {
    await tid('toolbar-rebase').click();
    await waitShown('rebase-dialog');
    await tid('branch-pick-main').click();
    if (keep) await tid('rebase-merges').click();
    await tid('rebase-run').click();
    await statusHas(/Rebased onto main/);
    await until(async () => rebaseOver(R.dir) && headOf(R.dir) === 'feat' && isAncestor(R.dir, 'main', 'feat') && shaOf(R.dir, 'feat') !== before, 'rebased');
    const merges = git(R.dir, 'rev-list', '--merges', 'main..HEAD').trim().split('\n').filter(Boolean).length;
    expect(keep ? merges === 1 : merges === 0, `${keep ? 'with' : 'without'} preserve merges: ${merges} merge commits`);
    git(R.dir, 'reset', '-q', '--hard', before);
    await refreshUi();
  }
});

await step('toolbar · rebase: Interactive with “Squash all” makes one commit of the branch’s commits (local changes stashed around it)', async () => {
  git(R.dir, 'switch', '-q', '-c', 'squashme', 'main');
  commit(R.dir, 's1.txt', '1\n', 'Squash one');
  commit(R.dir, 's2.txt', '2\n', 'Squash two');
  writeFileSync(path.join(R.dir, 'a.txt'), 'one\ntwo\nthree\nlocal again\n');
  await refreshUi();
  await tid('toolbar-rebase').click();
  await waitShown('rebase-dialog');
  await tid('rebase-interactive').click();
  expect(await disabledBtn('rebase-merges'), 'Preserve merges is off with an interactive list');
  await tid('branch-pick-main').click();
  expect((await tid('rebase-note').innerText()).startsWith('2 commits'), 'two commits: ' + (await tid('rebase-note').innerText()));
  await page.getByText('Squash all', { exact: true }).click();
  // a message edited in the list (the first commit's: reword): Enter ends the edit, it does not start the rebase
  await page.getByText('Squash one', { exact: true }).last().click();
  const edit = page.locator('[data-testid="rebase-dialog"] input').last();
  await edit.fill('Squashed work');
  await edit.press('Enter');
  await page.waitForTimeout(300);
  expect(await has('rebase-dialog'), 'Enter in the message ended the edit, the dialog stays');
  expect(git(R.dir, 'rev-list', '--count', 'main..HEAD').trim() === '2', 'nothing rebased yet');
  await tid('rebase-run').click();
  await statusHas(/Rebased onto main/);
  // git puts the stashed change back last: wait for all of it
  await until(async () => rebaseOver(R.dir) && git(R.dir, 'rev-list', '--count', 'main..HEAD').trim() === '1' && readFileSync(path.join(R.dir, 'a.txt'), 'utf8').includes('local again'), 'one commit on top of main, and the local change came along (autostash)');
  expect(existsSync(path.join(R.dir, 's1.txt')) && existsSync(path.join(R.dir, 's2.txt')), 'with both changes');
  expect(git(R.dir, 'log', '-1', '--format=%s').trim() === 'Squashed work', 'under the message typed: ' + git(R.dir, 'log', '-1', '--format=%s'));
  git(R.dir, 'checkout', '-q', '--', 'a.txt');
  git(R.dir, 'switch', '-q', 'feat');
  await refreshUi();
});

await step('toolbar · rebase: onto a commit with no branch on it (the history’s menu) rebases onto the commit itself, no __tmp_ branch is left', async () => {
  git(R.dir, 'switch', '-q', 'main');
  commit(R.dir, 'm2.txt', 'm2\n', 'Main later');
  git(R.dir, 'switch', '-q', 'feat');
  const target = shaOf(R.dir, 'main~1');
  await refreshUi();
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByText('Main moves on', { exact: true }).first().click({ button: 'right' });
  await waitShown('context-menu');
  await tid('context-menu').getByText('Rebase feat onto here', { exact: true }).click();
  await waitShown('rebase-dialog');
  // the commit itself: it used to fall back to origin/main, and the rebase went there
  const shown = await tid('rebase-dialog').innerText();
  expect(shown.includes(`${target.slice(0, 7)} (commit)`), 'onto the commit: ' + shown.slice(0, 200));
  await tid('rebase-run').click();
  await statusHas(/Rebased onto [0-9a-f]{7}/);
  await until(async () => rebaseOver(R.dir) && headOf(R.dir) === 'feat' && git(R.dir, 'merge-base', 'HEAD', 'main').trim() === target, 'replayed onto the commit');
  expect(git(R.dir, 'branch', '--list', '__tmp_*').trim() === '', 'no temporary branch: ' + git(R.dir, 'branch', '--list', '__tmp_*'));
});

await step('toolbar · rebase: stopped on conflicts — the panel offers Continue and Abort; Continue after resolving finishes it, Abort takes it back', async () => {
  git(R.dir, 'switch', '-q', 'main');
  commit(R.dir, 'a.txt', 'one\nMAIN\nthree\n', 'Main edits a');
  git(R.dir, 'switch', '-q', '-c', 'clash', 'main~1');
  commit(R.dir, 'a.txt', 'one\nCLASH\nthree\n', 'Clash edits a');
  await refreshUi();
  for (const how of ['abort', 'continue']) {
    const before = shaOf(R.dir, 'HEAD');
    await tid('toolbar-rebase').click();
    await waitShown('rebase-dialog');
    await tid('branch-pick-main').click();
    await tid('rebase-run').click();
    await waitShown('error-dialog', 10000);
    expect(/Rebase stopped on conflicts/.test(await tid('error-title').innerText()), 'says it stopped');
    await tid('error-close').click();
    await page.waitForFunction(() => /rebasing/i.test(document.querySelector('[data-testid="op-state"]')?.textContent ?? ''), null, { timeout: 8000 });
    expect((await has('op-continue')) && (await has('op-abort')), 'Continue and Abort');
    if (how === 'abort') {
      await tid('op-abort').click();
      await waitGone('op-state', 8000);
      expect(shaOf(R.dir, 'HEAD') === before && headOf(R.dir) === 'clash', 'back on clash as it was');
    } else {
      writeFileSync(path.join(R.dir, 'a.txt'), 'one\nMAIN and CLASH\nthree\n');
      git(R.dir, 'add', 'a.txt');
      await refreshUi();
      await tid('op-continue').click();
      await statusHas(/Continued rebase/);
      await waitGone('op-state', 8000);
      expect(git(R.dir, 'log', '--format=%s', '-2').trim() === 'Clash edits a\nMain edits a', 'finished on top of main');
    }
  }
});

await step('toolbar · cherry-pick stopped on conflicts (from a terminal): Abort in the panel takes it back (it ran “merge --abort”), Continue finishes it', async () => {
  git(R.dir, 'switch', '-q', '-c', 'pick-here', 'main~1');
  commit(R.dir, 'a.txt', 'one\nHERE\nthree\n', 'Here edits a');
  const theirs = shaOf(R.dir, 'main');
  for (const how of ['abort', 'continue']) {
    const before = shaOf(R.dir, 'HEAD');
    try {
      git(R.dir, 'cherry-pick', theirs);
    } catch {
      /* stopped on the conflict */
    }
    await refreshUi();
    await page.waitForFunction(() => /cherry-picking/i.test(document.querySelector('[data-testid="op-state"]')?.textContent ?? ''), null, { timeout: 8000 });
    if (how === 'abort') {
      await tid('op-abort').click();
      await waitGone('op-state', 8000);
      expect(!existsSync(path.join(R.dir, '.git/CHERRY_PICK_HEAD')) && shaOf(R.dir, 'HEAD') === before, 'aborted');
      expect(!(await has('error-dialog')), 'no error');
    } else {
      expect(await has('op-continue'), 'Continue is offered');
      writeFileSync(path.join(R.dir, 'a.txt'), 'one\nHERE and MAIN\nthree\n');
      git(R.dir, 'add', 'a.txt');
      await refreshUi();
      await tid('op-continue').click();
      await statusHas(/Continued cherry-pick/);
      await waitGone('op-state', 8000);
      expect(git(R.dir, 'log', '-1', '--format=%s').trim() === 'Main edits a', 'the picked commit is made');
    }
  }
});

// ======================================================================================== more
let X;
await step('toolbar · more: every item is there, with its shortcut; off items say why in a few words that fit the menu', async () => {
  X = await syncRepo('tb-more');
  await open('tb-more');
  // the submodules are read a moment after the repository: until then "Update all" cannot know there are none
  let items = [];
  for (let i = 0; i < 20; i++) {
    items = await quickMenu('toolbar-more');
    if (items.some((it) => it.label === 'Submodules → Update — none here')) break;
    await closeMenu();
    await page.waitForTimeout(250);
  }
  const want = ['Open in Terminal', 'Open in Finder', 'Open in editor', 'Fetch every branch — all followed', 'Fetch the full history — complete', 'Unshallow — not a shallow clone', 'Submodules → Update — none here', 'Submodules → Update recursively', 'Restore Git LFS files…', 'Refresh', 'Undo — nothing to undo', 'Connection (SSH key / account)…', 'Preferences…', 'Keyboard shortcuts'];
  expect(labels(items.map((i) => ({ ...i, disabled: false }))) === want.join(' | '), 'the items: ' + labels(items));
  const off = items.filter((i) => i.disabled).map((i) => i.label);
  expect(off.join(' | ') === 'Fetch every branch — all followed | Fetch the full history — complete | Unshallow — not a shallow clone | Submodules → Update — none here | Submodules → Update recursively | Undo — nothing to undo', 'off: ' + off.join(' | '));
  const shortcuts = Object.fromEntries(items.filter((i) => i.shortcut).map((i) => [i.label, i.shortcut]));
  expect(shortcuts['Open in Terminal'] === '⌃⌥T' && shortcuts['Refresh'] === '⌘R' && shortcuts['Preferences…'] === '⌘,' && shortcuts['Keyboard shortcuts'] === '⌘/', 'shortcuts: ' + JSON.stringify(shortcuts));
  const cut = await page.evaluate(() => [...document.querySelectorAll('[data-testid="context-menu"] [data-testid="menu-item"]')].map((e) => e.firstElementChild?.firstElementChild).filter((t) => t && t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent));
  expect(cut.length === 0, 'cut off: ' + cut.join(' | '));
  await shot('more-menu');
  await closeMenu();
});

await step('toolbar · more: Open in Terminal / Finder / editor ask the engine for this repository’s folder; ⌃⌥T and the palette open the terminal too', async () => {
  for (const [label, what] of [['Open in Terminal', 'terminal'], ['Open in Finder', 'reveal'], ['Open in editor', 'open']]) {
    systemCalls.length = 0;
    await pick('toolbar-more', label);
    await until(async () => systemCalls.length > 0, `${label} asked the engine`);
    expect(systemCalls[0].what === what && systemCalls[0].body.path.endsWith('/tb-more'), `${label}: ${JSON.stringify(systemCalls[0])}`);
  }
  systemCalls.length = 0;
  await page.keyboard.press('Control+Alt+t');
  await until(async () => systemCalls.some((c) => c.what === 'terminal' && c.body.path.endsWith('/tb-more')), '⌃⌥T opens the terminal (it was shown in the menu but did nothing)');
  expect(!(await has('repo-picker')), '⌃⌥T is not ⌘T');
  systemCalls.length = 0;
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('Open in Terminal');
  await page.keyboard.press('Enter');
  await until(async () => systemCalls.some((c) => c.what === 'terminal' && c.body.path.endsWith('/tb-more')), 'the palette’s Open in Terminal opens it (it only said so)');
});

await step('toolbar · more: Refresh and ⌘R show what changed outside Prong (⌘R no longer reloads the window)', async () => {
  const count = async () => ((await has('sidebar-changes-count')) ? (await tid('sidebar-changes-count').innerText()).trim() : '0');
  await page.evaluate(() => (window.__notReloaded = true));
  writeFileSync(path.join(X.dir, 'outside1.txt'), '1\n');
  await pick('toolbar-more', 'Refresh');
  await until(async () => (await count()) === '1', 'Refresh shows the new file');
  writeFileSync(path.join(X.dir, 'outside2.txt'), '2\n');
  await page.keyboard.press('Meta+r');
  await until(async () => (await count()) === '2', '⌘R shows it too');
  expect(await page.evaluate(() => window.__notReloaded === true), 'the window was not reloaded');
  rmSync(path.join(X.dir, 'outside1.txt'));
  rmSync(path.join(X.dir, 'outside2.txt'));
  await refreshUi();
});

await step('toolbar · more: Undo names the last action and takes it back; Connection…, Preferences… and Keyboard shortcuts open what they say', async () => {
  await tid('toolbar-branch').click();
  await tid('branch-name').fill('undo-me');
  await tid('branch-checkout').click();
  await tid('branch-create').click();
  await until(async () => refExists(X.dir, 'refs/heads/undo-me'), 'created');
  await page.waitForFunction(() => /Undo Create branch undo-me/.test(document.querySelector('[data-testid="undo-button"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 5000 });
  await pick('toolbar-more', 'Undo Create branch undo-me');
  await statusHas(/Undone: Create branch undo-me/);
  await until(async () => !refExists(X.dir, 'refs/heads/undo-me'), 'gone again');
  await pick('toolbar-more', 'Connection (SSH key / account)…');
  await waitShown('connection-dialog');
  await page.keyboard.press('Escape');
  await waitGone('connection-dialog');
  await pick('toolbar-more', 'Preferences…');
  await waitShown('pref-auto-submodules');
  await page.keyboard.press('Escape');
  await pick('toolbar-more', 'Keyboard shortcuts');
  await waitShown('shortcut-row', 3000);
  await page.keyboard.press('Escape');
  await waitGone('shortcut-row');
});

await step('toolbar · more: in a shallow clone of one branch the history items are on; Unshallow brings the whole history and every branch', async () => {
  const src = otherClone(X.origin, 'tb-more-src');
  commit(src, 'h1.txt', '1\n', 'History one');
  commit(src, 'h2.txt', '2\n', 'History two');
  git(src, 'push', '-q', 'origin', 'main');
  git(src, 'push', '-q', 'origin', 'main:other-branch');
  const dir = path.join(root, 'tb-shallow');
  git(tmp, 'clone', '-q', '--depth', '1', `file://${X.origin}`, dir);
  for (const ws of ['work', 'home']) await post('/api/scan', { path: root, depth: 1, register: true, workspace: ws });
  await page.reload({ waitUntil: 'load' });
  await open('tb-shallow');
  // the Fetch dialog says what is missing and offers both
  await tid('toolbar-fetch').click();
  await waitShown('fetch-dialog');
  const fd = await dialogText('fetch-dialog');
  expect(/origin follows only some branches/.test(fd) && /Shallow clone: the history is cut off/.test(fd), 'the dialog explains: ' + fd);
  expect((await has('follow-all-origin')) && (await has('unshallow-button')), 'with a button for each');
  await page.keyboard.press('Escape');
  await waitGone('fetch-dialog');
  const items = await quickMenu('toolbar-more');
  for (const l of ['Fetch every branch of origin', 'Fetch the full history (unshallow)…', 'Unshallow the whole repository']) expect(items.some((i) => i.label === l && !i.disabled), `“${l}” is on: ${labels(items)}`);
  await tid('context-menu').getByText('Unshallow the whole repository', { exact: true }).click();
  await statusHas(/Fetching the full history.*: done/);
  await until(async () => git(dir, 'rev-parse', '--is-shallow-repository').trim() === 'false', 'the whole history');
  expect(refExists(dir, 'refs/remotes/origin/other-branch'), 'and every branch');
  const after = await quickMenu('toolbar-more');
  expect(after.some((i) => i.label === 'Unshallow — not a shallow clone' && i.disabled), 'the item is off now: ' + labels(after));
  await closeMenu();
});

await step('toolbar · more: Submodules → Update all puts a submodule moved by hand back on its recorded commit', async () => {
  const lib = path.join(tmp, 'origins/tb-lib');
  mkdirSync(lib, { recursive: true });
  git(lib, 'init', '-q', '-b', 'main');
  git(lib, 'config', 'commit.gpgsign', 'false');
  commit(lib, 'l.txt', '1\n', 'Lib one');
  commit(lib, 'l.txt', '2\n', 'Lib two');
  const dir = await freshRepo('tb-subs');
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'libs/lib');
  git(dir, 'commit', '-q', '-m', 'Add lib');
  const sub = path.join(dir, 'libs/lib');
  const recorded = shaOf(sub, 'HEAD');
  git(sub, 'checkout', '-q', 'HEAD~1');
  await open('tb-subs');
  const items = await quickMenu('toolbar-more');
  expect(items.some((i) => i.label === 'Submodules → Update all' && !i.disabled), 'on: ' + labels(items));
  await tid('context-menu').getByText('Submodules → Update all', { exact: true }).click();
  await statusHas(/Updating submodules: done/);
  await until(async () => shaOf(sub, 'HEAD') === recorded, 'back on the recorded commit');
});

// ======================================================================================== status panel
await step('toolbar · status: idle it shows the branch and where it stands: “= upstream”, ↑ ↓, “not published”, a gone upstream', async () => {
  const T = await syncRepo('tb-status');
  git(T.dir, 'switch', '-q', '-c', 'lonely');
  git(T.dir, 'switch', '-q', '-c', 'gone-up');
  git(T.dir, 'push', '-q', '-u', 'origin', 'gone-up');
  git(T.dir, 'push', '-q', 'origin', '--delete', 'gone-up');
  git(T.dir, 'switch', '-q', 'main');
  await open('tb-status');
  const shown = () => tid('activity-branch').innerText();
  expect(/main\s*= origin\/main/.test(await shown()), 'up to date: ' + (await shown()));
  for (const [b, want] of [['lonely', /lonely\s*not published/], ['gone-up', /gone-up\s*origin\/gone-up gone/]]) {
    git(T.dir, 'switch', '-q', b);
    await refreshUi();
    await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="activity-branch"]')?.innerText ?? ''), want.source, { timeout: 5000 }).catch(() => {});
    expect(want.test(await shown()), `${b}: ${await shown()}`);
  }
  // a gone upstream cannot be pulled: the quick pull says so instead of failing
  const items = await quickMenu('toolbar-pull-menu');
  expect(items[0].label === 'Pull now — origin/gone-up is gone' && items.slice(0, 4).every((i) => i.disabled), 'pull items: ' + labels(items));
  await closeMenu();
  git(T.dir, 'switch', '-q', 'main');
  await refreshUi();
});

await step('toolbar · status: a notice shows the last result (a click dismisses it); an error one has “details” that opens the error; the counter opens the log, Clear log empties it', async () => {
  await page.evaluate(() => setTimeout(() => { throw new Error('first synthetic failure'); }, 0));
  await waitShown('error-dialog');
  await page.keyboard.press('Escape');
  await waitGone('error-dialog');
  await tid('status-notice').getByText('details', { exact: true }).waitFor({ timeout: 3000 });
  await tid('status-notice').click();
  await waitShown('error-dialog');
  expect(/first synthetic failure/.test(await tid('error-detail').innerText()), 'the error behind the notice');
  await tid('error-close').click();
  const n = Number((await tid('error-log-button').innerText()).trim());
  expect(n >= 1, 'the counter: ' + n);
  await tid('error-log-button').click();
  await waitShown('error-dialog');
  await tid('error-clear').click();
  await waitGone('error-dialog');
  await waitGone('error-log-button');
  // a success notice: a click takes it away
  await tid('toolbar-branch').click();
  await tid('branch-name').fill('notice-me');
  await tid('branch-checkout').click();
  await tid('branch-create').click();
  await statusHas(/Created branch notice-me/);
  await tid('status-notice').click();
  await page.waitForFunction(() => !/Created branch notice-me/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 3000 });
  await waitShown('activity-branch');
});

// ======================================================================================== error dialog
await step('toolbar · error dialog: the same error again counts ×2; ‹ Newer / Older › and the arrows walk the log; Copy copies title and output; Enter and Escape close only it', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  // unhandled rejections with a plain reason: the same title and output each time
  await page.evaluate(() => void Promise.reject('older failure'));
  await waitShown('error-dialog');
  await page.keyboard.press('Escape');
  await waitGone('error-dialog');
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => void Promise.reject('repeated failure'));
    await waitShown('error-dialog');
    if (i === 0) {
      await page.keyboard.press('Escape');
      await waitGone('error-dialog');
    }
  }
  expect((await tid('error-dialog').innerText()).includes('×2'), 'counted twice, one entry');
  expect(/^Error 1 of 2$/i.test((await page.getByText(/^Error \d of \d$/i).first().innerText()).trim()), 'two entries in the log');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => /older failure/.test(document.querySelector('[data-testid="error-detail"]')?.textContent ?? ''), null, { timeout: 3000 });
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => /repeated failure/.test(document.querySelector('[data-testid="error-detail"]')?.textContent ?? ''), null, { timeout: 3000 });
  await tid('error-older').click();
  await page.waitForFunction(() => /older failure/.test(document.querySelector('[data-testid="error-detail"]')?.textContent ?? ''), null, { timeout: 3000 });
  expect(await disabledBtn('error-older'), 'Older is off at the oldest');
  await tid('error-newer').click();
  await tid('error-copy').click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip === 'Unexpected error\nrepeated failure', 'title and output copied: ' + clip.slice(0, 80));
  await page.keyboard.press('Escape');
  await waitGone('error-dialog');
  // Enter closes the error only: the dialog under it stays
  await tid('toolbar-fetch').click();
  await waitShown('fetch-dialog');
  await page.evaluate(() => setTimeout(() => { throw new Error('over a dialog'); }, 0));
  await waitShown('error-dialog');
  await page.keyboard.press('Enter');
  await waitGone('error-dialog');
  expect(await has('fetch-dialog'), 'the Fetch dialog stays (and did not fetch)');
  await page.keyboard.press('Escape');
  await waitGone('fetch-dialog');
  await tid('error-log-button').click();
  await tid('error-clear').click();
});

// ======================================================================================== connection
await step('toolbar · connection: system default, the SSH keys, no accounts; Save only after a change, Cancel keeps what was, Enter saves; Test reaches a local remote', async () => {
  const C = await syncRepo('tb-conn');
  await open('tb-conn');
  const info = async () => (await post('/api/repo/authInfo', { path: C.dir })).own;
  await pick('toolbar-more', 'Connection (SSH key / account)…');
  await waitShown('connection-dialog');
  await waitShown('conn-option-default');
  for (const k of ['ssh:e2e_work', 'ssh:e2e_personal']) expect(await has(`conn-option-${k}`), `${k} is offered`);
  expect(/No accounts/.test(await tid('connection-dialog').innerText()), 'no accounts: says where to add one');
  expect(await disabledBtn('conn-save'), 'nothing changed: Save is off');
  await tid('conn-option-ssh:e2e_work').click();
  expect(!(await disabledBtn('conn-save')), 'Save is on');
  await tid('conn-cancel').click();
  await waitGone('connection-dialog');
  expect((await info()) === null, 'Cancel saved nothing');
  await pick('toolbar-more', 'Connection (SSH key / account)…');
  await waitShown('conn-option-ssh:e2e_personal');
  await tid('conn-option-ssh:e2e_personal').click();
  await page.keyboard.press('Enter');
  await waitGone('connection-dialog');
  await until(async () => JSON.stringify(await info()) === JSON.stringify({ kind: 'ssh', key: 'e2e_personal' }), 'Enter saved the key');
  await statusHas(/tb-conn: SSH key e2e_personal/);
  // back to the default, and the test against the local remote
  await pick('toolbar-more', 'Connection (SSH key / account)…');
  await waitShown('conn-option-default');
  await tid('conn-option-default').click();
  await tid('conn-test').click();
  await waitShown('conn-test-result', 20000);
  expect(/Connected to origin/.test(await tid('conn-test-result').innerText()), 'reached');
  await tid('conn-save').click();
  await waitGone('connection-dialog');
  await until(async () => (await info()) === null, 'back to the default');
});

await step('toolbar · connection: a test the server refuses shows git’s words and Ask AI', async () => {
  const dir = await freshRepo('tb-conn-bad');
  git(dir, 'remote', 'add', 'origin', 'git@example.invalid:team/bad.git');
  git(dir, 'config', 'core.sshCommand', fakeSsh('conn', 'git@example.invalid: Permission denied (publickey).'));
  await open('tb-conn-bad');
  await pick('toolbar-more', 'Connection (SSH key / account)…');
  await waitShown('conn-option-default');
  await tid('conn-test').click();
  await waitShown('conn-test-result', 20000);
  const r = await tid('conn-test-result').innerText();
  expect(/Could not connect to origin/.test(r) && /Permission denied \(publickey\)/.test(r), 'refused, with git’s words: ' + r);
  expect(await has('conn-ask-ai'), 'Ask AI is offered');
  await page.keyboard.press('Escape');
});

// ======================================================================================== shortcuts
await step('toolbar · keys: ⌘⇧F, ⌘⇧L, ⌘⇧P open Fetch, Pull and Push; ⌘K the palette, ⌘/ the shortcuts, ⌘, the preferences, ⌘T the repository list', async () => {
  await syncRepo('tb-keys');
  await open('tb-keys');
  for (const [key, id] of [['Meta+Shift+f', 'fetch-dialog'], ['Meta+Shift+l', 'pull-dialog'], ['Meta+Shift+p', 'push-dialog']]) {
    await page.keyboard.press(key);
    await waitShown(id, 3000);
    await page.keyboard.press('Escape');
    await waitGone(id);
  }
  await page.keyboard.press('Meta+k');
  await page.locator('input[placeholder="type a command"]').waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+/');
  await waitShown('shortcut-row', 3000);
  await page.keyboard.press('Escape');
  await waitGone('shortcut-row');
  await page.keyboard.press('Meta+,');
  await waitShown('pref-auto-submodules', 3000);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+t');
  await waitShown('repo-picker', 3000);
  await page.keyboard.press('Escape');
  await waitGone('repo-picker');
});

await step('toolbar · keys: Escape closes a dropdown of a dialog first, then the dialog; ⌘W closes the tab', async () => {
  await page.getByText('All Commits', { exact: true }).first().click();
  await tid('toolbar-push').click();
  await waitShown('push-dialog');
  await tid('push-branch').click();
  await waitShown('push-branch-list');
  await page.keyboard.press('Escape');
  await waitGone('push-branch-list');
  expect(await has('push-dialog'), 'the dialog stays');
  await page.keyboard.press('Escape');
  await waitGone('push-dialog');
  expect(await has('tab-tb-keys'), 'the tab is open');
  await page.keyboard.press('Meta+w');
  await page.waitForFunction(() => !document.querySelector('[data-testid="tab-tb-keys"]'), null, { timeout: 3000 });
});

await step('toolbar · keys: the palette narrows as you type, the arrows keep the selection in view (its icon visible), Enter runs it, Escape closes', async () => {
  await open('tb-keys');
  await page.keyboard.press('Meta+k');
  const input = page.locator('input[placeholder="type a command"]');
  await input.waitFor({ timeout: 3000 });
  await page.keyboard.type('fetch');
  const shownLabels = await page.evaluate(() => [...document.querySelectorAll('[data-testid="palette-list"] [data-testid^="palette-item"]')].map((e) => e.innerText.split('\n')[0]));
  expect(shownLabels.length > 0 && shownLabels.every((l) => /fetch/i.test(l)), 'only Fetch commands: ' + shownLabels.join(' | '));
  expect(shownLabels.includes('Fetch…') && !shownLabels.includes('Pull…'), 'Fetch… yes, Pull… no');
  await input.fill('');
  for (let i = 0; i < 18; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const seen = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="palette-item-selected"]').getBoundingClientRect();
    const list = document.querySelector('[data-testid="palette-list"]').getBoundingClientRect();
    return row.top >= list.top - 1 && row.bottom <= list.bottom + 1;
  });
  expect(seen, 'the 19th command is scrolled into view');
  const icon = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="palette-item-selected"]');
    const svg = row.querySelector('svg');
    // the row's fill: the first background on the way up from the icon
    let e = svg;
    let bg = 'rgba(0, 0, 0, 0)';
    while (e && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
      bg = getComputedStyle(e).backgroundColor;
      e = e.parentElement;
    }
    const stroke = svg?.querySelector('[stroke]')?.getAttribute('stroke') ?? '';
    const hex = (h) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(h); return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : h; };
    return { bg, stroke: hex(stroke) };
  });
  expect(icon.stroke && icon.stroke !== icon.bg, `the selected row’s icon is not drawn in the row’s own colour: ${JSON.stringify(icon)}`);
  await shot('palette-scrolled');
  await input.fill('keyboard');
  await page.keyboard.press('Enter');
  await waitShown('shortcut-row', 3000);
  await page.keyboard.press('Escape');
  await waitGone('shortcut-row');
  // Pull… and Push… are named as the dialogs they open
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('pu');
  const pu = await page.evaluate(() => [...document.querySelectorAll('[data-testid="palette-list"] [data-testid^="palette-item"]')].map((e) => e.innerText.split('\n')[0]));
  expect(pu.includes('Pull…') && pu.includes('Push…'), 'Pull… and Push…: ' + pu.join(' | '));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('input[placeholder="type a command"]'), null, { timeout: 3000 });
});

await step('toolbar · keys: the shortcut list names them all (⌘Z, ⌘R, ⌘/, ⌃⌥T were missing)', async () => {
  await page.keyboard.press('Meta+/');
  await waitShown('shortcut-row', 3000);
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="shortcut-row"]')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  for (const want of ['⌘ Z', '⌘ R', '⌘ F', 'F7 / F8', '⌃ ⌥ T', '⌘ /', '⌘ ⇧ F', '⌘ ⇧ L', '⌘ ⇧ P', '⌘ K', '⌘ T', '⌘ W']) expect(rows.some((r) => r.endsWith(want)), `${want} is listed: ${rows.join(' | ')}`);
  await page.keyboard.press('Escape');
});

// ======================================================================================== the end
await step('toolbar: no errors in the page', async () => {
  // the errors made on purpose, and the engine's answers to the actions git refused here (an HTTP error each)
  const real = pageErrors.filter((e) => !/synthetic failure|repeated failure|older failure|over a dialog|status of [45]\d\d/.test(e));
  expect(real.length === 0, 'page errors: ' + real.slice(0, 5).join(' | '));
});

await step('toolbar · status: the engine stopping shows “engine offline”, and an action then says the engine did not answer', async () => {
  await open('tb-keys');
  const pid = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).toString().trim().split('\n')[0];
  expect(/^\d+$/.test(pid), 'the engine’s process: ' + pid);
  process.kill(Number(pid), 'SIGTERM');
  await page.waitForFunction(() => /engine offline/.test(document.querySelector('[data-testid="status-bar"]')?.textContent ?? ''), null, { timeout: 8000 });
  await shot('offline', { x: 700, y: 0, width: 740, height: 80 });
  await tid('toolbar-branch').click();
  await tid('branch-name').fill('while-offline');
  await tid('branch-create').click();
  await waitShown('error-dialog', 8000);
  expect(/git engine did not answer/.test(await tid('error-hint').innerText()), 'says the engine did not answer: ' + (await tid('error-hint').innerText()));
  await tid('error-close').click();
});

await finish('toolbar');
