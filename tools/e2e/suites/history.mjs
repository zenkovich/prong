/**
 * The history: the commit list and its graph, the details of a commit, its files and diffs, file history, blame,
 * and the commit menu with its dialogs — what a Fork user does there and sees.
 *
 * Most checks work in `hist`, a repository of this suite's own (a merge, tags, an origin, a rename, an image);
 * beta (650 commits) is used read-only for paging.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { page, check, expect, openRepo, waitText, until, root, tmp, freshRepo, refreshUi, undoLabel, pageErrors, makePng, post, finish } from '../harness.mjs';

const SHOTS = process.env.HISTORY_SHOTS;
const shot = async (name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }));

// ---------- the repository of this suite ----------

let clock = Math.floor(Date.now() / 1000) - 3600 * 24 * 10;
/** git with fixed, increasing dates (the list's order is the date order), as `who` */
function g(dir, args, who = 'E2E Author <e2e@example.com>') {
  clock += 600;
  const [, name, email] = /^(.*) <(.*)>$/.exec(who);
  const date = `${clock} +0000`;
  return execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).toString();
}
const write = (dir, file, text) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
const commitAll = (dir, msg, who) => {
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-q', '-m', msg], who);
};
const ALICE = 'Alice Liddell <alice@example.com>';
const BOB = 'Bob Builder <bob@example.com>';

/**
 * hist, oldest first:
 *   Initial commit · Add notes (Alice, with a body) · Edit notes (Bob, notes.txt and README.md) ·· topic: Topic one,
 *   Topic two ··
 *   Main work · Merge branch 'topic' · Rename notes (notes.txt → docs/notes.md) · Add picture · Remove main.txt
 *   (origin/main here) · Local work (main is one ahead) · Side work (branch side, from Edit notes) · Remote only work
 *   (only origin/remote-only has it)
 * tags: v0.1 (annotated, on Edit notes), light (on Main work); the working copy has one change.
 */
const hist = await freshRepo('hist', { 'README.md': '# hist\n' });
{
  const d = hist;
  write(d, 'notes.txt', 'alpha\nbeta\ngamma\n');
  commitAll(d, 'Add notes\n\nWhy: a place for notes.\nSecond line of the body.', ALICE);
  write(d, 'notes.txt', 'alpha\nBETA\ngamma\n');
  write(d, 'README.md', '# hist\n\nnotes are in notes.txt\n');
  commitAll(d, 'Edit notes', BOB);
  g(d, ['tag', '-a', 'v0.1', '-m', 'first release']);
  g(d, ['checkout', '-q', '-b', 'topic']);
  write(d, 'topic.txt', 'topic 1\n');
  commitAll(d, 'Topic one');
  write(d, 'topic.txt', 'topic 1\ntopic 2\n');
  commitAll(d, 'Topic two');
  g(d, ['checkout', '-q', 'main']);
  write(d, 'main.txt', 'main\n');
  commitAll(d, 'Main work');
  g(d, ['tag', 'light']);
  g(d, ['merge', '-q', '--no-ff', '-m', "Merge branch 'topic'", 'topic']);
  mkdirSync(path.join(d, 'docs'), { recursive: true });
  g(d, ['mv', 'notes.txt', 'docs/notes.md']);
  g(d, ['commit', '-q', '-m', 'Rename notes']);
  writeFileSync(path.join(d, 'picture.png'), makePng(40, 30, [200, 60, 40], [255, 255, 255]));
  commitAll(d, 'Add picture');
  rmSync(path.join(d, 'main.txt'));
  commitAll(d, 'Remove main.txt');
  const origin = path.join(tmp, 'origins/hist.git');
  mkdirSync(path.dirname(origin), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', origin]);
  g(d, ['remote', 'add', 'origin', origin]);
  g(d, ['push', '-q', '-u', 'origin', 'main']);
  write(d, 'docs/notes.md', 'alpha\nBETA\ngamma\ndelta\n');
  commitAll(d, 'Local work', ALICE);
  // off the current branch: a local branch from Edit notes, and a branch only the remote has
  g(d, ['checkout', '-q', '-b', 'side', 'v0.1']);
  write(d, 'side.txt', 'side\n');
  commitAll(d, 'Side work', BOB);
  g(d, ['checkout', '-q', '-b', 'gone-local', 'v0.1']);
  write(d, 'remote.txt', 'remote\n');
  commitAll(d, 'Remote only work');
  g(d, ['push', '-q', 'origin', 'gone-local:remote-only']);
  g(d, ['checkout', '-q', 'main']);
  g(d, ['branch', '-D', 'gone-local']);
  write(d, 'README.md', '# hist\n\nnotes are in notes.txt\nwork in progress\n');
}
/**
 * ops, for the commit menu's actions (they change history; hist stays as it is), oldest first:
 *   Initial commit · Ops two · Merge mside (of M side) · Ops three · Ops four (main = origin/main, clean)
 *   feature (from Ops two): Feature work · pick-merge (from Ops two): PM base, Merge pm-side (of PM side)
 *   tag local-only on Ops three, never pushed
 */
const ops = await freshRepo('ops', { 'README.md': '# ops\n' });
{
  const d = ops;
  write(d, 'a.txt', 'a1\n');
  commitAll(d, 'Ops two');
  const two = g(d, ['rev-parse', 'HEAD']).trim();
  g(d, ['checkout', '-q', '-b', 'mside']);
  write(d, 'm.txt', 'm\n');
  commitAll(d, 'M side');
  g(d, ['checkout', '-q', 'main']);
  g(d, ['merge', '-q', '--no-ff', '-m', 'Merge mside', 'mside']);
  g(d, ['branch', '-D', 'mside']);
  write(d, 'a.txt', 'a1\na2\n');
  commitAll(d, 'Ops three');
  g(d, ['tag', 'local-only']);
  write(d, 'b.txt', 'b\n');
  commitAll(d, 'Ops four');
  g(d, ['checkout', '-q', '-b', 'feature', two]);
  write(d, 'f.txt', 'feature\n');
  commitAll(d, 'Feature work');
  g(d, ['checkout', '-q', '-b', 'pm-side', two]);
  write(d, 'p.txt', 'p\n');
  commitAll(d, 'PM side');
  g(d, ['checkout', '-q', '-b', 'pick-merge', two]);
  write(d, 'q.txt', 'q\n');
  commitAll(d, 'PM base');
  g(d, ['merge', '-q', '--no-ff', '-m', 'Merge pm-side', 'pm-side']);
  g(d, ['checkout', '-q', 'main']);
  const origin = path.join(tmp, 'origins/ops.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  g(d, ['remote', 'add', 'origin', origin]);
  g(d, ['push', '-q', '-u', 'origin', 'main']);
}
const og = (...args) => g(ops, args).trim();
/** git in ops that answers '' instead of failing (polling for a ref that is not there yet) */
const ogq = (...args) => {
  try {
    return og(...args);
  } catch {
    return '';
  }
};
/** the branches and tags ops starts with: each check puts them back */
const OPS_REFS = og('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags').split('\n').map((l) => l.split(' '));
const sha = (rev) => g(hist, ['rev-parse', rev]).trim();
const head = () => g(hist, ['rev-parse', 'HEAD']).trim();
const branch = () => g(hist, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

// ---------- helpers ----------

/** a commit's subject in its row (the HEAD commit's and those off the current branch have testIDs of their own) */
const SUBJ = '[data-testid="commit-subject"], [data-testid="head-commit"], [data-testid="off-branch-commit"]';
const rowOf = (subject) => page.locator('[data-testid^="commit-row-"]').filter({ has: page.locator(SUBJ).getByText(subject, { exact: true }) }).first();
/** the subjects of the commit list, top to bottom (what is rendered; '' for the working-copy row) */
const subjects = () => page.evaluate((S) => [...document.querySelectorAll('[data-testid^="commit-row-"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((e) => e.querySelector(S)?.textContent ?? ''), SUBJ);
/** waits for the list to show exactly `want` (top to bottom); fails with what it shows */
const shows = async (want, what, ms = 6000) => {
  const end = Date.now() + ms;
  let got;
  while (Date.now() < end) {
    got = await subjects();
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`${what}: ${JSON.stringify(got)}`);
};
const selectedSubject = () => page.evaluate((S) => document.querySelector('[data-testid="selected-commit"]')?.querySelector(S)?.textContent ?? null, SUBJ);
const waitSelected = (subject, ms = 5000) => page.waitForFunction(([S, s]) => document.querySelector('[data-testid="selected-commit"]')?.querySelector(S)?.textContent === s, [SUBJ, subject], { timeout: ms });
const details = () => page.getByTestId('commit-description').innerText();
const countText = () => page.getByTestId('commit-count').innerText();
const openHist = async () => {
  await openRepo('hist');
  await page.getByText('All Commits', { exact: true }).first().click();
  await rowOf('Local work').waitFor({ timeout: 10000 });
};
/** hist in front, on All Commits, no search or filter, nothing over it (each check can run alone: E2E_ONLY) */
const ensureHist = async () => {
  for (let i = 0; i < 3 && ((await page.getByTestId('graph-filter-popover').count()) || (await page.getByText('Cancel', { exact: true }).count())); i++) await page.keyboard.press('Escape');
  if (await page.getByTestId('tab-hist').count()) await page.getByTestId('tab-hist').click();
  else await openRepo('hist');
  await page.getByText('All Commits', { exact: true }).first().click();
  if (await page.getByTestId('clear-branch-filter').count()) await page.getByTestId('clear-branch-filter').click();
  if ((await page.getByTestId('commit-search').inputValue().catch(() => '')) !== '') await page.getByTestId('commit-search').fill('');
  if (await page.getByText('Close', { exact: true }).count()) await page.getByText('Close', { exact: true }).first().click();
  await rowOf('Local work').waitFor({ timeout: 10000 });
};
/** beta in front on All Commits, read, no search or filter */
const ensureBeta = async () => {
  if (await page.getByTestId('tab-beta').count()) await page.getByTestId('tab-beta').click();
  else await openRepo('beta');
  await page.getByText('All Commits', { exact: true }).first().click();
  if (await page.getByTestId('clear-branch-filter').count()) await page.getByTestId('clear-branch-filter').click();
  if ((await page.getByTestId('commit-search').inputValue().catch(() => '')) !== '') await page.getByTestId('commit-search').fill('');
  if (await page.getByTestId('file-history-close').count()) await page.getByTestId('file-history-close').click();
  await page.waitForFunction(() => /of \d+\+? commits/.test(document.querySelector('[data-testid="commit-count"]')?.textContent ?? ''), null, { timeout: 20000 });
};
/** beta as just opened, with only its first page read: the page reloads (the session brings beta back) */
const freshBeta = async () => {
  await ensureBeta();
  await page.waitForTimeout(900); // the session is saved half a second after a change
  await page.reload({ waitUntil: 'load' });
  await page.getByTestId('tab-beta').waitFor({ timeout: 20000 });
  await ensureBeta();
  expect(/^\d+ of 300\+ commits/.test((await countText()).trim()), 'only the first page: ' + (await countText()));
};
/** a click on a commit's subject (600 ms after the previous click on a row: two would make a double click) */
const pick = async (subject) => {
  await page.waitForTimeout(600);
  await rowOf(subject).locator(SUBJ).first().click();
  await waitSelected(subject);
};
const menu = async (subject, item) => {
  await rowOf(subject).locator(SUBJ).first().click({ button: 'right' });
  const it = page.getByText(item, { exact: true }).last();
  await it.waitFor({ timeout: 3000 });
  return it;
};
/** an item of a file row's menu (by the row's testID) */
const fileMenu = async (testid, item) => {
  await page.getByTestId(testid).click({ button: 'right' });
  const it = page.getByText(item, { exact: true }).last();
  await it.waitFor({ timeout: 3000 });
  await it.click();
};
/** an item of the open context menu, by its label */
const menuItem = (label) => page.locator('[data-testid="menu-item"]').filter({ has: page.getByText(label, { exact: true }) }).last();
/** a pressable drawn disabled (react-native-web marks it with aria-disabled) */
const disabled = async (loc) => (await loc.getAttribute('aria-disabled')) === 'true';
const statusText = () => page.evaluate(() => document.querySelector('[data-testid="status-bar"]')?.textContent ?? '');
/** the clipboard, as the page wrote it */
const spyClipboard = () =>
  page.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = (t) => (window.__copied.push(t), Promise.resolve());
  });
const copied = () => page.evaluate(() => window.__copied ?? []);

// ---------- loading ----------

await check('history: while a repository loads, the list says it is loading — not "No commits match" or "0 of 0 commits"', async () => {
  // the engine answers the first read slowly
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route('**/api/repo/snapshot', async (route) => {
    await gate;
    await route.continue();
  });
  await page.route('**/api/repo/snapshotCached', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
  try {
    await page.getByTestId('home-button').click();
    await page.getByText('payments-service-backend-api', { exact: true }).first().click();
    await page.getByTestId('commit-scroll').waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    const t = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    expect(!t.includes('no commits match'), 'no "No commits match" while loading');
    expect(!/\b0 of 0 commits/.test(t), 'no "0 of 0 commits" while loading');
    expect(t.includes('loading'), 'it says it is loading');
  } finally {
    release();
    await page.unroute('**/api/repo/snapshot');
    await page.unroute('**/api/repo/snapshotCached');
  }
  await waitText('Change pixel');
  expect(!(await page.evaluate(() => document.body.innerText.toLowerCase().includes('loading history'))), 'the loading note goes once the commits are there');
});

// ---------- the list ----------

await check('history: the column header names Description, Author, Date and SHA over the matching columns', async () => {
  await openHist();
  const head = page.getByTestId('commit-header');
  for (const c of ['Description', 'Author', 'Date', 'SHA']) expect((await head.innerText()).toLowerCase().includes(c.toLowerCase()), `header has ${c}`);
  const row = rowOf('Edit notes');
  const box = async (loc) => (await loc.boundingBox()) ?? { x: -1, width: 0 };
  const author = await box(row.getByText('Bob Builder', { exact: true }));
  const sha7 = sha('main~6').slice(0, 7);
  const shaBox = await box(row.getByText(sha7, { exact: true }));
  const hAuthor = await box(head.getByText('Author', { exact: true }));
  const hSha = await box(head.getByText('SHA', { exact: true }));
  expect(Math.abs(hSha.x - shaBox.x) < 12, `SHA column lines up: ${hSha.x} vs ${shaBox.x}`);
  expect(author.x >= hAuthor.x - 30 && author.x < hAuthor.x + 40, `Author column lines up: ${hAuthor.x} vs ${author.x}`);
});

await check('history: rows show subject, author, a relative date and the short sha, newest first, the merge and its branch in order', async () => {
  await ensureHist();
  const s = await subjects();
  const want = ['', 'Remote only work', 'Side work', 'Local work', 'Remove main.txt', 'Add picture', 'Rename notes', "Merge branch 'topic'", 'Main work', 'Topic two', 'Topic one', 'Edit notes', 'Add notes', 'Initial commit'];
  expect(JSON.stringify(s) === JSON.stringify(want), 'order: ' + JSON.stringify(s));
  const row = await rowOf('Add notes').innerText();
  expect(row.includes('Alice Liddell') && /\b\d+ d ago\b/.test(row) && row.includes(sha('main~7').slice(0, 7)), 'row text: ' + row);
});

await check('history: "Uncommitted changes (N)" on top counts the changed files and opens Changes', async () => {
  await ensureHist();
  const wip = page.getByTestId('commit-row-wip');
  expect((await wip.innerText()).includes('Uncommitted changes (1)'), 'one change: ' + (await wip.innerText()));
  await wip.click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="commit-scroll"]'), null, { timeout: 5000 });
  expect(await page.getByTestId('file-unstaged-README.md').count(), 'Changes lists README.md');
  await page.getByText('All Commits', { exact: true }).first().click();
  await rowOf('Local work').waitFor();
});

await check('history: ref labels — the current branch filled with its origin cloud, a tag in <>, a local branch in []', async () => {
  await ensureHist();
  const local = rowOf('Local work');
  expect(await local.getByTestId('ref-main').count(), 'main on Local work');
  expect(!(await local.getByTestId('ref-cloud-main').count()), 'no cloud: origin/main is one behind');
  expect(await rowOf('Remove main.txt').getByTestId('ref-origin/main').count(), 'origin/main has a label of its own (remote only)');
  expect(await rowOf('Edit notes').getByTestId('ref-v0.1').count(), 'tag v0.1');
  expect((await rowOf('Edit notes').getByTestId('ref-v0.1').innerText()).replace(/\s/g, '') === '<v0.1>', 'tag in angle brackets');
  expect((await rowOf('Topic two').getByTestId('ref-topic').innerText()).replace(/\s/g, '') === '[topic]', 'branch in brackets');
});

await check('history: a click on a branch or tag label in a row selects that commit', async () => {
  await ensureHist();
  await page.waitForTimeout(600);
  await rowOf('Edit notes').getByTestId('ref-v0.1').click();
  await waitSelected('Edit notes', 3000);
});

// ---------- search ----------

const ALL = 13;
await check('history: search by message, author, sha and body narrows the list and the count; clearing it brings all back', async () => {
  await ensureHist();
  const box = page.getByTestId('commit-search');
  await box.fill('notes');
  await shows(['Rename notes', 'Edit notes', 'Add notes'], 'message');
  await until(async () => /^3 found$/.test((await countText()).trim()), 'count: ' + (await countText()));
  await box.fill('ALICE');
  await shows(['Local work', 'Add notes'], 'author, any case');
  await box.fill(sha('main~6').slice(0, 9));
  await shows(['Edit notes'], 'sha prefix');
  await box.fill('second line of the body');
  await shows(['Add notes'], 'the body');
  await box.fill('zzz-nothing');
  await page.getByTestId('commits-empty').waitFor({ timeout: 3000 });
  expect((await page.getByTestId('commits-empty').innerText()).includes('zzz-nothing'), 'says what found nothing: ' + (await page.getByTestId('commits-empty').innerText()));
  await box.fill('');
  await until(async () => (await subjects()).length === ALL + 1, 'all back, with the working-copy row');
  expect(/^13 of 13 commits$/.test((await countText()).trim()), 'count back: ' + (await countText()));
});

await check('history: search covers the whole history, not just the commits read so far; cleared, the list goes to the commit picked (beta)', async () => {
  await freshBeta();
  const box = page.getByTestId('commit-search');
  await box.fill('Filler 12');
  const want = ['Filler 129', 'Filler 128', 'Filler 127', 'Filler 126', 'Filler 125', 'Filler 124', 'Filler 123', 'Filler 122', 'Filler 121', 'Filler 120', 'Filler 12'];
  await shows(want, 'every match, deep ones too', 10000);
  expect(/^11 found$/.test((await countText()).trim()), 'count: ' + (await countText()));
  await page.waitForTimeout(600);
  await rowOf('Filler 12').locator(SUBJ).first().click();
  await waitSelected('Filler 12');
  expect((await details()).includes('Filler 12'), 'its details');
  await box.fill('');
  await waitSelected('Filler 12', 15000);
  const inView = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="selected-commit"]')?.getBoundingClientRect();
    const sc = document.querySelector('[data-testid="commit-scroll"]').getBoundingClientRect();
    return !!sel && sel.top >= sc.top - 1 && sel.bottom <= sc.bottom + 1;
  });
  expect(inView, 'the list scrolled to it');
  expect((await details()).includes('Filler 12'), 'still selected');
});

await check('history: the × in the search field clears it', async () => {
  await ensureHist();
  await page.getByTestId('commit-search').fill('topic');
  await until(async () => (await subjects()).length === 3, 'topic search');
  await page.getByTestId('commit-search-clear').click();
  await until(async () => (await page.getByTestId('commit-search').inputValue()) === '' && (await subjects()).length === ALL + 1, 'cleared');
  expect(!(await page.getByTestId('commit-search-clear').count()), 'the × goes with the text');
});

await check('history: Escape in the search field clears the search', async () => {
  await ensureHist();
  const box = page.getByTestId('commit-search');
  await box.fill('topic');
  await until(async () => (await subjects()).length === 3, 'topic search');
  await box.press('Escape');
  await until(async () => (await box.inputValue()) === '' && (await subjects()).length === ALL + 1, 'cleared by Escape');
});

await check('history: ⌘F focuses the commit search (from All Commits and from Changes)', async () => {
  await ensureHist();
  await page.locator('body').click({ position: { x: 700, y: 400 } }).catch(() => {});
  await page.keyboard.press('Meta+f');
  await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'commit-search'), 'search focused');
  await page.keyboard.type('picture');
  await shows(['Add picture'], 'typed into the search');
  await page.getByTestId('commit-search').fill('');
  await page.getByText('Changes', { exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="commit-scroll"]'));
  await page.keyboard.press('Meta+f');
  await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'commit-search'), 'from Changes: All Commits with the search focused');
  await page.keyboard.press('Escape');
});

// ---------- branch filter ----------

const filterButton = () => page.getByTestId('graph-filter-button');
await check('history: the branch filter — Current hides other branches, Hide remote branches hides remote-only work, the bar says so', async () => {
  await ensureHist();
  await rowOf('Side work').waitFor();
  await filterButton().click();
  const pop = page.getByTestId('graph-filter-popover');
  await pop.waitFor({ timeout: 3000 });
  await pop.getByText('Current', { exact: true }).click();
  await until(async () => !(await subjects()).includes('Side work') && !(await subjects()).includes('Remote only work') && (await subjects()).includes('Local work'), 'current branch only: ' + JSON.stringify(await subjects()));
  expect((await page.getByTestId('branch-filter-bar').innerText()).toLowerCase().includes('current branch only'), 'the bar says current branch only');
  expect((await filterButton().innerText()).toLowerCase().includes('current branch'), 'the button names the mode');
  await pop.getByText('All', { exact: true }).click();
  await until(async () => (await subjects()).includes('Side work'), 'all again');
  await pop.getByText('Hide remote branches', { exact: true }).click();
  await until(async () => !(await subjects()).includes('Remote only work') && (await subjects()).includes('Side work'), 'remote-only work hidden: ' + JSON.stringify(await subjects()));
  expect((await filterButton().innerText()).toLowerCase().includes('local branches'), 'the button says local branches');
  await pop.getByText('Hide remote branches', { exact: true }).click();
  await until(async () => (await subjects()).includes('Remote only work'), 'remote-only work back');
  await pop.getByText('Done', { exact: true }).click();
  await pop.waitFor({ state: 'detached', timeout: 3000 });
});

await check('history: the branch filter — None, then branches ticked one by one; a chip × takes one out, the last one out shows all; Clear filter', async () => {
  await ensureHist();
  await filterButton().click();
  const pop = page.getByTestId('graph-filter-popover');
  await pop.getByText('None', { exact: true }).click();
  await page.getByTestId('commits-empty').waitFor({ timeout: 5000 });
  expect((await page.getByTestId('commits-empty').innerText()).toLowerCase().includes('filter'), 'empty because of the filter');
  await pop.getByTestId('filter-ref-side').click();
  await shows(['', 'Side work', 'Edit notes', 'Add notes', 'Initial commit'], 'side alone (under the working-copy row)');
  await pop.getByTestId('filter-ref-topic').click();
  await shows(['', 'Side work', 'Topic two', 'Topic one', 'Edit notes', 'Add notes', 'Initial commit'], 'side and topic');
  await pop.getByPlaceholder('filter refs').fill('remote');
  expect((await pop.innerText()).includes('origin/remote-only') && !(await pop.innerText()).includes('topic'), 'the ref filter narrows the list');
  await page.keyboard.press('Escape');
  await pop.waitFor({ state: 'detached', timeout: 3000 });
  await page.getByTestId('filter-chip-topic').getByLabel('Remove topic from the filter').click();
  await shows(['', 'Side work', 'Edit notes', 'Add notes', 'Initial commit'], 'topic taken out');
  await page.getByTestId('filter-chip-side').getByLabel('Remove side from the filter').click();
  await until(async () => (await subjects()).length === ALL + 1 && !(await page.getByTestId('branch-filter-bar').count()), 'the last chip out: every branch again');
  // Clear filter
  await filterButton().click();
  await pop.getByTestId('filter-ref-side').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('branch-filter-bar').waitFor();
  await page.getByTestId('clear-branch-filter').click();
  await until(async () => (await subjects()).length === ALL + 1, 'everything back after Clear filter');
  expect(!(await page.getByTestId('branch-filter-bar').count()), 'the bar is gone');
});

await check('history: a click outside the branch filter popover closes it', async () => {
  await ensureHist();
  await filterButton().click();
  await page.getByTestId('graph-filter-popover').waitFor();
  await page.mouse.click(1100, 460);
  await page.getByTestId('graph-filter-popover').waitFor({ state: 'detached', timeout: 3000 });
});

// ---------- keyboard ----------

await check('history: ↓ and ↑ move the selection to the next and previous commit, the details follow', async () => {
  await ensureHist();
  await pick('Add picture');
  await page.keyboard.press('ArrowDown');
  await waitSelected('Rename notes');
  expect((await details()).includes('Rename notes'), 'details follow');
  await page.keyboard.press('ArrowDown');
  await waitSelected("Merge branch 'topic'");
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await waitSelected('Add picture');
  await page.keyboard.press('Home');
  await waitSelected('Remote only work');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300);
  expect((await selectedSubject()) === 'Remote only work' && (await page.getByTestId('commit-scroll').count()), 'stays on the first commit (the working-copy row is not a commit)');
  await page.keyboard.press('End');
  await waitSelected('Initial commit');
});

await check('history: arrows typed in the search field move the caret, not the selection', async () => {
  await ensureHist();
  const before = await selectedSubject();
  await page.getByTestId('commit-search').click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  expect((await selectedSubject()) === before, 'selection unchanged');
  await page.locator('body').press('Escape');
});

// ---------- details ----------

await check('history: details show subject, body, author with e-mail, date, the sha, the parent and the labels', async () => {
  await ensureHist();
  await pick('Add notes');
  const d = await details();
  expect(d.includes('Add notes') && d.includes('Why: a place for notes.') && d.includes('Second line of the body.'), 'subject and body: ' + d);
  expect(d.includes('Alice Liddell') && d.includes('<alice@example.com>'), 'author and e-mail');
  expect(d.includes(sha('main~7').slice(0, 12)), 'sha');
  expect(/Parent\s/.test(d) && d.includes(sha('main~8').slice(0, 7)), 'one parent: ' + d);
  await pick('Edit notes');
  expect(await page.getByTestId('commit-description').getByTestId('ref-v0.1').count(), 'the tag in the details');
  expect(await page.getByTestId('commit-description').getByTestId('ref-side').count() === 0, 'side does not point here');
  await pick("Merge branch 'topic'");
  const m = await details();
  expect(/Parents\s/.test(m) && m.includes(sha('main~5').slice(0, 7)) && m.includes(sha('topic').slice(0, 7)), 'a merge has both parents: ' + m);
});

await check('history: a click on the sha copies the full sha', async () => {
  await ensureHist();
  await spyClipboard();
  await page.getByTestId('details-sha').click();
  await until(async () => (await copied()).includes(sha('main~4')), 'copied: ' + JSON.stringify(await copied()));
});

await check('history: a click on a parent selects it and scrolls to it; the second parent of a merge too', async () => {
  await ensureHist();
  await pick("Merge branch 'topic'");
  await page.getByTestId(`details-parent-${sha('topic').slice(0, 7)}`).click();
  await waitSelected('Topic two');
  await page.waitForTimeout(600);
  await pick("Merge branch 'topic'");
  await page.getByTestId(`details-parent-${sha('main~5').slice(0, 7)}`).click();
  await waitSelected('Main work');
});

await check('history: a parent older than the loaded history is read and selected; the search that hid it goes (beta)', async () => {
  await freshBeta();
  // Filler 12 comes from the search (git searched the whole history); its parent is far below the first page
  await page.getByTestId('commit-search').fill('Filler 12');
  await until(async () => (await subjects()).includes('Filler 12'), 'found');
  await page.waitForTimeout(600);
  await rowOf('Filler 12').locator(SUBJ).first().click();
  await waitSelected('Filler 12');
  const beta = path.join(root, 'beta');
  const parent = execFileSync('git', ['log', '-1', '--format=%H', ':/^Filler 11$'], { cwd: beta }).toString().trim().slice(0, 7);
  await page.getByTestId(`details-parent-${parent}`).click();
  await waitSelected('Filler 11', 15000);
  expect((await details()).includes('Filler 11'), 'the details show it');
  expect((await page.getByTestId('commit-search').inputValue()) === '', 'the search is cleared so the list can show it');
});

await check('history: paging — "300 of 300+ commits" until the end is read, then the true total (beta)', async () => {
  await freshBeta();
  expect(/of \d+\+ commits/.test(await countText()), 'more to read: ' + (await countText()));
  const scrollEnd = () => page.getByTestId('commit-scroll').evaluate((e) => (e.scrollTop = e.scrollHeight));
  for (let i = 0; i < 10 && /\+/.test(await countText()); i++) {
    await scrollEnd();
    await page.waitForTimeout(500);
  }
  expect(/^653 of 653 commits/.test((await countText()).trim()), 'all read: ' + (await countText()));
  await scrollEnd();
  await waitText('Initial commit');
});

// ---------- the commit's files and diffs ----------

const fileRow = (p) => page.getByTestId(`file-commit-${p}`);
const diffHeader = () => page.getByTestId('diff-header').innerText();
await check('history: a commit\'s files — the count, a tree with folders that open and close, the list with full paths', async () => {
  await ensureHist();
  await pick('Edit notes');
  await until(async () => /files\s*2\b/i.test(await page.getByTestId('commit-files-header').innerText()), 'Files 2');
  await pick('Rename notes');
  const tree = page.getByTestId('commit-files-header').getByLabel('tree');
  const list = page.getByTestId('commit-files-header').getByLabel('list');
  await tree.click();
  await page.getByTestId('folder-commit-docs').waitFor();
  expect(await fileRow('docs/notes.md').isVisible(), 'the file under its folder');
  await page.getByTestId('folder-commit-docs').click();
  await fileRow('docs/notes.md').waitFor({ state: 'detached', timeout: 3000 });
  await page.getByTestId('folder-commit-docs').click();
  await fileRow('docs/notes.md').waitFor();
  await list.click();
  await page.getByTestId('folder-commit-docs').waitFor({ state: 'detached', timeout: 3000 });
  expect((await fileRow('docs/notes.md').innerText()).includes('docs/'), 'the list shows the folder in the path');
  await tree.click();
});

await check('history: a renamed file — R, "old → new" and the similarity in the diff header, and it says the content is the same', async () => {
  await ensureHist();
  await pick('Rename notes');
  await fileRow('docs/notes.md').click();
  expect((await fileRow('docs/notes.md').innerText()).trim().startsWith('R'), 'status R');
  await until(async () => (await diffHeader()).includes('notes.txt → docs/notes.md'), 'old → new');
  expect((await diffHeader()).includes('100% similar'), 'similarity: ' + (await diffHeader()));
  const body = (await page.getByTestId('diff-body').innerText()).toLowerCase();
  expect(!body.includes('no textual changes') && body.includes('renamed'), 'what happened, not "No textual changes": ' + body);
});

await check('history: a deleted file shows its old lines removed; an added image shows the new picture', async () => {
  await ensureHist();
  await pick('Remove main.txt');
  await fileRow('main.txt').click();
  expect((await fileRow('main.txt').innerText()).trim().startsWith('D'), 'status D');
  await until(async () => (await page.getByTestId('diff-body').innerText()).includes('main'), 'the removed line');
  expect(/−1/.test(await diffHeader()), 'counts in the header: ' + (await diffHeader()));
  await pick('Add picture');
  await fileRow('picture.png').click();
  await waitText('new file');
});

await check('history: unified and split diffs; the choice stays for the next commit; a hunk header folds its hunk', async () => {
  await ensureHist();
  await pick('Edit notes');
  await fileRow('notes.txt').click();
  await until(async () => (await page.getByTestId('diff-body').innerText()).includes('BETA'), 'the diff');
  await page.getByTestId('diff-header').getByLabel('split').click();
  await page.getByTestId('diff-split').first().waitFor({ timeout: 3000 });
  await pick('Add notes');
  await page.getByTestId('diff-split').first().waitFor({ timeout: 3000 });
  await page.getByTestId('diff-header').getByLabel('unified').click();
  await page.getByTestId('diff-unified').first().waitFor({ timeout: 3000 });
  await page.getByTestId('hunk-toggle').first().click();
  await until(async () => !(await page.getByTestId('diff-body').innerText()).includes('gamma'), 'folded');
  await page.getByTestId('hunk-toggle').first().click();
  await until(async () => (await page.getByTestId('diff-body').innerText()).includes('gamma'), 'unfolded');
});

await check('history: "Expand context ±10" shows more of the file around a hunk', async () => {
  await ensureHist();
  // a file long enough to have hidden context: 40 lines, one changed in the middle
  write(hist, 'long.txt', Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  g(hist, ['add', 'long.txt']);
  g(hist, ['commit', '-q', '-m', 'Long file', '--', 'long.txt']);
  write(hist, 'long.txt', Array.from({ length: 40 }, (_, i) => (i === 19 ? 'line twenty' : `line ${i + 1}`)).join('\n') + '\n');
  g(hist, ['commit', '-q', '-m', 'Edit long file', '--', 'long.txt']);
  try {
    await refreshUi();
    await pick('Edit long file');
    await fileRow('long.txt').click();
    await until(async () => (await page.getByTestId('diff-body').innerText()).includes('line twenty'), 'the diff');
    expect(!(await page.getByTestId('diff-body').innerText()).includes('line 12\n'), 'three lines of context at first');
    await page.getByTestId('expand-context').click();
    await until(async () => /line 10\b/.test(await page.getByTestId('diff-body').innerText()) && /line 30\b/.test(await page.getByTestId('diff-body').innerText()), 'ten more lines each side');
  } finally {
    g(hist, ['reset', '-q', '--soft', 'HEAD~2']);
    g(hist, ['reset', '-q', '--', 'long.txt']);
    rmSync(path.join(hist, 'long.txt'));
    await refreshUi();
  }
});

await check('history: F7 and F8 jump to the next and previous hunk', async () => {
  await ensureHist();
  // a file with three changes far apart: three hunks
  write(hist, 'far.txt', Array.from({ length: 120 }, (_, i) => `row ${i + 1}`).join('\n') + '\n');
  g(hist, ['add', 'far.txt']);
  g(hist, ['commit', '-q', '-m', 'Far file', '--', 'far.txt']);
  write(hist, 'far.txt', Array.from({ length: 120 }, (_, i) => ([5, 60, 115].includes(i) ? `changed ${i + 1}` : `row ${i + 1}`)).join('\n') + '\n');
  g(hist, ['commit', '-q', '-m', 'Edit far file', '--', 'far.txt']);
  try {
    await refreshUi();
    await pick('Edit far file');
    await fileRow('far.txt').click();
    await until(async () => (await page.getByTestId('hunk-toggle').count()) === 3, 'three hunks');
    const top = () => page.getByTestId('diff-body').evaluate((e) => e.scrollTop);
    const headTops = () => page.evaluate(() => {
      const box = document.querySelector('[data-testid="diff-body"]');
      const t = box.getBoundingClientRect().top;
      return [...box.querySelectorAll('[data-testid="hunk-toggle"]')].map((h) => Math.round(h.getBoundingClientRect().top - t));
    });
    expect((await top()) === 0, 'starts at the top');
    await page.keyboard.press('F7');
    await until(async () => Math.abs((await headTops())[1]) <= 1, 'F7: the second hunk at the top');
    await page.keyboard.press('F7');
    const max = await page.getByTestId('diff-body').evaluate((e) => e.scrollHeight - e.clientHeight);
    await until(async () => Math.abs((await headTops())[2]) <= 1 || (await top()) >= max - 1, 'F7 again: the third (or the end)');
    await page.keyboard.press('F8');
    await page.keyboard.press('F8');
    await until(async () => (await top()) === 0, 'F8 twice: back to the first');
    // the commit shown goes (reset below): HEAD is shown with its first file, not an empty diff
  } finally {
    g(hist, ['reset', '-q', '--soft', 'HEAD~2']);
    g(hist, ['reset', '-q', '--', 'far.txt']);
    rmSync(path.join(hist, 'far.txt'));
    await refreshUi();
  }
  await waitSelected('Local work');
  await until(async () => (await diffHeader().catch(() => '')).includes('docs/notes.md'), 'HEAD and its file');
});

await check('history: a merge lists what it brought in (its diff against the first parent)', async () => {
  await ensureHist();
  await pick("Merge branch 'topic'");
  await fileRow('topic.txt').waitFor({ timeout: 5000 });
  expect(/files\s*1/i.test(await page.getByTestId('commit-files-header').innerText()), 'one file');
});

await check('history: a commit with 400 files — the file filter narrows the list (beta, branch wide)', async () => {
  await ensureBeta();
  await page.waitForTimeout(600);
  await page.getByTestId('branch-wide').click();
  await waitSelected('Wide commit');
  await page.waitForFunction(() => /FILES\s*400/i.test(document.body.innerText), null, { timeout: 15000 });
  await page.getByPlaceholder('Filter files').fill('file39');
  await until(async () => (await page.locator('[data-testid^="file-commit-"]').count()) === 11, 'file39 and file390–399');
  await page.getByPlaceholder('Filter files').fill('nothing-like-this');
  await waitText('No matches');
  await page.getByPlaceholder('Filter files').fill('');
});

await check('history: a commit file\'s menu — Copy path, Open this version (the file as it is in that commit), Open in editor, Reveal; no Blame of a picture or a deleted file', async () => {
  await ensureHist();
  // the engine would open real apps: its answers are stood in for, the requests kept
  const opened = [];
  await page.route('**/api/system/**', async (route) => {
    opened.push({ url: route.request().url().replace(/^.*\/api\/system\//, ''), body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  try {
    await spyClipboard();
    await pick('Edit notes');
    await fileMenu('file-commit-notes.txt', 'Copy path');
    await until(async () => (await copied()).at(-1) === 'notes.txt', 'the path copied');
    await fileMenu('file-commit-notes.txt', `Open this version (${sha('main~6').slice(0, 7)})`);
    await until(() => opened.some((o) => o.url === 'open'), 'asked to open');
    const file = opened.find((o) => o.url === 'open').body.path;
    expect(readFileSync(file, 'utf8') === 'alpha\nBETA\ngamma\n', 'the version of that commit: ' + file);
    opened.length = 0;
    await fileMenu('file-commit-notes.txt', 'Open in editor');
    await until(() => opened.some((o) => o.url === 'open' && o.body.path === path.join(hist, 'notes.txt')), 'the working-copy path: ' + JSON.stringify(opened));
    await fileMenu('file-commit-notes.txt', 'Reveal in Finder');
    await until(() => opened.some((o) => o.url === 'reveal' && o.body.path === path.join(hist, 'notes.txt')), 'revealed: ' + JSON.stringify(opened));
    await pick('Add picture');
    await page.getByTestId('file-commit-picture.png').click({ button: 'right' });
    expect(await disabled(menuItem('Blame')), 'no blame of a picture');
    await page.keyboard.press('Escape');
    await pick('Remove main.txt');
    await page.getByTestId('file-commit-main.txt').click({ button: 'right' });
    expect(await disabled(menuItem('Blame')), 'no blame of a deleted file');
    expect(await disabled(menuItem(`Open this version (${sha('main~1').slice(0, 7)})`)), 'no version of a deleted file to open');
    await page.keyboard.press('Escape');
  } finally {
    await page.unroute('**/api/system/**');
  }
});

await check('history: a commit\'s files say "loading…" until they come, and an empty commit says it changes nothing', async () => {
  await ensureHist();
  // the engine answers the files slowly
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route('**/api/repo/commitFiles', async (route) => {
    await gate;
    await route.continue();
  });
  const empty = g(hist, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Nothing changed']).trim();
  g(hist, ['branch', 'empty-commit', empty]);
  try {
    await refreshUi();
    await page.waitForTimeout(600);
    await rowOf('Nothing changed').locator(SUBJ).first().click();
    await page.getByTestId('commit-files-loading').waitFor({ timeout: 3000 });
    expect(!/files\s*0/i.test(await page.getByTestId('commit-files-header').innerText()), 'not "0 files" while loading');
    expect(!(await page.getByText('No files', { exact: true }).count()), 'not "No files" while loading');
    release();
    await page.getByTestId('commit-no-changes').waitFor({ timeout: 5000 });
    expect((await page.getByTestId('commit-no-changes').innerText()).includes('changes no files'), 'says so');
  } finally {
    release();
    await page.unroute('**/api/repo/commitFiles');
    g(hist, ['branch', '-D', 'empty-commit']);
    await refreshUi();
  }
});

// ---------- merges ----------

const mergeRow = () => rowOf("Merge branch 'topic'");
await check('history: a merge folds from its node and unfolds from "(+N hidden)"; the count says how many are folded', async () => {
  await ensureHist();
  await mergeRow().getByLabel('Collapse merge').click();
  await until(async () => !(await subjects()).includes('Topic one') && !(await subjects()).includes('Topic two'), 'the branch hidden');
  expect((await mergeRow().innerText()).includes('(+2 hidden)'), 'the badge');
  expect((await countText()).includes('2 collapsed'), 'count: ' + (await countText()));
  await mergeRow().getByText('(+2 hidden)').click();
  await until(async () => (await subjects()).includes('Topic one'), 'unfolded');
});

await check('history: ← folds the selected merge and → unfolds it; ← on a plain commit folds nothing', async () => {
  await ensureHist();
  await pick("Merge branch 'topic'");
  await page.keyboard.press('ArrowLeft');
  await until(async () => !(await subjects()).includes('Topic one'), '← folded');
  await page.keyboard.press('ArrowRight');
  await until(async () => (await subjects()).includes('Topic one'), '→ unfolded');
  await pick('Main work');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  expect(!(await rowOf('Main work').getByLabel('Expand merge').count()) && !(await countText()).includes('collapsed'), 'a plain commit is no merge: ' + (await countText()));
  expect(await disabled(page.getByLabel('Expand all merges')), 'nothing to expand');
});

await check('history: Collapse all / Expand all merges — the buttons and the menu items', async () => {
  await ensureHist();
  await page.getByLabel('Collapse all merges').click();
  await until(async () => !(await subjects()).includes('Topic one'), 'all folded');
  expect(await disabled(page.getByLabel('Collapse all merges')), 'nothing more to fold');
  await page.getByLabel('Expand all merges').click();
  await until(async () => (await subjects()).includes('Topic one'), 'all unfolded');
  await (await menu("Merge branch 'topic'", 'Collapse all merges')).click();
  await until(async () => !(await subjects()).includes('Topic one'), 'folded from the menu');
  await (await menu("Merge branch 'topic'", 'Expand merge')).click();
  await until(async () => (await subjects()).includes('Topic one'), 'expanded from the menu');
  await (await menu("Merge branch 'topic'", 'Collapse merge')).click();
  await until(async () => !(await subjects()).includes('Topic one'), 'collapsed from the menu');
  await (await menu("Merge branch 'topic'", 'Expand all merges')).click();
  await until(async () => (await subjects()).includes('Topic one'), 'expanded all from the menu');
});

await check('history: a double click on a merge without branches folds it', async () => {
  await ensureHist();
  await page.waitForTimeout(600);
  await mergeRow().locator(SUBJ).first().dblclick();
  await until(async () => !(await subjects()).includes('Topic one'), 'folded by a double click');
  await page.waitForTimeout(600);
  await mergeRow().locator(SUBJ).first().dblclick();
  await until(async () => (await subjects()).includes('Topic one'), 'unfolded by another');
  expect(branch() === 'main', 'no checkout happened: ' + branch());
});

// ---------- the commit menu (in ops: these change history) ----------

const OPS_MAIN = og('rev-parse', 'main');
/** ops in front on All Commits, back on main at its first state, clean, nothing open */
const ensureOps = async () => {
  for (let i = 0; i < 3 && (await page.getByText('Cancel', { exact: true }).count()); i++) await page.keyboard.press('Escape');
  og('checkout', '-q', '-f', 'main');
  og('reset', '-q', '--hard', OPS_MAIN);
  og('clean', '-qfd');
  ogq('stash', 'clear');
  const keep = new Set(OPS_REFS.map(([r]) => r));
  for (const r of og('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags').split('\n')) if (r && !keep.has(r)) og('update-ref', '-d', r);
  for (const [r, at] of OPS_REFS) if (r !== 'refs/heads/main') og('update-ref', r, at);
  if (await page.getByTestId('tab-ops').count()) await page.getByTestId('tab-ops').click();
  else await openRepo('ops');
  await page.getByText('All Commits', { exact: true }).first().click();
  await refreshUi();
  await rowOf('Ops four').waitFor({ timeout: 10000 });
};
const menuItems = async (subject) => {
  await rowOf(subject).locator(SUBJ).first().click({ button: 'right' });
  await page.getByText('Copy message', { exact: true }).last().waitFor({ timeout: 3000 });
  const items = await page.evaluate(() => [...document.querySelectorAll('[data-testid="menu-item"]')].map((e) => ({ label: (e.firstElementChild?.firstElementChild ?? e).textContent.trim(), disabled: e.getAttribute('aria-disabled') === 'true' })));
  await page.keyboard.press('Escape');
  return items;
};
const undo = async (label) => {
  await until(async () => (await undoLabel()).includes(label), `Undo offers "${label}": ${await undoLabel()}`);
  await page.getByTestId('undo-button').click();
};

await check('history: the commit menu — every item on a commit, the ones that make no sense on HEAD disabled', async () => {
  await ensureOps();
  const two = og('rev-parse', 'main~3');
  const items = await menuItems('Ops two');
  const want = [`Checkout ${two.slice(0, 7)} (detached)`, 'Create branch here…', 'Create tag…', 'Cherry-pick', 'Revert', 'Reset main to here…', 'Rebase main onto here', 'Interactive rebase from here…', 'Copy SHA', 'Copy message'];
  expect(JSON.stringify(items.map((i) => i.label)) === JSON.stringify(want), 'items: ' + JSON.stringify(items.map((i) => i.label)));
  expect(items.every((i) => !i.disabled), 'all enabled on an older commit: ' + JSON.stringify(items.filter((i) => i.disabled)));
  const onHead = await menuItems('Ops four');
  const off = onHead.filter((i) => i.disabled).map((i) => i.label);
  expect(JSON.stringify(off) === JSON.stringify(['Cherry-pick', 'Reset main to here…', 'Rebase main onto here', 'Interactive rebase from here…']), 'disabled on HEAD: ' + JSON.stringify(off));
  const merge = await menuItems('Merge mside');
  expect(merge.slice(0, 3).map((i) => i.label).join('|') === 'Collapse merge|Collapse all merges|Expand all merges', 'a merge starts with folding: ' + JSON.stringify(merge.map((i) => i.label)));
});

await check('history: a right-click selects the commit its menu is for', async () => {
  await ensureOps();
  await pick('Ops four');
  await rowOf('Ops two').locator(SUBJ).first().click({ button: 'right' });
  await waitSelected('Ops two');
  expect((await details()).includes('Ops two'), 'the details follow');
  await page.keyboard.press('Escape');
});

await check('history: Copy SHA, Copy message and ⌘⇧C copy what they say', async () => {
  await ensureOps();
  await spyClipboard();
  await (await menu('Ops three', 'Copy SHA')).click();
  await until(async () => (await copied()).at(-1) === og('rev-parse', 'main~1'), 'the full sha');
  await (await menu('Ops three', 'Copy message')).click();
  await until(async () => (await copied()).at(-1) === 'Ops three', 'the message');
  await pick('Ops two');
  await page.keyboard.press('Meta+Shift+c');
  await until(async () => (await copied()).at(-1) === og('rev-parse', 'main~3'), '⌘⇧C copies the selected sha: ' + JSON.stringify(await copied()));
});

await check('history: Checkout (detached) moves HEAD to the commit; Undo goes back to main', async () => {
  await ensureOps();
  const three = og('rev-parse', 'main~1');
  await (await menu('Ops three', `Checkout ${three.slice(0, 7)} (detached)`)).click();
  await until(() => og('rev-parse', 'HEAD') === three && og('rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD', 'detached at Ops three');
  await until(async () => /detached/i.test(await statusText()), 'the status says detached: ' + (await statusText()));
  await page.getByTestId('head-commit').getByText('Ops three', { exact: true }).waitFor({ timeout: 5000 });
  await undo('Checkout');
  await until(() => og('rev-parse', '--abbrev-ref', 'HEAD') === 'main', 'back on main');
});

await check('history: Create branch here… — the dialog names the commit, checks the name, Escape cancels, Enter creates, Undo removes', async () => {
  await ensureOps();
  const two = og('rev-parse', 'main~3');
  await (await menu('Ops two', 'Create branch here…')).click();
  const dlg = page.getByTestId('branch-dialog');
  await dlg.waitFor({ timeout: 3000 });
  expect((await dlg.innerText()).includes(two.slice(0, 7)) && (await dlg.innerText()).includes('Ops two'), 'from: the commit: ' + (await dlg.innerText()));
  const name = dlg.getByPlaceholder('feature/…');
  await name.fill('bad name');
  await dlg.getByText('Invalid branch name', { exact: true }).waitFor({ timeout: 2000 });
  expect(await disabled(page.getByTestId('branch-create')), 'Create disabled for a bad name');
  await name.fill('feature');
  await dlg.getByTestId('branch-exists').waitFor({ timeout: 2000 });
  expect(await disabled(page.getByTestId('branch-create')), 'Create disabled for a name that exists');
  await name.fill('from-two');
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached', timeout: 3000 });
  expect(!og('branch', '--list', 'from-two'), 'Escape created nothing');
  await (await menu('Ops two', 'Create branch here…')).click();
  await dlg.getByPlaceholder('feature/…').fill('from-two');
  await dlg.getByText('Checkout new branch', { exact: true }).click();
  await dlg.getByPlaceholder('feature/…').press('Enter');
  await until(() => ogq('rev-parse', '-q', '--verify', 'refs/heads/from-two') === two, 'from-two at Ops two');
  expect(og('rev-parse', '--abbrev-ref', 'HEAD') === 'main', 'not checked out (the box was unticked)');
  await rowOf('Ops two').getByTestId('ref-from-two').waitFor({ timeout: 5000 });
  await undo('Create branch from-two');
  await until(() => !ogq('branch', '--list', 'from-two'), 'Undo deleted it');
});

await check('history: Create branch here… with Checkout ticked switches to the new branch', async () => {
  await ensureOps();
  await (await menu('Ops three', 'Create branch here…')).click();
  const dlg = page.getByTestId('branch-dialog');
  await dlg.getByPlaceholder('feature/…').fill('at-three');
  await dlg.getByText('Create', { exact: true }).click();
  await until(() => og('rev-parse', '--abbrev-ref', 'HEAD') === 'at-three' && og('rev-parse', 'HEAD') === og('rev-parse', 'main~1'), 'on at-three at Ops three');
});

await check('history: Create tag… — lightweight, annotated with the message typed, a bad name refused, Enter creates', async () => {
  await ensureOps();
  const three = og('rev-parse', 'main~1');
  await (await menu('Ops three', 'Create tag…')).click();
  const dlg = page.getByTestId('tag-dialog');
  await dlg.waitFor({ timeout: 3000 });
  expect((await dlg.innerText()).includes(three.slice(0, 7)) && (await dlg.innerText()).includes('Ops three'), 'at: the commit');
  const name = dlg.getByPlaceholder('v1.1.0');
  await name.fill('bad tag');
  await dlg.getByTestId('tag-invalid').waitFor({ timeout: 2000 });
  expect(await disabled(page.getByTestId('tag-go')), 'Create disabled for a bad name');
  await name.fill('local-only');
  await dlg.getByTestId('tag-exists').waitFor({ timeout: 2000 });
  await name.fill('v-notes');
  await dlg.getByTestId('tag-message').fill('Release notes\nsecond line');
  await dlg.getByText('Create tag', { exact: true }).click();
  await until(() => ogq('cat-file', '-t', 'v-notes') === 'tag', 'an annotated tag');
  expect(og('tag', '-l', '--format=%(contents)', 'v-notes').startsWith('Release notes\nsecond line'), 'its message is the one typed: ' + og('tag', '-l', '--format=%(contents)', 'v-notes'));
  expect(og('rev-parse', 'v-notes^{commit}') === three, 'on Ops three');
  // lightweight, by Enter in the name field
  await (await menu('Ops two', 'Create tag…')).click();
  await dlg.getByText('Annotated tag', { exact: true }).click();
  await dlg.getByPlaceholder('v1.1.0').fill('v-light');
  await dlg.getByPlaceholder('v1.1.0').press('Enter');
  await until(() => ogq('tag', '-l', 'v-light') === 'v-light', 'Enter created it');
  expect(og('cat-file', '-t', 'v-light') === 'commit', 'lightweight: ' + og('cat-file', '-t', 'v-light'));
  await rowOf('Ops two').getByTestId('ref-v-light').waitFor({ timeout: 5000 });
});

await check('history: Create tag… with "Push tag" pushes that tag only, to the remote', async () => {
  await ensureOps();
  await (await menu('Ops two', 'Create tag…')).click();
  const dlg = page.getByTestId('tag-dialog');
  await dlg.getByPlaceholder('v1.1.0').fill('v-pushed');
  await dlg.getByTestId('tag-push').click();
  await dlg.getByText('Create tag', { exact: true }).click();
  const remoteTags = () => og('ls-remote', '--tags', 'origin');
  await until(() => remoteTags().includes('refs/tags/v-pushed'), 'the tag is on origin', 15000);
  expect(!remoteTags().includes('local-only'), 'the other local tag stayed local: ' + remoteTags());
  og('push', '-q', 'origin', ':refs/tags/v-pushed');
});

await check('history: Cherry-pick puts the commit on the current branch; Undo takes it back', async () => {
  await ensureOps();
  await (await menu('Feature work', 'Cherry-pick')).click();
  await until(() => og('log', '-1', '--format=%s') === 'Feature work' && og('rev-parse', 'HEAD~1') === OPS_MAIN, 'picked onto main');
  await rowOf('Feature work').first().waitFor();
  await undo('Cherry-pick');
  await until(() => og('rev-parse', 'HEAD') === OPS_MAIN, 'undone');
});

await check('history: Cherry-pick of a merge takes what it brought in (its first parent as the mainline)', async () => {
  await ensureOps();
  await (await menu('Merge pm-side', 'Cherry-pick')).click();
  await until(() => og('rev-parse', 'HEAD~1') === OPS_MAIN, 'a new commit on main', 10000);
  expect(og('show', '--name-only', '--format=', 'HEAD') === 'p.txt', 'it brought p.txt: ' + og('show', '--name-only', '--format=', 'HEAD'));
  expect(!(await page.getByTestId('error-dialog').count()), 'no error');
});

await check('history: Revert makes the commit that undoes it; Undo takes that back', async () => {
  await ensureOps();
  await (await menu('Ops three', 'Revert')).click();
  await until(() => og('log', '-1', '--format=%s') === 'Revert "Ops three"', 'a revert commit');
  expect(og('show', 'HEAD:a.txt') === 'a1', 'a.txt back as before Ops three');
  await undo('Revert');
  await until(() => og('rev-parse', 'HEAD') === OPS_MAIN, 'undone');
});

await check('history: Revert of a merge undoes what it brought in', async () => {
  await ensureOps();
  await (await menu('Merge mside', 'Revert')).click();
  await until(() => og('log', '-1', '--format=%s').startsWith('Revert "Merge mside"'), 'a revert commit', 10000);
  expect(!og('ls-tree', '--name-only', 'HEAD').split('\n').includes('m.txt'), 'm.txt is gone');
});

await check('history: Reset main to here… — mixed by default, Escape cancels, Enter resets, Undo goes back', async () => {
  await ensureOps();
  const two = og('rev-parse', 'main~3');
  await (await menu('Ops two', 'Reset main to here…')).click();
  const dlg = page.getByTestId('reset-dialog');
  await dlg.waitFor({ timeout: 3000 });
  expect((await dlg.innerText()).includes(two.slice(0, 7)) && (await dlg.innerText()).includes('Ops two'), 'names the commit');
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached', timeout: 3000 });
  expect(og('rev-parse', 'HEAD') === OPS_MAIN, 'Escape changed nothing');
  await (await menu('Ops two', 'Reset main to here…')).click();
  await dlg.waitFor();
  await page.keyboard.press('Enter');
  await until(() => og('rev-parse', 'HEAD') === two, 'reset by Enter');
  expect(og('status', '--porcelain').includes('b.txt'), 'mixed: the changes stay in the working copy: ' + og('status', '--porcelain'));
  await undo('Reset (mixed)');
  await until(() => og('rev-parse', 'HEAD') === OPS_MAIN && !og('status', '--porcelain'), 'back, clean');
});

await check('history: Reset (hard) drops the commits and the changes', async () => {
  await ensureOps();
  const three = og('rev-parse', 'main~1');
  await (await menu('Ops three', 'Reset main to here…')).click();
  const dlg = page.getByTestId('reset-dialog');
  await dlg.getByText('Hard', { exact: true }).click();
  await dlg.getByText('Reset', { exact: true }).click();
  await until(() => og('rev-parse', 'HEAD') === three && !og('status', '--porcelain'), 'hard reset');
});

await check('history: Rebase onto a commit without a branch rebases onto it and leaves no stray branch behind', async () => {
  await ensureOps();
  og('checkout', '-q', 'feature');
  const featureWas = og('rev-parse', 'feature');
  try {
    await refreshUi();
    await (await menu('Ops three', 'Rebase feature onto here')).click();
    const dlg = page.getByTestId('rebase-dialog');
    await dlg.waitFor({ timeout: 3000 });
    expect((await dlg.innerText()).includes(`${og('rev-parse', 'main~1').slice(0, 7)} (commit)`), 'onto the commit clicked: ' + (await dlg.innerText()));
    expect((await dlg.innerText()).includes('1 commit will be replayed'), 'one commit to replay');
    await page.getByTestId('rebase-run').click();
    await until(() => og('rev-parse', 'feature~1') === og('rev-parse', 'main~1'), 'feature sits on Ops three', 10000);
    const branches = og('branch', '--format=%(refname:short)');
    expect(!/__tmp_/.test(branches), 'no temporary branch: ' + branches);
  } finally {
    og('checkout', '-q', '-f', 'main');
    og('branch', '-f', 'feature', featureWas);
    for (const b of og('branch', '--format=%(refname:short)').split('\n')) if (b.startsWith('__tmp_')) og('branch', '-D', b);
  }
});

await check('history: Interactive rebase from here… lists the commits it would replay, oldest first; Cancel leaves it', async () => {
  await ensureOps();
  await (await menu('Merge mside', 'Interactive rebase from here…')).click();
  await page.getByText('Interactive rebase', { exact: true }).first().waitFor({ timeout: 3000 });
  const t = await page.evaluate(() => document.body.innerText);
  const i3 = t.indexOf('Ops three');
  const i4 = t.lastIndexOf('Ops four');
  expect(i3 > 0 && i4 > i3, 'Ops three then Ops four');
  await page.getByText('Cancel', { exact: true }).last().click();
  expect(og('rev-parse', 'HEAD') === OPS_MAIN, 'nothing happened');
});

// ---------- file history ----------

await check('history: File history of a commit\'s file — the bar names it, the list holds the commits that changed it, across its rename', async () => {
  await ensureHist();
  await pick('Local work');
  await fileMenu('file-commit-docs/notes.md', 'File history');
  await page.getByTestId('file-history-bar').waitFor({ timeout: 5000 });
  await until(async () => /History of docs\/notes\.md · 4 commits/.test(await page.getByTestId('file-history-bar').innerText()), 'the bar: ' + (await page.getByTestId('file-history-bar').innerText()));
  await shows(['Local work', 'Rename notes', 'Edit notes', 'Add notes'], 'the commits of docs/notes.md (and notes.txt before)');
  expect(/^4 of 4 commits/.test((await countText()).trim()), 'count: ' + (await countText()));
});

await check('history: in a file history every commit shows that file\'s diff, under the name it had then', async () => {
  // (continues the file history above)
  if (!(await page.getByTestId('file-history-bar').count())) {
    await ensureHist();
    await pick('Local work');
    await fileMenu('file-commit-docs/notes.md', 'File history');
    await page.getByTestId('file-history-bar').waitFor();
  }
  await pick('Edit notes');
  await until(async () => /notes\.txt/.test(await diffHeader()), 'Edit notes shows notes.txt (not README.md): ' + (await diffHeader().catch(() => '')));
  expect((await page.getByTestId('diff-body').innerText()).includes('BETA'), 'its diff');
  await pick('Rename notes');
  await until(async () => (await diffHeader()).includes('notes.txt → docs/notes.md'), 'the rename');
  await pick('Local work');
  await until(async () => (await diffHeader()).includes('docs/notes.md'), 'and back');
});

await check('history: Close leaves the file history and the whole list comes back', async () => {
  if (!(await page.getByTestId('file-history-bar').count())) {
    await ensureHist();
    await pick('Local work');
    await fileMenu('file-commit-docs/notes.md', 'File history');
    await page.getByTestId('file-history-bar').waitFor();
  }
  await page.getByTestId('file-history-close').click();
  await page.getByTestId('file-history-bar').waitFor({ state: 'detached', timeout: 3000 });
  await until(async () => (await subjects()).length === ALL + 1, 'all commits again');
});

await check('history: File history of a working-copy file (from Changes) runs from HEAD', async () => {
  await ensureHist();
  await page.getByText('Changes', { exact: true }).first().click();
  await fileMenu('file-unstaged-README.md', 'File history');
  await page.getByTestId('file-history-bar').waitFor({ timeout: 5000 });
  await shows(['Edit notes', 'Initial commit'], 'README.md was changed by Edit notes and the first commit');
  await page.getByTestId('file-history-close').click();
});

// ---------- blame ----------

const blameText = () => page.getByTestId('blame-view').innerText();
await check('history: Blame of a commit\'s file — every line with its commit and author; the header counts lines and authors', async () => {
  await ensureHist();
  await pick('Local work');
  await fileMenu('file-commit-docs/notes.md', 'Blame');
  await page.getByTestId('blame-view').waitFor({ timeout: 5000 });
  await until(async () => /4 lines · 2 authors/.test(await page.getByTestId('blame-counts').innerText()), 'counts: ' + (await page.getByTestId('blame-counts').innerText()));
  const l2 = await page.getByTestId('blame-line-2').innerText();
  expect(l2.includes(sha('main~6').slice(0, 7)) && l2.includes('Bob Builder') && l2.includes('BETA'), 'line 2 by Bob in Edit notes: ' + l2);
  const l4 = await page.getByTestId('blame-line-4').innerText();
  expect(l4.includes(sha('main').slice(0, 7)) && l4.includes('Alice Liddell') && l4.includes('delta'), 'line 4 by Alice in Local work: ' + l4);
});

await check('history: a click on a blame line selects that line\'s commit and closes the blame', async () => {
  if (!(await page.getByTestId('blame-view').count())) {
    await ensureHist();
    await pick('Local work');
    await fileMenu('file-commit-docs/notes.md', 'Blame');
    await page.getByTestId('blame-line-2').waitFor({ timeout: 5000 });
  }
  await page.getByTestId('blame-line-2').getByText(sha('main~6').slice(0, 7), { exact: true }).click();
  await waitSelected('Edit notes');
  await page.getByTestId('blame-view').waitFor({ state: 'detached', timeout: 3000 });
});

await check('history: picking another commit or file while the blame shows brings the diff back; Close closes it', async () => {
  await ensureHist();
  await pick('Edit notes');
  await fileMenu('file-commit-notes.txt', 'Blame');
  await page.getByTestId('blame-view').waitFor({ timeout: 5000 });
  await fileRow('README.md').click();
  await page.getByTestId('blame-view').waitFor({ state: 'detached', timeout: 3000 });
  expect((await diffHeader()).includes('README.md'), 'the diff of the file clicked');
  await fileMenu('file-commit-notes.txt', 'Blame');
  await page.getByTestId('blame-view').waitFor({ timeout: 5000 });
  await pick('Add notes');
  await page.getByTestId('blame-view').waitFor({ state: 'detached', timeout: 3000 });
  await fileMenu('file-commit-notes.txt', 'Blame');
  await page.getByTestId('blame-close').click();
  await page.getByTestId('blame-view').waitFor({ state: 'detached', timeout: 3000 });
});

await check('history: blame of a changed working-copy file marks the lines not committed yet; a click there opens Changes', async () => {
  await ensureHist();
  await page.getByText('Changes', { exact: true }).first().click();
  await fileMenu('file-unstaged-README.md', 'Blame');
  await page.getByTestId('blame-line-4').waitFor({ timeout: 5000 });
  const l4 = await page.getByTestId('blame-line-4').innerText();
  expect(/not yet/i.test(l4) && /uncommitted/i.test(l4) && l4.includes('work in progress') && !l4.includes('0000000'), 'line 4 is not committed: ' + l4);
  expect(/^4 lines · 2 authors · 1 not committed yet$/.test((await page.getByTestId('blame-counts').innerText()).trim()), 'the not-committed line counts no author: ' + (await page.getByTestId('blame-counts').innerText()));
  await page.getByTestId('blame-line-4').getByLabel('Not committed yet: open Changes').click();
  await page.getByTestId('blame-view').waitFor({ state: 'detached', timeout: 3000 });
  expect(!(await page.getByTestId('commit-scroll').count()), 'in Changes');
});

await check('history: a blame line from deep in the history is read and selected (beta: src.txt from its first commit)', async () => {
  await freshBeta();
  await page.getByText('Changes', { exact: true }).first().click();
  await fileMenu('file-unstaged-src.txt', 'Blame');
  await page.getByTestId('blame-line-1').waitFor({ timeout: 10000 });
  await page.getByTestId('blame-line-1').locator('div[aria-label^="Go to"]').first().click();
  await waitSelected('Initial commit', 15000);
  expect((await details()).includes('Initial commit'), 'its details');
});

// ---------- a stash in the details ----------

await check('history: a stash in the details — its message, files and diff; Branch from stash makes a branch with its changes', async () => {
  await ensureOps();
  write(ops, 'a.txt', 'a1\na2\nstashed line\n');
  og('stash', 'push', '-q', '-m', 'ops stash');
  try {
    await refreshUi();
    // the stash's own commits are no commits of the history
    const listed = await subjects();
    expect(!listed.some((x) => /ops stash|^index on |^untracked files on /.test(x)), 'no stash commits in the list: ' + JSON.stringify(listed));
    const row = page.getByTestId('group-stashes').getByText('On main: ops stash', { exact: true });
    if (!(await row.count())) await page.getByTestId('group-stashes').getByText('Stashes', { exact: true }).click();
    await row.first().click();
    await page.getByTestId('stash-branch').waitFor({ timeout: 5000 });
    expect((await details()).includes('stash@{0}'), 'which stash');
    await page.getByTestId('file-stash-a.txt').click();
    await until(async () => (await page.getByTestId('diff-body').innerText()).includes('stashed line'), 'the stash diff');
    await page.getByTestId('stash-branch').click();
    const dlg = page.getByTestId('branch-dialog');
    await dlg.waitFor();
    expect((await dlg.innerText()).includes('stash@{0}'), 'the dialog says it is from the stash: ' + (await dlg.innerText()));
    await dlg.getByPlaceholder('feature/…').fill('from-stash');
    await dlg.getByPlaceholder('feature/…').press('Enter');
    await until(() => og('rev-parse', '--abbrev-ref', 'HEAD') === 'from-stash', 'on the new branch');
    expect(og('rev-parse', 'HEAD') === OPS_MAIN, 'where the stash was made');
    expect(og('diff', '--name-only') === 'a.txt' && !og('stash', 'list'), 'its changes in the working copy, the stash dropped');
  } finally {
    og('checkout', '-q', '-f', 'main');
    ogq('stash', 'clear');
  }
});

await check('history: "Uncommitted changes (N)" counts a file staged and changed again once', async () => {
  await ensureOps();
  write(ops, 'a.txt', 'a1\na2\nstaged\n');
  og('add', 'a.txt');
  write(ops, 'a.txt', 'a1\na2\nstaged\nand more\n');
  write(ops, 'new.txt', 'new\n');
  await refreshUi();
  await until(async () => (await page.getByTestId('commit-row-wip').innerText().catch(() => '')).includes('Uncommitted changes (2)'), 'two files: ' + (await page.getByTestId('commit-row-wip').innerText().catch(() => '')));
});

await check('history: a repository without commits says "No commits yet" and still shows its uncommitted files', async () => {
  const dir = path.join(root, 'no-commits');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(path.join(dir, 'first.txt'), 'first\n');
  for (const ws of ['work', 'home']) await post('/api/scan', { path: root, depth: 1, register: true, workspace: ws });
  await page.reload({ waitUntil: 'load' });
  // the session brings its tabs back first (a repository opened before that would lose its tab)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="tab-"]').length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await openRepo('no-commits');
  await page.getByText('All Commits', { exact: true }).first().click();
  await page.getByTestId('commits-empty').waitFor({ timeout: 10000 });
  expect((await page.getByTestId('commits-empty').innerText()) === 'No commits yet.', 'says so: ' + (await page.getByTestId('commits-empty').innerText()));
  expect((await page.getByTestId('commit-row-wip').innerText()).includes('Uncommitted changes (1)'), 'the new file');
  expect(/^0 of 0 commits$/.test((await countText()).trim()), 'count: ' + (await countText()));
  expect(!(await page.evaluate(() => document.body.innerText.toLowerCase().includes('failed'))), 'no error');
});

// ---------- layout ----------

await check('history: in a narrow window the columns shrink without overlapping, long subjects are cut, labels stay on their row', async () => {
  await ensureHist();
  // a commit with a long subject and labels, on a branch of its own (no working-copy change)
  const long = 'A very long subject that says a lot about what this commit does, far more than fits in a narrow window';
  const at = g(hist, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', long]).trim();
  g(hist, ['branch', 'feature/with-a-rather-long-name', at]);
  g(hist, ['tag', 'v9.9.9-long-tag', at]);
  await page.setViewportSize({ width: 1000, height: 700 });
  try {
    await refreshUi();
    await rowOf(long).waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    const boxes = await page.evaluate(() => {
      const head = document.querySelector('[data-testid="commit-header"]');
      const cell = (t) => [...head.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.toLowerCase() === t)?.getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-testid^="commit-row-"]')].map((r) => {
        const subj = r.querySelector('[data-testid="commit-subject"], [data-testid="head-commit"], [data-testid="off-branch-commit"]');
        const leaves = [...r.querySelectorAll('div')].filter((d) => d.children.length === 0 && d.textContent.trim());
        return { top: r.getBoundingClientRect().top, bottom: r.getBoundingClientRect().bottom, subj: subj?.getBoundingClientRect(), leaves: leaves.map((d) => ({ t: d.textContent, ...JSON.parse(JSON.stringify(d.getBoundingClientRect())) })) };
      });
      return { author: cell('author'), date: cell('date'), sha: cell('sha'), width: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth, rows };
    });
    expect(boxes.scrollW <= boxes.width, 'no horizontal page scroll');
    expect(boxes.author && boxes.date && boxes.sha && boxes.author.right <= boxes.date.left + 1 && boxes.date.right <= boxes.sha.left + 1 && boxes.sha.right <= boxes.width, 'header columns in order: ' + JSON.stringify([boxes.author, boxes.date, boxes.sha]));
    for (const r of boxes.rows) {
      if (r.subj) expect(r.subj.right <= boxes.author.left + 2, `subject cut before the author column: ${JSON.stringify(r.subj)}`);
      for (const l of r.leaves) expect(l.top >= r.top - 1 && l.bottom <= r.bottom + 1, `"${l.t}" stays in its row`);
    }
    await shot('narrow');
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
    g(hist, ['branch', '-D', 'feature/with-a-rather-long-name']);
    g(hist, ['tag', '-d', 'v9.9.9-long-tag']);
    await refreshUi();
  }
});

await check('history: no page errors in the whole run', async () => {
  expect(pageErrors.length === 0, 'errors: ' + pageErrors.slice(0, 5).join(' | '));
});

await finish('history');
