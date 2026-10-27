/**
 * The sidebar, as a Fork user works it: Changes / All Commits, the branch filter box, every group (Versions,
 * Branches, Remotes, Tags, Submodules, Stashes) with its header buttons, the branch tree and its marks, clicks and
 * double clicks, every context menu (local, current and remote branch, folder, remote, tag, submodule, stash,
 * version) and the dialogs they open, multi-selection and the batch actions, funnels, the width splitter and
 * narrow widths.
 *
 * Each part works in repositories of its own (made here); check names start with the part ("sidebar · tree: …"),
 * so E2E_ONLY='sidebar · remotes' runs one part with its setup.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, base, page, check, expect, openRepo, until, git, root, tmp, freshRepo, finish, refreshUi, statusHas, undoLabel, pageErrors, post } from '../harness.mjs';

const SHOTS = path.join(ROOT, '..', 'shots');
mkdirSync(SHOTS, { recursive: true });
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `sidebar-${n}.png`) }).catch(() => {});
const tid = (id) => page.getByTestId(id);
const has = async (id) => (await tid(id).count()) > 0;
const waitGone = (id, ms = 6000) => page.waitForFunction((id) => !document.querySelector(`[data-testid="${CSS.escape(id)}"]`), id, { timeout: ms });
const waitShown = (id, ms = 6000) => tid(id).first().waitFor({ timeout: ms });
/** a branch's name in the Branches (or Remotes) group (the Versions group lists ver/ branches too) */
const br = (name) => page.locator(`[data-testid="group-branches"] [data-testid="branch-${name}"], [data-testid="group-remotes"] [data-testid="branch-${name}"]`).first();
/** the text of the row a branch name sits in (its marks: ↑↓, cloud, gone) */
const rowText = (name) => page.evaluate((n) => document.querySelector(`[data-testid="group-branches"] [data-testid="branch-${CSS.escape(n)}"]`)?.parentElement?.innerText ?? null, name);
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
/** the upstream of a branch, '' when it has none */
const upOf = (dir, b) => {
  try {
    return git(dir, 'rev-parse', '--abbrev-ref', `${b}@{upstream}`).trim();
  } catch {
    return '';
  }
};
const statusText = () => page.evaluate(() => document.querySelector('[data-testid="status-bar"]')?.textContent ?? '');
/** two clicks on one row within 450 ms are a double click (a checkout): the next click on it waits */
const settle = () => page.waitForTimeout(600);

/** a menu, dialog or error left open by a failed check is closed before the next one */
async function calm() {
  for (let i = 0; i < 4 && (await page.locator('[data-testid="context-menu"], [data-testid="modal"], [data-testid="modal-error"]').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}
const step = (name, fn) =>
  check(name, async () => {
    await calm();
    await fn();
  });

/** a dialog button by its testID is disabled */
const disabledBtn = (id) => page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-disabled') === 'true', id);
/** opens the context menu of `loc`; its items with their state */
async function menuOf(loc) {
  await loc.click({ button: 'right' });
  await tid('context-menu').waitFor({ timeout: 3000 });
  return page.evaluate(() =>
    // the label is the item's first text (a shortcut such as “Esc” may follow it)
    [...document.querySelectorAll('[data-testid="context-menu"] [data-testid="menu-item"]')].map((e) => ({ label: (e.firstElementChild?.firstElementChild ?? e).textContent.trim(), disabled: e.getAttribute('aria-disabled') === 'true' })),
  );
}
const find = (items, label) => items.find((i) => (label instanceof RegExp ? label.test(i.label) : i.label === label));
const labels = (items) => items.map((i) => `${i.label}${i.disabled ? ' (off)' : ''}`).join(' | ');
async function closeMenu() {
  await page.keyboard.press('Escape');
  await waitGone('context-menu');
}
/** right click on `loc`, then the menu item `label` (it must be there and enabled) */
async function menu(loc, label) {
  const items = await menuOf(loc);
  const it = find(items, label);
  if (!it || it.disabled) await closeMenu();
  expect(it, `the menu has “${label}”: ${labels(items)}`);
  expect(!it.disabled, `“${it.label}” is enabled`);
  await tid('context-menu').getByText(it.label, { exact: true }).click();
  await waitGone('context-menu');
}
/** the items of `loc`'s menu (closed again) */
async function itemsOf(loc) {
  const items = await menuOf(loc);
  await closeMenu();
  return items;
}
/** the confirmation dialog's button */
const confirmOk = () => tid('confirm-ok').click();
const confirmCancel = () => tid('confirm-cancel').click();
const waitDialog = (title) => page.getByText(title, { exact: true }).first().waitFor({ timeout: 5000 });
/**
 * After a reload the saved session brings the last tab back a moment later: wait for it, or a click on the start
 * screen is thrown back to that tab.
 */
async function settleReload() {
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
}
/** opens a repository from the start screen, once the session restore is done */
async function open(name) {
  await settleReload();
  await openRepo(name);
  await page.waitForFunction((n) => [...document.querySelectorAll('[data-testid^="tab-"]')].some((e) => e.textContent.includes(n)), name, { timeout: 8000 }).catch(() => {});
}
/** a bare repository standing in for a server */
function bare(name) {
  const dir = path.join(tmp, `origins/${name}.git`);
  mkdirSync(path.dirname(dir), { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'main', dir);
  return dir;
}
/** a second clone of `origin` (someone else pushing and deleting branches) */
function otherClone(origin, name) {
  const dir = path.join(tmp, `others/${name}`);
  mkdirSync(path.dirname(dir), { recursive: true });
  git(tmp, 'clone', '-q', origin, dir);
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}
/** the sidebar's elements that stick out of it (text cut off must stay inside) */
const overflowing = () =>
  page.evaluate(() => {
    const sb = document.querySelector('[data-testid="sidebar"]');
    const r = sb.getBoundingClientRect();
    const out = [];
    for (const e of sb.querySelectorAll('*')) {
      const b = e.getBoundingClientRect();
      if (b.width === 0 || b.height === 0 || b.bottom < r.top || b.top > r.bottom) continue;
      if (b.right > r.right + 1 && !e.querySelector('*')) out.push(`${(e.textContent || e.getAttribute('data-testid') || e.tagName).slice(0, 40)} (${Math.round(b.right - r.right)}px)`);
    }
    return out;
  });
/** the commit selected in the history */
const selectedSubject = () => page.evaluate(() => document.querySelector('[data-testid="selected-commit"]')?.innerText ?? '');
const waitSelected = (subject) => page.waitForFunction((s) => (document.querySelector('[data-testid="selected-commit"]')?.innerText ?? '').includes(s), subject, { timeout: 10000 });

const LONG = 'hs/tmp/a-very-long-branch-name-that-has-to-be-cut-off-inside-the-sidebar';

/**
 * A repository like the user's: branches in nested folders, release branches ver/XXX, a remote with some of them,
 * one ahead and one behind its upstream, one whose upstream was deleted on the server, a remote-only branch, a
 * lightweight and an annotated tag, two stashes, and local changes (a file staged and edited again, a new file).
 */
async function richRepo(name) {
  const dir = await freshRepo(name, { 'README.md': `# ${name}\n`, 'a.txt': 'a\n' });
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', 'b.txt');
  git(dir, 'commit', '-q', '-m', 'Second commit');
  const origin = bare(name);
  git(dir, 'remote', 'add', 'origin', origin);
  for (const b of ['feature/x', 'games/wordfall/main', 'games/wordfall/dev', 'hs/tmp/alpha', 'hs/tmp/beta', LONG, 'ver/925', 'ver/926-hotfix', 'ver/1001', 'gone/one', 'remote-only/topic'])
    git(dir, 'branch', b);
  git(dir, 'push', '-q', '-u', 'origin', 'main', 'feature/x', 'games/wordfall/main', 'ver/925', 'gone/one', 'remote-only/topic');
  git(dir, 'branch', '-D', 'remote-only/topic');
  git(dir, 'push', '-q', 'origin', '--delete', 'gone/one');
  git(dir, 'fetch', '-q', '--prune', 'origin');
  git(dir, 'checkout', '-q', 'feature/x');
  writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  git(dir, 'add', 'x.txt');
  git(dir, 'commit', '-q', '-m', 'Feature x work');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', '-f', 'games/wordfall/main', 'main~1');
  git(dir, 'tag', 'v1', 'main~1');
  git(dir, 'tag', '-a', 'v2', '-m', 'Release two', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'a\nstash one\n');
  git(dir, 'stash', 'push', '-q', '-m', 'first stash');
  writeFileSync(path.join(dir, 'a.txt'), 'a\nstash two\n');
  git(dir, 'stash', 'push', '-q', '-m', 'second stash');
  writeFileSync(path.join(dir, 'a.txt'), 'a\nstaged\n');
  git(dir, 'add', 'a.txt');
  writeFileSync(path.join(dir, 'a.txt'), 'a\nstaged\nunstaged\n');
  writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  return { dir, origin };
}

// ======================================================================================== tree
let R;

await step('sidebar · tree: Changes counts the changed files (one staged and edited again counts once) and opens Changes; All Commits opens the history', async () => {
  R = await richRepo('side-rich');
  await open('side-rich');
  await tid('sidebar-changes').click();
  await waitShown('commit-box');
  const n = (await tid('sidebar-changes-count').innerText()).trim();
  expect(n === '2', `a.txt (staged and edited again) and new.txt are two changed files; the badge says ${n}`);
  await tid('sidebar-commits').click();
  await waitShown('commit-scroll');
  await waitGone('commit-box');
  await tid('sidebar-changes').click();
  await waitShown('commit-box');
  await tid('sidebar-commits').click();
  await waitShown('commit-scroll');
  // their keys: ⌘1 Changes, ⌘2 All Commits
  await page.keyboard.press('Meta+1');
  await waitShown('commit-box');
  await page.keyboard.press('Meta+2');
  await waitShown('commit-scroll');
});

await step('sidebar · tree: every group folds and unfolds from its header; Versions, Tags, Submodules and Stashes count what they list', async () => {
  // as they start: Versions, Branches and Submodules open; Remotes, Tags and Stashes folded
  const marker = { versions: 'version-925', branches: 'folder-branch:feature', remotes: 'remote-origin', tags: 'tag-v1', stashes: 'stash-0' };
  const start = { versions: true, branches: true, remotes: false, tags: false, stashes: false };
  for (const [g, m] of Object.entries(marker)) {
    expect((await has(m)) === start[g], `${g} starts ${start[g] ? 'open' : 'folded'}`);
    await tid(`group-header-${g}`).click();
    if (start[g]) await waitGone(m);
    else await waitShown(m);
    await tid(`group-header-${g}`).click();
    if (start[g]) await waitShown(m);
    else await waitGone(m);
  }
  expect(await page.getByTestId('group-submodules').getByText('No submodules', { exact: true }).count(), 'Submodules says it has none');
  await tid('group-header-submodules').click();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="group-submodules"]')?.textContent ?? '').includes('No submodules'), null, { timeout: 3000 });
  await tid('group-header-submodules').click();
  // the rest of this suite works with every group open
  for (const g of ['remotes', 'tags', 'stashes']) await tid(`group-header-${g}`).click();
  for (const m of Object.values(marker)) await waitShown(m);
  const count = async (g) => (await tid(`group-count-${g}`).innerText()).trim();
  expect((await count('versions')) === '3', 'three versions: ' + (await count('versions')));
  expect((await count('tags')) === '2', 'two tags: ' + (await count('tags')));
  expect((await count('stashes')) === '2', 'two stashes: ' + (await count('stashes')));
  expect((await count('submodules')) === '0', 'no submodules: ' + (await count('submodules')));
  const stashes = await tid('group-stashes').innerText();
  expect(/second stash[\s\S]*\{0\}[\s\S]*first stash[\s\S]*\{1\}/.test(stashes), 'the newest stash first, with its index: ' + stashes);
});

await step('sidebar · tree: the buttons of a group header stay lit while the pointer is on them', async () => {
  // the whole chain of opacities from the button up to its header row
  const opacityOf = (g, label) =>
    page.evaluate(
      ([g, label]) => {
        const row = document.querySelector(`[data-testid="group-header-${g}"]`);
        let e = row?.querySelector(`[aria-label="${label}"]`);
        let o = 1;
        while (e && e !== row) {
          o *= Number(getComputedStyle(e).opacity);
          e = e.parentElement;
        }
        return o;
      },
      [g, label],
    );
  for (const [g, label] of [
    ['branches', 'New branch'],
    ['remotes', 'Connection: SSH key or account'],
    ['remotes', 'Add remote'],
    ['remotes', 'Fetch all'],
    ['tags', 'New tag'],
    ['stashes', 'Stash changes'],
    ['submodules', 'Update all (init + checkout to index)'],
    ['submodules', 'Sync URLs from .gitmodules'],
  ]) {
    await page.mouse.move(700, 890);
    await page.waitForTimeout(80);
    expect((await opacityOf(g, label)) < 0.6, `${label}: faint while the header is not hovered (${await opacityOf(g, label)})`);
    await tid(`group-header-${g}`).hover({ position: { x: 40, y: 12 } });
    await page.waitForTimeout(80);
    expect((await opacityOf(g, label)) > 0.99, `${label}: lit while the header is hovered`);
    await tid(`group-header-${g}`).locator(`[aria-label="${label}"]`).hover();
    await page.waitForTimeout(120);
    expect((await opacityOf(g, label)) > 0.99, `${label}: stays lit with the pointer on it (${await opacityOf(g, label)})`);
    // and back from the button onto the header
    await tid(`group-header-${g}`).hover({ position: { x: 40, y: 12 } });
    await page.waitForTimeout(120);
    expect((await opacityOf(g, label)) > 0.99, `${label}: lit again with the pointer back on the header (${await opacityOf(g, label)})`);
  }
  await page.mouse.move(700, 890);
});

await step('sidebar · tree: branch folders open and close and keep the state of the folders inside; a long name is cut off inside the sidebar', async () => {
  await waitShown('branch-games/wordfall/dev');
  await tid('folder-branch:games/wordfall').click();
  await waitGone('branch-games/wordfall/dev');
  expect(await has('folder-branch:games/wordfall'), 'the folder row stays');
  await tid('folder-branch:games').click();
  await waitGone('folder-branch:games/wordfall');
  await tid('folder-branch:games').click();
  await waitShown('folder-branch:games/wordfall');
  expect(!(await has('branch-games/wordfall/dev')), 'the inner folder stays closed as it was left');
  await tid('folder-branch:games/wordfall').click();
  await waitShown('branch-games/wordfall/dev');
  // the long one: shown under hs/tmp, cut off with an ellipsis, nothing sticks out of the sidebar
  const long = await page.evaluate((n) => {
    const e = document.querySelector(`[data-testid="group-branches"] [data-testid="branch-${n}"]`);
    return e ? { cut: e.scrollWidth > e.clientWidth, text: e.textContent } : null;
  }, LONG);
  expect(long && long.cut && long.text === LONG.split('/').pop(), 'the long name is its last part, cut off: ' + JSON.stringify(long));
  const out = await overflowing();
  expect(out.length === 0, 'nothing sticks out of the sidebar: ' + out.join(', '));
});

await step('sidebar · tree: Create branch here… on a branch, a remote branch and a tag starts the new branch at it', async () => {
  for (const [loc, from, made, at] of [
    [() => br('feature/x'), 'feature/x', 'made/from-local', 'feature/x'],
    [() => br('origin/feature/x'), 'origin/feature/x', 'made/from-remote', 'origin/feature/x'],
    [() => tid('tag-v1'), 'v1', 'made/from-tag', 'v1^{commit}'],
  ]) {
    await menu(loc(), 'Create branch here…');
    await page.getByPlaceholder('feature/…').waitFor({ timeout: 5000 });
    expect((await tid('branch-from').innerText()).includes(`(${from})`), `the dialog says it starts at ${from}: ` + (await tid('branch-from').innerText()));
    // not checked out: the working copy keeps its changes where they are
    await page.getByText('Checkout new branch', { exact: true }).click();
    await page.getByPlaceholder('feature/…').fill(made);
    await page.getByPlaceholder('feature/…').press('Enter');
    await until(() => refExists(R.dir, `refs/heads/${made}`), `${made} created`);
    expect(shaOf(R.dir, made) === shaOf(R.dir, at), `${made} starts at ${at}`);
    expect(headOf(R.dir) === 'main', 'still on main');
  }
  git(R.dir, 'branch', '-D', 'made/from-local', 'made/from-remote', 'made/from-tag');
  await refreshUi();
  await waitGone('folder-branch:made');
});

await step('sidebar · tree: the current branch is marked; ↑ ahead and ↓ behind; a cloud on published branches; a gone upstream says so', async () => {
  const cur = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="group-branches"] [data-testid="branch-main"]');
    const other = document.querySelector('[data-testid="group-branches"] [data-testid="branch-hs/tmp/alpha"]');
    return { family: getComputedStyle(e).fontFamily, color: getComputedStyle(e).color, otherColor: getComputedStyle(other).color };
  });
  expect(/SemiBold|Bold/.test(cur.family) && cur.color !== cur.otherColor, 'main is bold and in the accent colour: ' + JSON.stringify(cur));
  expect((await rowText('feature/x')).includes('↑1'), 'feature/x is one ahead: ' + (await rowText('feature/x')));
  expect((await rowText('games/wordfall/main')).includes('↓1'), 'games/wordfall/main is one behind: ' + (await rowText('games/wordfall/main')));
  expect(await has('branch-cloud-feature/x'), 'a cloud on feature/x (on origin)');
  expect(await has('branch-cloud-main'), 'a cloud on main');
  expect(!(await has('branch-cloud-hs/tmp/alpha')), 'no cloud on a branch that was never pushed');
  expect(!(await has('branch-cloud-gone/one')), 'no cloud on a branch whose upstream is gone');
  expect(await has('branch-gone-gone/one'), 'the branch whose upstream was deleted on the server says so: ' + (await rowText('gone/one')));
});

await step('sidebar · tree: remote branches sit in folders under their remote; a remote row folds; two remotes keep their folders apart', async () => {
  git(R.dir, 'remote', 'add', 'fork', R.origin);
  git(R.dir, 'fetch', '-q', 'fork');
  await refreshUi();
  await waitShown('remote-fork');
  const rmText = await tid('remote-origin').innerText();
  expect(rmText.includes('origin') && rmText.includes('side-rich'), 'the remote row: name and a short URL: ' + rmText);
  for (const n of ['origin/feature/x', 'origin/remote-only/topic', 'origin/games/wordfall/main', 'fork/feature/x']) await waitShown(`branch-${n}`);
  expect((await tid('branch-origin/feature/x').innerText()) === 'x', 'the leaf shows its last part');
  // folding origin's "feature" folder leaves fork's alone
  const originBlock = tid('remote-origin').locator('xpath=..');
  await originBlock.getByText('feature', { exact: true }).click();
  await waitGone('branch-origin/feature/x');
  expect(await has('branch-fork/feature/x'), 'fork/feature/x still shown: the two “feature” folders are not one');
  await originBlock.getByText('feature', { exact: true }).click();
  await waitShown('branch-origin/feature/x');
  // the remote row folds its branches
  await tid('remote-fork').click();
  await waitGone('branch-fork/feature/x');
  expect(await has('branch-origin/feature/x'), 'origin stays open');
  await tid('remote-fork').click();
  await waitShown('branch-fork/feature/x');
});

await step('sidebar · tree: the filter narrows branches, remotes and tags, opens what it finds, says when nothing matches; Escape or clearing it brings the tree back', async () => {
  const f = tid('sidebar-filter');
  await tid('folder-branch:hs').click();
  await waitGone('branch-hs/tmp/alpha');
  await f.fill('alpha');
  await waitShown('branch-hs/tmp/alpha');
  expect(!(await has('branch-feature/x')), 'other branches hidden');
  for (const g of ['versions', 'tags', 'remotes']) expect(!(await has(`group-${g}`)), `${g} has nothing that matches: hidden`);
  expect((await tid('group-count-branches').innerText()).trim() === '1', 'Branches counts the one match');
  await f.fill('WORDFALL');
  await waitShown('branch-games/wordfall/dev');
  await waitShown('branch-origin/games/wordfall/main');
  expect((await tid('group-count-branches').innerText()).trim() === '2', 'case does not matter: two branches');
  await f.fill('v2');
  await waitShown('tag-v2');
  expect(!(await has('tag-v1')) && !(await has('group-branches')), 'only the tag v2');
  await f.fill('925');
  await waitShown('version-925');
  await f.fill('nothing-like-this');
  await page.getByText('Nothing matches “nothing-like-this”', { exact: true }).waitFor({ timeout: 3000 });
  await f.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-testid="sidebar-filter"]')?.value === '', null, { timeout: 3000 });
  await f.fill('');
  await waitShown('folder-branch:hs');
  expect(!(await has('branch-hs/tmp/alpha')), 'hs is folded again, as before the filter');
  await waitShown('tag-v1');
  await tid('folder-branch:hs').click();
  await waitShown('branch-hs/tmp/alpha');
});

await step('sidebar · tree: while filtering, a click on a group, a remote or a folder still folds it; the tree is as it was once the filter is cleared', async () => {
  const f = tid('sidebar-filter');
  try {
    await f.fill('wordfall');
    await waitShown('branch-origin/games/wordfall/main');
    await tid('group-header-remotes').click();
    await waitGone('branch-origin/games/wordfall/main');
    await tid('group-header-remotes').click();
    await waitShown('branch-origin/games/wordfall/main');
    await tid('remote-origin').click();
    await waitGone('branch-origin/games/wordfall/main');
    await tid('folder-branch:games/wordfall').click();
    await waitGone('branch-games/wordfall/dev');
  } finally {
    await f.fill('');
  }
  // as before the filter: Remotes, origin and the folders open
  await waitShown('branch-games/wordfall/dev');
  await waitShown('branch-origin/feature/x');
  await waitShown('remote-origin');
});

await step('sidebar · tree: a click on a branch selects its commit; on a tag (an annotated one too) the tagged commit', async () => {
  await br('feature/x').click();
  await waitSelected('Feature x work');
  await tid('tag-v1').click();
  await waitSelected('Initial commit');
  await tid('tag-v2').click();
  await waitSelected('Second commit');
  await br('origin/feature/x').click();
  await waitSelected('Second commit');
  expect(headOf(R.dir) === 'main', 'single clicks check nothing out');
});

await step('sidebar · tree: a double click checks a branch out; on the current branch it does nothing; on a remote branch in a folder it makes the tracking branch', async () => {
  await settle();
  await br('hs/tmp/alpha').dblclick();
  await until(() => headOf(R.dir) === 'hs/tmp/alpha', 'on hs/tmp/alpha: ' + headOf(R.dir));
  await statusHas(/Checked out hs\/tmp\/alpha/);
  await page.waitForFunction(() => /SemiBold|Bold/.test(getComputedStyle(document.querySelector('[data-testid="group-branches"] [data-testid="branch-hs/tmp/alpha"]')).fontFamily), null, {
    timeout: 5000,
  });
  await settle();
  await br('hs/tmp/alpha').dblclick();
  await page.waitForTimeout(800);
  expect(headOf(R.dir) === 'hs/tmp/alpha' && !(await has('error-dialog')), 'nothing happens on the current branch');
  await settle();
  await br('origin/remote-only/topic').dblclick();
  await until(() => headOf(R.dir) === 'remote-only/topic', 'on remote-only/topic: ' + headOf(R.dir));
  expect(git(R.dir, 'rev-parse', '--abbrev-ref', 'remote-only/topic@{upstream}').trim() === 'origin/remote-only/topic', 'it tracks origin/remote-only/topic');
  await waitShown('branch-remote-only/topic');
  await settle();
  await br('main').dblclick();
  await until(() => headOf(R.dir) === 'main', 'back on main');
});

await step('sidebar · tree: what was folded and unfolded comes back after a reload (the next launch)', async () => {
  // as left by the checks above: Remotes, Tags and Stashes unfolded; now hs and fork folded too
  await tid('folder-branch:hs').click();
  await waitGone('folder-branch:hs/tmp');
  await tid('remote-fork').click();
  await waitGone('branch-fork/feature/x');
  await page.waitForTimeout(900); // saved half a second after a change
  await page.reload({ waitUntil: 'load' });
  await settleReload();
  await waitShown('remote-origin');
  for (const m of ['tag-v1', 'stash-0', 'branch-origin/feature/x', 'branch-games/wordfall/dev']) expect(await has(m), `${m} shown as it was`);
  expect(!(await has('folder-branch:hs/tmp')), 'hs is still folded');
  expect(!(await has('branch-fork/feature/x')), 'fork is still folded');
  await tid('folder-branch:hs').click();
  await tid('remote-fork').click();
  await waitShown('branch-fork/feature/x');
});

// ================================================================================= branch menu
let O;
/** branches to act on: one to merge, one to rebase onto, published and unpublished ones, a remote-only one */
async function opsRepo(name) {
  const dir = await freshRepo(name, { 'README.md': `# ${name}\n`, 'base.txt': 'base\n' });
  writeFileSync(path.join(dir, 'main.txt'), 'main two\n');
  git(dir, 'add', 'main.txt');
  git(dir, 'commit', '-q', '-m', 'Main two');
  const origin = bare(name);
  git(dir, 'remote', 'add', 'origin', origin);
  for (const [b, file, subject] of [
    ['topic', 't.txt', 'Topic work'],
    ['base2', 'r.txt', 'Base two work'],
  ]) {
    git(dir, 'checkout', '-q', '-b', b, 'main~1');
    writeFileSync(path.join(dir, file), `${b}\n`);
    git(dir, 'add', file);
    git(dir, 'commit', '-q', '-m', subject);
  }
  git(dir, 'checkout', '-q', 'main');
  for (const b of ['pub', 'unpub', 'old-name', 'Case-Me', 'del-me', 'del-both', 'del-local', 'rb']) git(dir, 'branch', b);
  git(dir, 'push', '-q', '-u', 'origin', 'main', 'pub', 'del-me', 'del-both', 'rb');
  git(dir, 'branch', '-D', 'rb');
  git(dir, 'checkout', '-q', 'pub');
  writeFileSync(path.join(dir, 'pub.txt'), 'pub\n');
  git(dir, 'add', 'pub.txt');
  git(dir, 'commit', '-q', '-m', 'Pub work');
  git(dir, 'checkout', '-q', 'main');
  return { dir, origin, main: shaOf(dir, 'main') };
}
/** main back where it started (after a merge or a rebase), the page told */
async function resetMain() {
  git(O.dir, 'checkout', '-q', 'main');
  git(O.dir, 'reset', '-q', '--hard', O.main);
  await refreshUi();
}

await step('sidebar · branch menu: a local branch offers Checkout, Merge, Rebase, Push, Pull, Set upstream, Rename, Copy, Delete and the filter, named for it', async () => {
  O = await opsRepo('side-ops');
  await open('side-ops');
  await page.getByText('All Commits', { exact: true }).first().click();
  await tid('group-header-remotes').click();
  await waitShown('branch-origin/rb');
  let items = await itemsOf(br('unpub'));
  for (const l of ['Checkout unpub', 'Merge unpub into main', 'Rebase main onto unpub', 'Push…', 'Set upstream…', 'Create branch here…', 'Rename…', 'Copy branch name', 'Delete', 'Show only this branch']) {
    const it = find(items, l);
    expect(it && !it.disabled, `“${l}” offered and enabled: ${labels(items)}`);
  }
  expect(find(items, 'Pull (check it out first)')?.disabled, 'Pull is off for a branch that is not checked out: ' + labels(items));
  expect(find(items, /^Delete \(local \+ remote\)/)?.disabled, 'a branch on no remote: “Delete (local + remote)” is off: ' + labels(items));
  expect(!find(items, 'Clear the branch filter') && !find(items, /to the filter|from the filter/), 'no filter items while nothing is filtered');
  items = await itemsOf(br('pub'));
  expect(find(items, 'Push to origin/pub') && !find(items, 'Push to origin/pub').disabled, 'a published branch pushes to its upstream: ' + labels(items));
  expect(find(items, 'Delete (local + origin/pub)') && !find(items, 'Delete (local + origin/pub)').disabled, 'and names the remote branch it deletes too: ' + labels(items));
});

await step('sidebar · branch menu: on the current branch Checkout, Merge, Rebase and Delete are off; Pull… opens the Pull dialog', async () => {
  const items = await itemsOf(br('main'));
  for (const l of ['Already checked out', 'Merge main into main', 'Rebase main onto main', 'Delete']) expect(find(items, l)?.disabled, `“${l}” is off: ${labels(items)}`);
  expect(find(items, /^Delete \(local \+/)?.disabled, 'delete with the remote is off too');
  await menu(br('main'), 'Pull…');
  await waitShown('pull-dialog');
  await page.keyboard.press('Escape');
  await waitGone('pull-dialog');
});

await step('sidebar · branch menu: Checkout switches to the branch, the sidebar marks it', async () => {
  await menu(br('unpub'), 'Checkout unpub');
  await until(() => headOf(O.dir) === 'unpub', 'on unpub: ' + headOf(O.dir));
  await page.waitForFunction(() => /SemiBold|Bold/.test(getComputedStyle(document.querySelector('[data-testid="group-branches"] [data-testid="branch-unpub"]')).fontFamily), null, { timeout: 5000 });
  await menu(br('main'), 'Checkout main');
  await until(() => headOf(O.dir) === 'main', 'back on main');
});

await step('sidebar · branch menu: Merge X into the current branch opens the dialog with X picked, and merges it', async () => {
  try {
    await menu(br('topic'), 'Merge topic into main');
    await waitShown('merge-dialog');
    expect(await has('branch-pick-topic-selected'), 'topic is picked in the dialog');
    await page.getByText('Merge into main', { exact: true }).click();
    await until(() => git(O.dir, 'log', '--format=%s', 'main').includes('Topic work'), 'topic merged into main');
    await waitGone('merge-dialog');
  } finally {
    await resetMain();
  }
});

await step('sidebar · branch menu: Rebase the current branch onto X opens the dialog with X picked, and rebases', async () => {
  try {
    await menu(br('base2'), 'Rebase main onto base2');
    await page.getByText('1 commit will be replayed on top of base2', { exact: true }).waitFor({ timeout: 5000 });
    await page.getByText('Rebase', { exact: true }).last().click();
    await until(() => {
      try {
        git(O.dir, 'merge-base', '--is-ancestor', 'base2', 'main');
        return true;
      } catch {
        return false;
      }
    }, 'main sits on base2 now');
    expect(git(O.dir, 'log', '--format=%s', '-1', 'main').trim() === 'Main two', 'its commit replayed on top');
  } finally {
    await resetMain();
  }
});

await step('sidebar · branch menu: Push on a branch that is not checked out sends it to its upstream; Push… on an unpublished one opens the dialog with it', async () => {
  const lsRemote = () => git(O.dir, 'ls-remote', 'origin', 'refs/heads/pub').split('\t')[0];
  expect(lsRemote() !== shaOf(O.dir, 'pub'), 'origin/pub is behind before');
  await menu(br('pub'), 'Push to origin/pub');
  await until(() => lsRemote() === shaOf(O.dir, 'pub'), 'origin has pub’s commit');
  expect(headOf(O.dir) === 'main', 'still on main');
  await page.waitForFunction(() => !(document.querySelector('[data-testid="group-branches"] [data-testid="branch-pub"]')?.parentElement?.innerText ?? '↑').includes('↑'), null, { timeout: 10000 });
  await menu(br('unpub'), 'Push…');
  await waitShown('push-dialog');
  expect((await tid('push-branch').innerText()).includes('unpub'), 'the dialog pushes unpub: ' + (await tid('push-branch').innerText()));
  expect((await tid('push-remote-branch').inputValue()) === 'unpub', 'to the same name on origin');
  await page.keyboard.press('Escape');
  await waitGone('push-dialog');
});

await step('sidebar · branch menu: Set upstream… lists the remote branches, nothing picked when the same name is not on the remote; the pick is tracked and the cloud shows', async () => {
  await menu(br('pub'), 'Set upstream…');
  await waitShown('upstream-dialog');
  expect(await has('branch-pick-origin/pub-selected'), 'a tracked branch: its upstream is picked');
  expect(!(await has('branch-pick-pub')) && !(await has('branch-pick-main')), 'only remote branches are offered');
  await page.keyboard.press('Escape');
  await waitGone('upstream-dialog');
  await menu(br('unpub'), 'Set upstream…');
  await waitShown('upstream-dialog');
  expect(await disabledBtn('upstream-go'), 'origin/unpub does not exist: nothing to set yet');
  await tid('branch-pick-origin/rb').click();
  await tid('upstream-go').click();
  await until(() => upOf(O.dir, 'unpub') === 'origin/rb', 'unpub tracks origin/rb');
  await waitShown('branch-cloud-unpub');
  // Enter sets it too
  await menu(br('unpub'), 'Set upstream…');
  await tid('branch-pick-origin/main').click();
  await page.keyboard.press('Enter');
  await until(() => upOf(O.dir, 'unpub') === 'origin/main', 'unpub tracks origin/main');
  await waitGone('upstream-dialog');
});

await step('sidebar · branch menu: Rename… refuses the same name, a taken one and a bad one, saying why; Enter renames; a change of case alone works; Undo renames back', async () => {
  await menu(br('old-name'), 'Rename…');
  const input = tid('rename-input');
  await input.waitFor({ timeout: 5000 });
  expect((await input.inputValue()) === 'old-name' && (await disabledBtn('rename-go')), 'starts with the name, nothing to rename yet');
  for (const [v, why] of [
    ['pub', /already exists/],
    ['bad name', /not a valid/i],
    ['trailing/', /not a valid/i],
    ['a..b', /not a valid/i],
  ]) {
    await input.fill(v);
    expect(await disabledBtn('rename-go'), `“${v}” refused`);
    expect(why.test(await tid('rename-note').innerText()), `and says why: ${await tid('rename-note').innerText()}`);
  }
  await input.fill('new-name');
  await input.press('Enter');
  await until(() => refExists(O.dir, 'refs/heads/new-name') && !refExists(O.dir, 'refs/heads/old-name'), 'renamed to new-name');
  await waitShown('branch-new-name');
  await statusHas(/Renamed old-name → new-name/);
  await tid('undo-button').click();
  await until(() => refExists(O.dir, 'refs/heads/old-name') && !refExists(O.dir, 'refs/heads/new-name'), 'Undo renamed it back');
  await waitShown('branch-old-name');
  await menu(br('Case-Me'), 'Rename…');
  await tid('rename-input').fill('case-me');
  expect(!(await disabledBtn('rename-go')), 'a change of case is a rename');
  await tid('rename-go').click();
  await until(() => git(O.dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').includes('case-me'), 'now case-me: ' + git(O.dir, 'branch'));
  expect(!git(O.dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').includes('Case-Me'), 'Case-Me is gone');
  await waitShown('branch-case-me');
});

await step('sidebar · branch menu: Copy branch name puts it on the clipboard and says so', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await menu(br('unpub'), 'Copy branch name');
  await statusHas(/Copied.*unpub/);
  expect((await page.evaluate(() => navigator.clipboard.readText())) === 'unpub', 'on the clipboard');
});

await step('sidebar · branch menu: Delete asks first; Cancel keeps it; Delete removes it; Undo brings it back with its upstream', async () => {
  await menu(br('del-me'), 'Delete');
  expect((await tid('confirm-message').innerText()).length > 0, 'a question');
  await confirmCancel();
  await waitGone('confirm-ok');
  expect(refExists(O.dir, 'refs/heads/del-me'), 'Cancel keeps it');
  await menu(br('del-me'), 'Delete');
  await confirmOk();
  await until(() => !refExists(O.dir, 'refs/heads/del-me'), 'deleted');
  await page.waitForFunction(() => !document.querySelector('[data-testid="group-branches"] [data-testid="branch-del-me"]'), null, { timeout: 5000 });
  expect(git(O.dir, 'ls-remote', 'origin', 'refs/heads/del-me').trim(), 'the remote one stays');
  await tid('undo-button').click();
  await until(() => refExists(O.dir, 'refs/heads/del-me'), 'Undo brought it back');
  expect(upOf(O.dir, 'del-me') === 'origin/del-me', 'with its upstream');
  await waitShown('branch-cloud-del-me');
});

await step('sidebar · branch menu: Delete (local + remote) removes the branch here and on the server, and says which', async () => {
  await menu(br('del-both'), 'Delete (local + origin/del-both)');
  expect((await tid('confirm-message').innerText()).includes('origin/del-both'), 'the question names the remote branch: ' + (await tid('confirm-message').innerText()));
  await confirmOk();
  await until(() => !refExists(O.dir, 'refs/heads/del-both') && !git(O.dir, 'ls-remote', 'origin', 'refs/heads/del-both').trim(), 'gone here and on origin');
  await page.waitForFunction(() => !document.querySelector('[data-testid="branch-origin/del-both"]') && !document.querySelector('[data-testid="group-branches"] [data-testid="branch-del-both"]'), null, { timeout: 5000 });
});

await step('sidebar · branch menu: a remote branch offers Checkout (a tracking branch), Merge, Rebase, Copy and Delete on the remote, named for it', async () => {
  // the label names the branch a checkout switches to
  let items = await itemsOf(br('origin/main'));
  expect(find(items, 'Already on main')?.disabled, 'origin/main: main tracks it and is checked out: ' + labels(items));
  items = await itemsOf(br('origin/pub'));
  expect(find(items, 'Checkout pub'), 'origin/pub: its local branch pub: ' + labels(items));
  git(O.dir, 'branch', 'tracker', 'main');
  git(O.dir, 'branch', '--set-upstream-to=origin/pub', 'tracker');
  git(O.dir, 'branch', '--unset-upstream', 'pub');
  await refreshUi();
  items = await itemsOf(br('origin/pub'));
  expect(find(items, 'Checkout tracker (tracks origin/pub)'), 'a local branch of another name tracks it: that one: ' + labels(items));
  items = await itemsOf(br('origin/rb'));
  for (const l of ['Checkout rb', 'Merge origin/rb into main', 'Rebase main onto origin/rb', 'Create branch here…', 'Copy branch name', 'Delete remote branch', 'Show only this branch']) expect(find(items, l) && !find(items, l).disabled, `“${l}”: ${labels(items)}`);
  await menu(br('origin/rb'), 'Merge origin/rb into main');
  await waitShown('merge-dialog');
  expect(await has('branch-pick-origin/rb-selected'), 'origin/rb picked in the Merge dialog');
  await page.keyboard.press('Escape');
  await waitGone('merge-dialog');
  await menu(br('origin/rb'), 'Rebase main onto origin/rb');
  await page.getByText('Rebase main onto', { exact: false }).first().waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await menu(br('origin/rb'), 'Checkout rb');
  await until(() => headOf(O.dir) === 'rb', 'on rb');
  expect(upOf(O.dir, 'rb') === 'origin/rb', 'tracking origin/rb');
  await menu(br('main'), 'Checkout main');
  await until(() => headOf(O.dir) === 'main', 'back on main');
});

await step('sidebar · branch menu: the filter items of a branch: Show only, Remove from / Add to the filter, Clear', async () => {
  await menu(br('origin/rb'), 'Show only this branch');
  await waitShown('filter-chip-origin/rb');
  const items = await itemsOf(br('origin/rb'));
  expect(find(items, 'Remove from the filter') && find(items, 'Clear the branch filter'), 'a filtered branch: ' + labels(items));
  await menu(br('topic'), 'Add to the filter');
  await waitShown('filter-chip-topic');
  expect(await has('filter-chip-origin/rb'), 'both in the filter');
  await menu(br('origin/rb'), 'Remove from the filter');
  await waitGone('filter-chip-origin/rb');
  await menu(br('topic'), 'Clear the branch filter');
  await waitGone('branch-filter-bar');
});

// ===================================================================================== remotes
let M;
/** a repository with an origin, and another clone of that origin where someone else pushes and deletes */
async function remoteRepo(name) {
  const dir = await freshRepo(name, { 'README.md': `# ${name}\n` });
  const origin = bare(name);
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'branch', 'to-prune');
  git(dir, 'push', '-q', '-u', 'origin', 'main', 'to-prune');
  return { dir, origin, other: otherClone(origin, name) };
}
const remotesOf = (dir) => git(dir, 'remote').split('\n').filter(Boolean);
const lsRemote = (dir, remote, ref) => git(dir, 'ls-remote', remote, ref).trim();

await step('sidebar · remotes: the menu of a remote: Prune drops a branch deleted on the server, Fetch brings one pushed there; the narrow and shallow items are off and say why', async () => {
  M = await remoteRepo('side-remote');
  await open('side-remote');
  await tid('group-header-remotes').click();
  await waitShown('branch-origin/to-prune');
  // someone else pushes a branch and deletes one
  git(M.other, 'checkout', '-q', '-b', 'from-other');
  writeFileSync(path.join(M.other, 'o.txt'), 'o\n');
  git(M.other, 'add', 'o.txt');
  git(M.other, 'commit', '-q', '-m', 'From the other clone');
  git(M.other, 'push', '-q', 'origin', 'from-other');
  git(M.other, 'push', '-q', 'origin', '--delete', 'to-prune');
  const items = await itemsOf(tid('remote-origin'));
  for (const l of ['Fetch origin', 'Prune', 'Edit remote…', 'Connection (SSH key / account)…', 'Copy URL', 'Remove remote']) expect(find(items, l) && !find(items, l).disabled, `“${l}”: ${labels(items)}`);
  expect(find(items, 'Fetch every branch — already followed')?.disabled, 'every branch is followed already: ' + labels(items));
  expect(find(items, 'Fetch the full history — the history is already complete')?.disabled, 'not shallow: ' + labels(items));
  await menu(tid('remote-origin'), 'Prune');
  await until(() => !refExists(M.dir, 'refs/remotes/origin/to-prune'), 'origin/to-prune pruned');
  await waitGone('branch-origin/to-prune');
  expect(!refExists(M.dir, 'refs/remotes/origin/from-other'), 'Prune does not fetch');
  await menu(tid('remote-origin'), 'Fetch origin');
  await until(() => refExists(M.dir, 'refs/remotes/origin/from-other'), 'origin/from-other fetched');
  await waitShown('branch-origin/from-other');
});

await step('sidebar · remotes: Copy URL puts the address on the clipboard', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await menu(tid('remote-origin'), 'Copy URL');
  await statusHas(/Copied/);
  expect((await page.evaluate(() => navigator.clipboard.readText())) === M.origin, 'the URL is on the clipboard');
});

await step('sidebar · remotes: Add remote (the + of Remotes) refuses a name in use and an empty address, saying why; Enter adds it; its branches come with a fetch', async () => {
  const second = bare('side-remote-second');
  git(M.dir, 'push', '-q', second, 'main');
  await tid('group-header-remotes').locator('[aria-label="Add remote"]').click();
  await waitShown('remote-name');
  expect((await tid('remote-name').inputValue()) === '', 'origin exists: the name starts empty');
  expect(await disabledBtn('remote-go'), 'nothing to add yet');
  await tid('remote-name').fill('origin');
  await tid('remote-url').fill(second);
  expect(await disabledBtn('remote-go'), 'origin is taken');
  expect(/already exists/.test(await tid('remote-note').innerText()), 'says the name is taken: ' + (await tid('remote-note').innerText()));
  await tid('remote-url').fill('');
  await tid('remote-name').fill('bad name');
  expect(await disabledBtn('remote-go'), 'a name with a space is refused');
  await tid('remote-name').fill('second');
  expect(await disabledBtn('remote-go'), 'no address yet');
  await tid('remote-url').fill(second);
  expect(!(await disabledBtn('remote-go')), 'name and address: it can be added');
  await tid('remote-url').press('Enter');
  await until(() => remotesOf(M.dir).includes('second'), 'second added: ' + remotesOf(M.dir));
  await waitShown('remote-second');
  await menu(tid('remote-second'), 'Fetch second');
  await until(() => refExists(M.dir, 'refs/remotes/second/main'), 'second/main fetched');
  await waitShown('branch-second/main');
});

await step('sidebar · remotes: Edit remote… changes the address; a new name renames the remote, its branches and the upstreams that point there', async () => {
  const third = bare('side-remote-third');
  git(M.dir, 'push', '-q', third, 'main');
  git(M.dir, 'branch', '--set-upstream-to=second/main', 'to-prune');
  await menu(tid('remote-second'), 'Edit remote…');
  await waitShown('remote-url');
  expect((await tid('remote-name').inputValue()) === 'second' && (await tid('remote-url').inputValue()).endsWith('side-remote-second.git'), 'the dialog shows the remote');
  await tid('remote-url').fill(third);
  await tid('remote-go').click();
  await until(() => git(M.dir, 'remote', 'get-url', 'second').trim() === third, 'the URL changed');
  await menu(tid('remote-second'), 'Edit remote…');
  await tid('remote-name').fill('origin');
  expect(await disabledBtn('remote-go'), 'the name of another remote is refused');
  await tid('remote-name').fill('backup');
  await tid('remote-name').press('Enter');
  await until(() => remotesOf(M.dir).includes('backup') && !remotesOf(M.dir).includes('second'), 'renamed to backup: ' + remotesOf(M.dir));
  await waitShown('remote-backup');
  await waitGone('remote-second');
  await waitShown('branch-backup/main');
  expect(upOf(M.dir, 'to-prune') === 'backup/main', 'the upstream follows: ' + upOf(M.dir, 'to-prune'));
  expect(git(M.dir, 'remote', 'get-url', 'backup').trim() === third, 'the address stays');
});

await step('sidebar · remotes: Remove remote asks, then removes it and its branches', async () => {
  await menu(tid('remote-backup'), 'Remove remote');
  expect((await tid('confirm-message').innerText()).length > 0, 'asks');
  await confirmCancel();
  await waitGone('confirm-ok');
  expect(remotesOf(M.dir).includes('backup'), 'Cancel keeps it');
  await menu(tid('remote-backup'), 'Remove remote');
  await confirmOk();
  await until(() => !remotesOf(M.dir).includes('backup'), 'removed');
  await waitGone('remote-backup');
  await waitGone('branch-backup/main');
  expect(!refExists(M.dir, 'refs/remotes/backup/main'), 'its remote branches are gone too');
});

await step('sidebar · remotes: the refresh button of Remotes fetches every remote', async () => {
  git(M.other, 'checkout', '-q', '-b', 'fetched-by-button');
  git(M.other, 'push', '-q', 'origin', 'fetched-by-button');
  await tid('group-header-remotes').locator('[aria-label="Fetch all"]').click();
  await until(() => refExists(M.dir, 'refs/remotes/origin/fetched-by-button'), 'fetched');
  await waitShown('branch-origin/fetched-by-button');
});

await step('sidebar · remotes: the key in the Remotes header and Connection… of a remote open the connection settings', async () => {
  await tid('group-header-remotes').locator('[aria-label="Connection: SSH key or account"]').click();
  await waitShown('connection-dialog');
  await page.keyboard.press('Escape');
  await waitGone('connection-dialog');
  await menu(tid('remote-origin'), 'Connection (SSH key / account)…');
  await waitShown('connection-dialog');
  await page.keyboard.press('Escape');
  await waitGone('connection-dialog');
});

await step('sidebar · remotes: a shallow clone of one branch says the rest never arrives; Fetch every branch and Fetch the full history bring them', async () => {
  const dir = path.join(root, 'side-narrow');
  git(root, 'clone', '-q', '--depth', '1', '--branch', 'main', `file://${M.origin}`, dir);
  for (const ws of ['work', 'home']) await post('/api/scan', { path: root, depth: 1, register: true, workspace: ws });
  await page.reload({ waitUntil: 'load' });
  await open('side-narrow');
  await tid('group-header-remotes').click();
  await waitShown('follow-all-origin');
  expect((await tid('remote-origin').innerText()).toLowerCase().includes('narrow'), 'marked narrow');
  expect((await tid('group-remotes').innerText()).includes('This clone follows only some branches'), 'and says why the others are missing');
  const items = await itemsOf(tid('remote-origin'));
  expect(find(items, 'Fetch every branch of this remote') && !find(items, 'Fetch every branch of this remote').disabled, 'the menu offers it too: ' + labels(items));
  expect(find(items, 'Fetch the full history (unshallow)') && !find(items, 'Fetch the full history (unshallow)').disabled, 'and the full history: ' + labels(items));
  await tid('follow-all-origin').click();
  await until(() => refExists(dir, 'refs/remotes/origin/from-other'), 'the other branches arrived');
  await waitShown('branch-origin/from-other');
  await waitGone('follow-all-origin');
  await menu(tid('remote-origin'), 'Fetch the full history (unshallow)');
  await until(() => git(dir, 'rev-parse', '--is-shallow-repository').trim() === 'false', 'the whole history is here');
});

// ======================================================================================== tags
let T;
await step('sidebar · tags: the + of Tags makes a tag at HEAD with the message typed; Enter in the name creates it', async () => {
  const dir = await freshRepo('side-tags', { 'README.md': '# tags\n' });
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'Tagged two');
  git(dir, 'tag', 'v1', 'main~1');
  git(dir, 'tag', '-a', 'v2', '-m', 'Release two', 'main');
  // its only remote is not called origin
  const up = bare('side-tags');
  git(dir, 'remote', 'add', 'upstream', up);
  git(dir, 'push', '-q', '-u', 'upstream', 'main');
  T = { dir, up };
  await open('side-tags');
  await tid('group-header-tags').click();
  await waitShown('tag-v1');
  await tid('group-header-tags').locator('[aria-label="New tag"]').click();
  await waitShown('tag-name');
  await tid('tag-message').fill('Third release');
  await tid('tag-name').fill('v3');
  await tid('tag-name').press('Enter');
  await until(() => git(dir, 'tag', '-l', 'v3').trim() === 'v3', 'v3 created');
  expect(shaOf(dir, 'v3^{commit}') === shaOf(dir, 'HEAD'), 'at HEAD');
  expect(git(dir, 'cat-file', '-t', 'v3').trim() === 'tag', 'annotated (the default)');
  expect(git(dir, 'tag', '-l', '--format=%(contents)', 'v3').trim() === 'Third release', 'with the message typed: ' + git(dir, 'tag', '-l', '--format=%(contents)', 'v3'));
  await waitShown('tag-v3');
  expect((await tid('group-count-tags').innerText()).trim() === '3', 'Tags counts three');
});

await step('sidebar · tags: the menu of a tag: Checkout (a detached HEAD at it), Push tag (to the remote there is), Copy name, Delete (asks; Undo puts it back)', async () => {
  const items = await itemsOf(tid('tag-v1'));
  for (const l of ['Checkout v1', 'Push tag', 'Create branch here…', 'Copy name', 'Delete tag']) expect(find(items, l) && !find(items, l).disabled, `“${l}”: ${labels(items)}`);
  await menu(tid('tag-v1'), 'Checkout v1');
  await until(() => shaOf(T.dir, 'HEAD') === shaOf(T.dir, 'v1^{commit}') && headOf(T.dir) === 'HEAD', 'detached at v1');
  await statusHas(/Detached HEAD at/);
  await settle();
  await br('main').dblclick();
  await until(() => headOf(T.dir) === 'main', 'back on main');
  await menu(tid('tag-v2'), 'Push tag');
  await until(() => lsRemote(T.dir, 'upstream', 'refs/tags/v2'), 'v2 is on upstream (the only remote)');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await menu(tid('tag-v2'), 'Copy name');
  await statusHas(/Copied.*v2/);
  await menu(tid('tag-v1'), 'Delete tag');
  await confirmCancel();
  await waitGone('confirm-ok');
  expect(git(T.dir, 'tag', '-l', 'v1').trim() === 'v1', 'Cancel keeps it');
  await menu(tid('tag-v1'), 'Delete tag');
  await confirmOk();
  await until(() => !git(T.dir, 'tag', '-l', 'v1').trim(), 'v1 deleted');
  await waitGone('tag-v1');
  await tid('undo-button').click();
  await until(() => git(T.dir, 'tag', '-l', 'v1').trim() === 'v1', 'Undo puts v1 back');
  await waitShown('tag-v1');
});

// ==================================================================================== stashes
let S;
await step('sidebar · stashes: the + of Stashes stashes the local changes with a message (Enter); the list and the counts follow', async () => {
  const dir = await freshRepo('side-stash', { 'README.md': '# stash\n', 'a.txt': 'a\n', 'b.txt': 'b\n' });
  writeFileSync(path.join(dir, 'a.txt'), 'a\none\n');
  git(dir, 'stash', 'push', '-q', '-m', 'first stash');
  writeFileSync(path.join(dir, 'b.txt'), 'b\ntwo\n');
  git(dir, 'stash', 'push', '-q', '-m', 'second stash');
  writeFileSync(path.join(dir, 'a.txt'), 'a\nwork\n');
  S = { dir };
  await open('side-stash');
  await tid('group-header-stashes').click();
  await waitShown('stash-1');
  await tid('group-header-stashes').locator('[aria-label="Stash changes"]').click();
  await waitShown('stash-message');
  expect((await page.getByText('1 changed file will be stashed.', { exact: true }).count()) === 1, 'says what goes');
  await tid('stash-message').fill('third stash');
  await tid('stash-message').press('Enter');
  await until(() => git(dir, 'stash', 'list').includes('third stash') && !git(dir, 'status', '--porcelain').trim(), 'stashed: ' + git(dir, 'stash', 'list'));
  await page.waitForFunction(() => /third stash/.test(document.querySelector('[data-testid="stash-0"]')?.textContent ?? ''), null, { timeout: 5000 });
  expect((await tid('group-count-stashes').innerText()).trim() === '3', 'three stashes');
  await waitGone('sidebar-changes-count');
});

await step('sidebar · stashes: a click on a stash shows it in the details: its message and files', async () => {
  await tid('stash-1').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="commit-description"]')?.textContent ?? '').includes('second stash'), null, { timeout: 5000 });
  await page.waitForFunction(() => document.body.innerText.includes('b.txt'), null, { timeout: 5000 });
  await page.waitForFunction(() => (document.querySelector('[data-testid="stash-1"]') ? getComputedStyle(document.querySelector('[data-testid="stash-1"]').firstElementChild ?? document.querySelector('[data-testid="stash-1"]')).backgroundColor !== 'rgba(0, 0, 0, 0)' : false), null, { timeout: 3000 });
});

await step('sidebar · stashes: Apply puts the changes back and keeps the stash; Pop puts them back and drops it', async () => {
  await menu(tid('stash-2'), 'Apply');
  await until(() => git(S.dir, 'diff').includes('+one'), 'first stash applied');
  await waitShown('commit-box');
  expect(git(S.dir, 'stash', 'list').split('\n').filter(Boolean).length === 3, 'the stash stays');
  git(S.dir, 'checkout', '--', 'a.txt');
  await refreshUi();
  await tid('sidebar-commits').click();
  await menu(tid('stash-1'), 'Pop');
  await until(() => git(S.dir, 'diff').includes('+two'), 'second stash popped');
  await until(() => git(S.dir, 'stash', 'list').split('\n').filter(Boolean).length === 2, 'and dropped');
  await page.waitForFunction(() => !/second stash/.test(document.querySelector('[data-testid="group-stashes"]')?.textContent ?? ''), null, { timeout: 5000 });
  git(S.dir, 'checkout', '--', 'b.txt');
  await refreshUi();
});

await step('sidebar · stashes: Drop asks first and removes the stash; Undo brings it back', async () => {
  await menu(tid('stash-0'), 'Drop');
  await confirmCancel();
  await waitGone('confirm-ok');
  expect(git(S.dir, 'stash', 'list').includes('third stash'), 'Cancel keeps it');
  await menu(tid('stash-0'), 'Drop');
  await confirmOk();
  await until(() => !git(S.dir, 'stash', 'list').includes('third stash'), 'dropped');
  await page.waitForFunction(() => !/third stash/.test(document.querySelector('[data-testid="group-stashes"]')?.textContent ?? ''), null, { timeout: 5000 });
  await tid('undo-button').click();
  await until(() => git(S.dir, 'stash', 'list').includes('third stash'), 'Undo brought it back');
  await page.waitForFunction(() => /third stash/.test(document.querySelector('[data-testid="group-stashes"]')?.textContent ?? ''), null, { timeout: 5000 });
});

await step('sidebar · stashes: applying over changes that clash says why in the error window, and nothing is lost', async () => {
  writeFileSync(path.join(S.dir, 'a.txt'), 'a\nclash\n');
  await refreshUi();
  const errorsBefore = pageErrors.length;
  const n = git(S.dir, 'stash', 'list').split('\n').filter(Boolean).length;
  const idx = git(S.dir, 'stash', 'list', '--format=%gs').split('\n').findIndex((l) => l.includes('first stash'));
  await menu(tid(`stash-${idx}`), 'Pop');
  await tid('error-dialog').waitFor({ timeout: 10000 });
  expect(/overwritten|local changes/i.test(await tid('error-dialog').innerText()), 'git’s reason: ' + (await tid('error-dialog').innerText()).slice(0, 300));
  await page.keyboard.press('Escape');
  expect(git(S.dir, 'stash', 'list').split('\n').filter(Boolean).length === n, 'the stash is kept');
  expect(git(S.dir, 'diff').includes('+clash'), 'the local change is kept');
  // the engine answered the refused pop with a 500, which the browser logs: expected here, not a page error
  for (let i = pageErrors.length - 1; i >= errorsBefore; i--) if (/status of 500/.test(pageErrors[i])) pageErrors.splice(i, 1);
  git(S.dir, 'checkout', '--', 'a.txt');
  await refreshUi();
});

// ================================================================================= submodules
let U;
/** a repository of its own with two submodules like the user's (o2 and libs/o2libs); o2libs is not checked out */
async function subRepo(name) {
  const mk = (n) => {
    const d = path.join(tmp, `origins/${n}`);
    mkdirSync(d, { recursive: true });
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(d, `${n}.txt`), `${n}\n`);
    git(d, 'add', '-A');
    git(d, 'commit', '-q', '-m', `${n} one`);
    return d;
  };
  const o2 = mk('sub-o2');
  const libs = mk('sub-o2libs');
  const dir = await freshRepo(name, { 'README.md': `# ${name}\n` });
  // the test servers are folders: git refuses file:// for submodules unless told
  git(dir, 'config', 'protocol.file.allow', 'always');
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', o2, 'o2');
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', libs, 'libs/o2libs');
  git(dir, 'commit', '-q', '-m', 'Add submodules');
  git(dir, 'submodule', 'deinit', '-q', '-f', 'libs/o2libs');
  return { dir, o2, libs, recorded: git(dir, 'ls-tree', 'HEAD', 'o2').split(/\s+/)[2] };
}
const subRow = (p) => page.evaluate((p) => document.querySelector(`[data-testid="submodule-row-${p}"]`)?.innerText ?? null, p);

await step('sidebar · submodules: a tree of folders (o2, libs/o2libs) or a list, with each one’s state; a folder folds', async () => {
  U = await subRepo('side-sub');
  await open('side-sub');
  await waitShown('submodule-libs/o2libs');
  expect((await tid('group-count-submodules').innerText()).trim() === '2', 'two submodules');
  expect((await tid('submodule-o2').innerText()) === 'o2' && (await tid('submodule-libs/o2libs').innerText()) === 'o2libs', 'leaf names in the tree');
  expect(/not init/.test(await subRow('libs/o2libs')), 'o2libs is not checked out: ' + (await subRow('libs/o2libs')));
  expect((await tid('submodule-state-libs/o2libs').getAttribute('aria-label')) === 'not checked out', 'and its square says so');
  expect(!/not init/.test(await subRow('o2')), 'o2 shows its commit: ' + (await subRow('o2')));
  await tid('subfolder-libs').click();
  await waitGone('submodule-libs/o2libs');
  await tid('subfolder-libs').click();
  await waitShown('submodule-libs/o2libs');
  await tid('group-submodules').locator('[aria-label="list"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="submodule-libs/o2libs"]')?.textContent === 'libs/o2libs', null, { timeout: 3000 });
  expect(!(await has('subfolder-libs')), 'no folders in the list');
  await tid('group-submodules').locator('[aria-label="tree"]').click();
  await waitShown('subfolder-libs');
});

await step('sidebar · submodules: the menu: Initialize & update clones one that is not checked out; Copy URL; Reveal in Finder asks the system for its folder', async () => {
  const items = await itemsOf(tid('submodule-row-libs/o2libs'));
  for (const l of ['Open as repository', 'Initialize & update', 'Update recursively', 'Reveal in Finder', 'Copy URL']) expect(find(items, l) && !find(items, l).disabled, `“${l}”: ${labels(items)}`);
  await menu(tid('submodule-row-libs/o2libs'), 'Initialize & update');
  await until(() => existsSync(path.join(U.dir, 'libs/o2libs/.git')), 'o2libs cloned and checked out', 20000);
  await page.waitForFunction(() => !/not init/.test(document.querySelector('[data-testid="submodule-row-libs/o2libs"]')?.innerText ?? 'not init'), null, { timeout: 10000 });
  expect(find(await itemsOf(tid('submodule-row-libs/o2libs')), 'Update to index commit'), 'now it updates to the index commit');
  await menu(tid('submodule-row-libs/o2libs'), 'Update recursively');
  await page.waitForTimeout(1500);
  expect(!(await has('error-dialog')), 'Update recursively runs without an error');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await menu(tid('submodule-row-o2'), 'Copy URL');
  await statusHas(/Copied/);
  expect((await page.evaluate(() => navigator.clipboard.readText())) === U.o2, 'the submodule’s URL');
  // the engine would open Finder: answered here instead
  let revealed = null;
  await page.route('**/api/system/reveal', async (route) => {
    revealed = route.request().postDataJSON()?.path ?? '';
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  try {
    await menu(tid('submodule-row-o2'), 'Reveal in Finder');
    await until(async () => revealed !== null, 'Reveal asked the engine');
    expect(revealed === path.join(U.dir, 'o2') || revealed.endsWith('/side-sub/o2'), 'for the submodule’s folder: ' + revealed);
  } finally {
    await page.unroute('**/api/system/reveal');
  }
});

await step('sidebar · submodules: one moved outside Prong shows as changed after a refresh; Update to index commit, and Update all, put it back', async () => {
  const sub = path.join(U.dir, 'o2');
  const move = () => {
    git(sub, 'config', 'commit.gpgsign', 'false');
    git(sub, 'commit', '-q', '--allow-empty', '-m', 'moved by hand');
  };
  const at = () => shaOf(sub, 'HEAD');
  const state = (s) => page.waitForFunction((s) => document.querySelector('[data-testid="submodule-state-o2"]')?.getAttribute('aria-label') === s, s, { timeout: 8000 });
  await state('at the recorded commit');
  move();
  await refreshUi();
  await state('at another commit than recorded');
  await menu(tid('submodule-row-o2'), 'Update to index commit');
  await until(() => at() === U.recorded, 'o2 back at the recorded commit');
  await state('at the recorded commit');
  move();
  await refreshUi();
  await state('at another commit than recorded');
  await tid('group-header-submodules').locator('[aria-label="Update all (init + checkout to index)"]').click();
  await until(() => at() === U.recorded, 'Update all put o2 back');
  await state('at the recorded commit');
});

await step('sidebar · submodules: Sync URLs takes a changed address from .gitmodules into the configuration', async () => {
  const moved = path.join(tmp, 'origins/sub-o2-moved');
  git(tmp, 'clone', '-q', '--bare', U.o2, moved);
  git(U.dir, 'config', '-f', '.gitmodules', 'submodule.o2.url', moved);
  expect(git(U.dir, 'config', 'submodule.o2.url').trim() === U.o2, 'not synced yet');
  await tid('group-header-submodules').locator('[aria-label="Sync URLs from .gitmodules"]').click();
  await until(() => git(U.dir, 'config', 'submodule.o2.url').trim() === moved, 'synced: ' + git(U.dir, 'config', 'submodule.o2.url'));
  git(U.dir, 'checkout', '--', '.gitmodules');
  git(U.dir, 'submodule', 'sync', '-q');
});

await step('sidebar · submodules: a click (or Open as repository) opens the submodule in a tab next to its parent', async () => {
  await tid('submodule-row-o2').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="commit-scroll"]')?.innerText ?? '').includes('sub-o2 one'), null, { timeout: 10000 });
  await waitShown('tab-o2');
  await tid('tab-side-sub').click();
  await waitShown('submodule-row-o2');
  await menu(tid('submodule-row-libs/o2libs'), 'Open as repository');
  await page.waitForFunction(() => (document.querySelector('[data-testid="commit-scroll"]')?.innerText ?? '').includes('sub-o2libs one'), null, { timeout: 10000 });
  await tid('tab-side-sub').click();
  await waitShown('submodule-row-o2');
});

// =================================================================================== versions
let V;
await step('sidebar · versions: ver/XXX branches (local and remote) grouped per version, newest first; a remote-only one folded and marked; the rest behind “older versions”', async () => {
  const dir = await freshRepo('side-ver', { 'README.md': '# ver\n' });
  const origin = bare('side-ver');
  git(dir, 'remote', 'add', 'origin', origin);
  for (const b of ['ver/925', 'ver/926-hotfix', 'ver/1001', 'ver/100', 'ver/200', 'ver/300', 'ver/700', 'ver/12', 'ver/next']) git(dir, 'branch', b);
  git(dir, 'push', '-q', '-u', 'origin', 'main', 'ver/925', 'ver/700');
  git(dir, 'branch', '-D', 'ver/700');
  V = { dir, origin };
  await open('side-ver');
  await tid('group-header-remotes').click();
  await waitShown('version-925');
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid="group-versions"] [data-testid^="version-name-"]')].map((e) => e.textContent));
  expect(order.join(',') === '1001,926-hotfix,925,700,300', 'the five newest, newest first: ' + order.join(','));
  expect((await tid('group-count-versions').innerText()).trim() === '7', 'seven versions (ver/12 and ver/next are not versions)');
  expect(!(await page.locator('[data-testid="group-versions"] [data-testid="branch-ver/next"]').count()), 'ver/next is a plain branch');
  expect((await tid('version-row-925').innerText()).includes('2'), 'ver/925 and origin/ver/925 under 925');
  await page.locator('[data-testid="group-versions"] [data-testid="branch-origin/ver/925"]').waitFor({ timeout: 3000 });
  expect(/remote/.test(await tid('version-row-700').innerText()), 'a version only on the remote says so');
  expect(!(await page.locator('[data-testid="group-versions"] [data-testid="branch-origin/ver/700"]').count()), 'and starts folded');
  await tid('version-row-700').click();
  await page.locator('[data-testid="group-versions"] [data-testid="branch-origin/ver/700"]').waitFor({ timeout: 3000 });
  expect(/2 older versions/.test(await tid('versions-older-row').innerText()), 'two older versions behind the arrow');
  expect(!(await has('version-200')), 'folded');
  await tid('versions-older-row').click();
  await waitShown('version-200');
  await waitShown('version-100');
});

await step('sidebar · versions: the menu of a version: Checkout its branch, Show only this version, Copy version; a double click checks it out (a remote-only one gets its tracking branch)', async () => {
  const items = await itemsOf(tid('version-row-1001'));
  for (const l of ['Checkout ver/1001', 'Show only this version', 'Copy version']) expect(find(items, l) && !find(items, l).disabled, `“${l}”: ${labels(items)}`);
  await menu(tid('version-row-1001'), 'Checkout ver/1001');
  await until(() => headOf(V.dir) === 'ver/1001', 'on ver/1001');
  await page.waitForFunction(() => /SemiBold|Bold/.test(getComputedStyle(document.querySelector('[data-testid="version-name-1001"]')).fontFamily), null, { timeout: 5000 });
  expect(find(await itemsOf(tid('version-row-1001')), 'Already checked out')?.disabled, 'the current version cannot be checked out again');
  await menu(tid('version-row-925'), 'Show only this version');
  await waitShown('filter-chip-ver/925');
  await tid('clear-branch-filter').click();
  await waitGone('branch-filter-bar');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await menu(tid('version-row-926-hotfix'), 'Copy version');
  await statusHas(/Copied.*926-hotfix/);
  expect(find(await itemsOf(tid('version-row-700')), 'Checkout ver/700'), 'a version only on the remote checks out as its local branch');
  await settle();
  await tid('version-row-700').dblclick();
  await until(() => headOf(V.dir) === 'ver/700', 'on ver/700: ' + headOf(V.dir));
  expect(upOf(V.dir, 'ver/700') === 'origin/ver/700', 'tracking origin/ver/700');
  await settle();
  await tid('version-row-925').dblclick();
  await until(() => headOf(V.dir) === 'ver/925', 'on ver/925');
  await settle();
  await br('main').dblclick();
  await until(() => headOf(V.dir) === 'main', 'back on main');
});

// ============================================================================ folders, selection
let F;
const LONG_FOLDER = 'a-folder-name-that-is-much-too-long-for-a-narrow-sidebar';
await step('sidebar · folders: the menu of a folder: Show only its branches, Select them, Delete them…, open and close every folder inside, copy its name', async () => {
  const dir = await freshRepo('side-fold', { 'README.md': '# fold\n' });
  const origin = bare('side-fold');
  git(dir, 'remote', 'add', 'origin', origin);
  for (const b of ['hs/tmp/a', 'hs/tmp/b', 'hs/tmp/deep/c', 'other/x', `${LONG_FOLDER}/${LONG_FOLDER}`]) git(dir, 'branch', b);
  git(dir, 'tag', 't1');
  git(dir, 'push', '-q', '-u', 'origin', 'main', 'hs/tmp/a');
  F = { dir, origin };
  await open('side-fold');
  await tid('group-header-remotes').click();
  await tid('group-header-tags').click();
  await waitShown('branch-origin/hs/tmp/a');
  const items = await itemsOf(tid('folder-branch:hs/tmp'));
  for (const l of ['Show only its 3 branches in the history', 'Select its 3 branches', 'Delete its 3 branches…', 'Open every folder inside', 'Close every folder inside', 'Copy folder name']) expect(find(items, l) && !find(items, l).disabled, `“${l}”: ${labels(items)}`);
  await menu(tid('folder-branch:hs/tmp'), 'Show only its 3 branches in the history');
  for (const b of ['hs/tmp/a', 'hs/tmp/b', 'hs/tmp/deep/c']) await waitShown(`filter-chip-${b}`);
  expect(!(await has('filter-chip-other/x')), 'only the folder’s branches');
  await tid('clear-branch-filter').click();
  await waitGone('branch-filter-bar');
  await menu(tid('folder-branch:hs/tmp'), 'Select its 3 branches');
  await page.waitForFunction(() => /^3 selected/.test(document.querySelector('[data-testid="batch-count"]')?.textContent ?? ''), null, { timeout: 3000 });
  await page.keyboard.press('Escape');
  await waitGone('batch-bar');
  await menu(tid('folder-branch:hs/tmp'), 'Delete its 3 branches…');
  const dlg = await tid('delete-branches-dialog').innerText();
  expect(['hs/tmp/a', 'hs/tmp/b', 'hs/tmp/deep/c'].every((b) => dlg.includes(b)) && !dlg.includes('other/x'), 'the dialog lists them: ' + dlg);
  await page.keyboard.press('Escape');
  await waitGone('delete-branches-dialog');
  await menu(tid('folder-branch:hs'), 'Close every folder inside');
  await waitGone('folder-branch:hs/tmp');
  await tid('folder-branch:hs').click();
  await waitShown('folder-branch:hs/tmp');
  expect(!(await has('branch-hs/tmp/a')) && !(await has('folder-branch:hs/tmp/deep')), 'the folders inside stay closed');
  await menu(tid('folder-branch:hs'), 'Open every folder inside');
  await waitShown('branch-hs/tmp/deep/c');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await menu(tid('folder-branch:hs/tmp'), 'Copy folder name');
  await statusHas(/Copied.*hs\/tmp/);
  const remoteItems = await itemsOf(tid('folder-remote:origin/hs'));
  expect(find(remoteItems, 'Delete its branch on the remote…'), 'a folder of remote branches deletes them on the remote: ' + labels(remoteItems));
  expect(find(remoteItems, 'Open every folder inside') && !find(remoteItems, 'Open every folder inside').disabled, 'it has a folder inside');
  await menu(tid('folder-remote:origin/hs'), 'Delete its branch on the remote…');
  await page.getByText('Delete 1 branch', { exact: true }).waitFor({ timeout: 3000 });
  expect((await tid('delete-branches-dialog').innerText()).includes('origin/hs/tmp/a'), 'the remote branch is listed');
  await page.keyboard.press('Escape');
  await waitGone('delete-branches-dialog');
  const leafOnly = await itemsOf(tid('folder-branch:other'));
  expect(find(leafOnly, 'Open every folder inside')?.disabled, 'no folders inside other/: off');
});

await step('sidebar · folders: a folder of more than 200 branches draws 200 and shows the rest on a click', async () => {
  const lines = Array.from({ length: 230 }, (_, i) => `create refs/heads/many/b${String(i + 1).padStart(3, '0')} ${shaOf(F.dir, 'HEAD')}`).join('\n') + '\n';
  execFileSync('git', ['update-ref', '--stdin'], { cwd: F.dir, input: lines });
  await refreshUi();
  await waitShown('folder-branch:many');
  const rows = () => page.evaluate(() => document.querySelectorAll('[data-testid="group-branches"] [data-testid^="branch-many/"]').length);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="group-branches"] [data-testid^="branch-many/"]').length > 0, null, { timeout: 8000 });
  expect((await rows()) === 200, '200 drawn: ' + (await rows()));
  expect(/Show 30 more/.test(await tid('more-branch:many').innerText()), 'and a row for the rest');
  await tid('more-branch:many').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="group-branches"] [data-testid^="branch-many/"]').length === 230, null, { timeout: 5000 });
  await waitGone('more-branch:many');
  await waitShown('branch-many/b230');
  execFileSync('git', ['update-ref', '--stdin'], { cwd: F.dir, input: lines.replace(/^create (\S+) (\S+)$/gm, 'delete $1 $2') });
  await refreshUi();
  await waitGone('folder-branch:many', 8000);
});

await step('sidebar · selection: ⌘ picks branches across folders and remotes, Shift a run as shown; the batch menu shows them, adds to the filter, pushes, copies, clears', async () => {
  const count = () => page.evaluate(() => document.querySelector('[data-testid="batch-count"]')?.textContent ?? '');
  await br('hs/tmp/a').click({ modifiers: ['Meta'] });
  await waitShown('batch-bar');
  await br('hs/tmp/b').click({ modifiers: ['Shift'] });
  await page.waitForFunction(() => /^2 selected/.test(document.querySelector('[data-testid="batch-count"]')?.textContent ?? ''), null, { timeout: 3000 });
  await br('origin/hs/tmp/a').click({ modifiers: ['Meta'] });
  await page.waitForFunction(() => /^3 selected/.test(document.querySelector('[data-testid="batch-count"]')?.textContent ?? ''), null, { timeout: 3000 });
  expect(headOf(F.dir) === 'main', 'picking checks nothing out');
  let items = await itemsOf(br('hs/tmp/b'));
  expect((await count()).startsWith('3 selected'), 'the Escape that closed the menu leaves the selection: ' + (await count()));
  for (const l of ['Show only these 3 in the history', 'Push 2 branches', 'Delete 3 branches…', 'Copy names', 'Clear the selection']) expect(find(items, l) && !find(items, l).disabled, `“${l}”: ${labels(items)}`);
  expect(find(items, 'Add them to the branch filter')?.disabled, 'nothing filtered: adding is off');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await menu(br('hs/tmp/b'), 'Copy names');
  expect((await page.evaluate(() => navigator.clipboard.readText())).split('\n').sort().join(',') === 'hs/tmp/a,hs/tmp/b,origin/hs/tmp/a', 'the names, one per line');
  await br('hs/tmp/deep/c').hover();
  await tid('funnel-hs/tmp/deep/c').click();
  await waitShown('filter-chip-hs/tmp/deep/c');
  await menu(br('hs/tmp/b'), 'Add them to the branch filter');
  for (const b of ['hs/tmp/a', 'hs/tmp/b', 'origin/hs/tmp/a', 'hs/tmp/deep/c']) await waitShown(`filter-chip-${b}`);
  await menu(br('hs/tmp/b'), 'Show only these 3 in the history');
  await waitGone('filter-chip-hs/tmp/deep/c');
  await tid('clear-branch-filter').click();
  // an Escape that closes a dialog leaves it too
  await tid('batch-delete').click();
  await waitShown('delete-branches-dialog');
  await page.keyboard.press('Escape');
  await waitGone('delete-branches-dialog');
  expect((await count()).startsWith('3 selected'), 'still picked after Escape closed the dialog: ' + (await count()));
  await menu(br('hs/tmp/b'), 'Push 2 branches');
  await until(() => !!lsRemote(F.dir, 'origin', 'refs/heads/hs/tmp/b'), 'hs/tmp/b pushed');
  await waitShown('branch-origin/hs/tmp/b');
  expect((await count()).startsWith('3 selected'), 'still picked after the push');
  await menu(br('hs/tmp/b'), 'Clear the selection');
  await waitGone('batch-bar');
  // the ✕ of the bar clears too
  await br('other/x').click({ modifiers: ['Meta'] });
  await waitShown('batch-bar');
  await tid('batch-clear').click();
  await waitGone('batch-bar');
});

await step('sidebar · funnels: a remote branch’s and a tag’s funnel filter the history; a second click takes it out again', async () => {
  await br('origin/hs/tmp/a').hover();
  await tid('funnel-origin/hs/tmp/a').click();
  await waitShown('filter-chip-origin/hs/tmp/a');
  await tid('tag-t1').hover();
  await tid('funnel-t1').click();
  await waitShown('filter-chip-t1');
  expect(await has('filter-chip-origin/hs/tmp/a'), 'both in the filter');
  await tid('funnel-t1').click();
  await waitGone('filter-chip-t1');
  await br('origin/hs/tmp/a').hover();
  await tid('funnel-origin/hs/tmp/a').click();
  await waitGone('branch-filter-bar');
});

await step('sidebar · confirmations: Escape cancels a deletion, Enter confirms it', async () => {
  git(F.dir, 'branch', 'confirm-me');
  await refreshUi();
  await menu(br('confirm-me'), 'Delete');
  await waitShown('confirm-ok');
  await page.keyboard.press('Escape');
  await waitGone('confirm-ok');
  expect(refExists(F.dir, 'refs/heads/confirm-me'), 'Escape keeps it');
  await menu(br('confirm-me'), 'Delete');
  await waitShown('confirm-ok');
  await page.keyboard.press('Enter');
  await until(() => !refExists(F.dir, 'refs/heads/confirm-me'), 'Enter deleted it');
});

// ===================================================================================== layout
await step('sidebar · layout: the splitter resizes the sidebar and the width stays after a reload', async () => {
  const width = () => page.evaluate(() => Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width));
  const drag = async (dx) => {
    const b = await tid('sidebar-splitter').boundingBox();
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y);
    await page.mouse.up();
    await page.waitForTimeout(200);
  };
  const w0 = await width();
  await drag(100);
  const w1 = await width();
  expect(Math.abs(w1 - w0 - 100) <= 3, `wider by 100: ${w0} → ${w1}`);
  await page.waitForTimeout(800);
  await page.reload({ waitUntil: 'load' });
  await settleReload();
  expect(Math.abs((await width()) - w1) <= 3, `kept after a reload: ${await width()} (was ${w1})`);
  await drag(-1000);
  expect((await width()) >= 160 && (await width()) <= 180, 'no narrower than its minimum: ' + (await width()));
});

await step('sidebar · layout: at the narrowest sidebar and a small window, long names are cut off and nothing sticks out', async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  try {
    await page.waitForTimeout(300);
    for (const f of [`folder-branch:${LONG_FOLDER}`]) await waitShown(f);
    await shot('narrow');
    const out = await overflowing();
    expect(out.length === 0, 'nothing sticks out of the sidebar: ' + out.join(', '));
    const cut = await page.evaluate((n) => {
      const e = document.querySelector(`[data-testid="folder-branch:${n}"]`);
      const t = [...e.querySelectorAll('div')].find((d) => d.textContent === n && !d.children.length);
      return t ? t.scrollWidth > t.clientWidth : null;
    }, LONG_FOLDER);
    expect(cut === true, 'the long folder name is cut off: ' + cut);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

await step('sidebar: no errors in the page', async () => {
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.slice(0, 5).join(' | '));
});

await finish('sidebar');
