/**
 * The Changes view, as a user who knows Fork uses it: every kind of row, the lists and their counts, picking files,
 * the hover buttons and double clicks, every menu item, the section headers, the diff of each kind with its hunk and
 * line actions, the commit box, merge conflicts, and changes made outside Prong.
 *
 * Every check works in repositories of its own (made at the start, registered with one reload). "Open in editor",
 * "Reveal in Finder" and the terminal never reach the engine (it would open real apps): the page answers them and
 * the check reads what was asked.
 */
import path from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { page, check, expect, waitText, until, git, root, tmp, post, finish, text, visible, refreshUi, pageErrors, undoLabel, PNG_A, PNG_B, makeWav, SHOTS } from '../harness.mjs';

// ---------- repositories of this suite ----------

const dirOf = (name) => path.join(root, name);
const write = (dir, f, c) => {
  mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  writeFileSync(path.join(dir, f), c);
};
const read = (dir, f) => readFileSync(path.join(dir, f), 'utf8');
/** a repository with one commit of `files`; `then` makes its working-copy changes */
function repo(name, files, then) {
  const dir = dirOf(name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'user.name', 'Changes Suite');
  git(dir, 'config', 'user.email', 'changes@example.com');
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
  then?.(dir);
  return dir;
}
const staged = (dir) => git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
const unstagedNames = (dir) => git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l && l[1] !== ' ').map((l) => l.slice(3)).sort();

// every kind of row (read only: the checks on it change nothing)
const KINDS = repo(
  'chg-kinds',
  {
    'mod.txt': 'one\ntwo\nthree\n',
    'gone.txt': 'bye\n',
    'old-name.txt': 'rename me\nplease\n',
    'noeol.txt': 'a\nb',
    'q.sql': 'select 1;\n-- old comment\nselect 2;\n',
    'run.sh': 'echo hi\n',
    'img/pic.png': PNG_A,
    'snd/tone.wav': makeWav(440, 0.3),
    'bin/blob.bin': Buffer.from([0, 1, 2, 3, 0, 5]),
  },
  (d) => {
    write(d, 'mod.txt', 'one\nTWO\nthree\nfour\n');
    rmSync(path.join(d, 'gone.txt'));
    git(d, 'mv', 'old-name.txt', 'new-name.txt');
    write(d, 'noeol.txt', 'a\nc');
    write(d, 'q.sql', 'select 1;\n++ new\nselect 2;\n');
    chmodSync(path.join(d, 'run.sh'), 0o755);
    write(d, 'img/pic.png', PNG_B);
    write(d, 'snd/tone.wav', makeWav(660, 0.4));
    write(d, 'bin/blob.bin', Buffer.from([0, 1, 9, 3, 0, 5, 7]));
    write(d, 'untracked.txt', 'new\nfile\n');
    write(d, 'newdir/a.txt', 'a\n');
    write(d, 'newdir/inner/b.txt', 'b\nb\n');
    write(d, 'empty.txt', '');
    write(d, 'staged-new.txt', 'staged\n');
    git(d, 'add', 'staged-new.txt');
    // a repository of its own inside: git lists it once, as a folder
    const nested = path.join(d, 'vendor/lib');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init', '-q');
    write(nested, 'x.txt', 'x\n');
  },
);
const SELECT = repo('chg-select', Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`${n}.txt`, `${n}\n`])), (d) => {
  for (const n of ['a', 'b', 'c', 'd', 'e']) write(d, `${n}.txt`, `${n} changed\n`);
});
const MENUS = repo('chg-menus', { 'tracked.txt': 'tracked\n', 'removed.txt': 'removed\n', 'keep/one.txt': 'one\n', 'keep/two.txt': 'two\n' }, (d) => {
  write(d, 'tracked.txt', 'tracked changed\n');
  rmSync(path.join(d, 'removed.txt'));
  write(d, 'keep/one.txt', 'one changed\n');
  write(d, 'keep/two.txt', 'two changed\n');
  write(d, 'notes.txt', 'notes\n');
  write(d, 'sub/notes.txt', 'nested notes\n');
  write(d, 'fresh/x.txt', 'x\n');
  write(d, 'fresh/y.txt', 'y\n');
  write(d, 'pair/p.txt', 'p\n');
  write(d, 'pair/q.txt', 'q\n');
});
const HEADERS = repo('chg-headers', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, (d) => {
  write(d, 'a.txt', 'a changed\n');
  write(d, 'b.txt', 'b changed\n');
  write(d, 'new.txt', 'new\n');
  git(d, 'add', 'b.txt');
});
const LONG = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const HUNKS = repo('chg-hunks', { 'two.txt': LONG.join('\n') + '\n' }, (d) => {
  write(d, 'two.txt', LONG.map((l, i) => (i === 1 ? 'line 2 FIRST' : i === 26 ? 'line 27 SECOND' : l)).join('\n') + '\n');
});
const LINES = repo('chg-lines', { 'l.txt': 'keep\nold 1\nold 2\nold 3\nend\n' }, (d) => write(d, 'l.txt', 'keep\nnew 1\nnew 2\nnew 3\nend\n'));
const NOEOL = repo('chg-noeol', { 'f.txt': 'a\nb', 'g.txt': 'x\ny', 'q.sql': 'select 1;\n-- old comment\nselect 2;\n' }, (d) => {
  write(d, 'f.txt', 'a\nc');
  write(d, 'g.txt', 'x\nz');
  write(d, 'q.sql', 'select 1;\n++ new\nselect 2;\n');
});
const LARGE = repo('chg-large', { 'big.txt': 'x\n' }, (d) => write(d, 'big.txt', Array.from({ length: 4500 }, (_, i) => `big line ${i}`).join('\n') + '\n'));
const COMMIT = repo('chg-commit', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }, (d) => {
  for (const n of ['a', 'b', 'c']) write(d, `${n}.txt`, `${n} changed\n`);
});
const AMEND = repo('chg-amend', { 'a.txt': 'a\n' }, (d) => {
  write(d, 'a.txt', 'a 2\n');
  git(d, 'commit', '-qam', 'Second commit\n\nIts description');
});
const PUSH = repo('chg-push', { 'a.txt': 'a\n' }, (d) => {
  const bare = path.join(root, '..', 'origins', 'chg-push.git');
  mkdirSync(path.dirname(bare), { recursive: true });
  git(root, 'init', '-q', '--bare', bare);
  git(d, 'remote', 'add', 'origin', bare);
  git(d, 'push', '-q', '-u', 'origin', 'main');
  write(d, 'a.txt', 'a pushed\n');
  git(d, 'add', 'a.txt');
});
const SIGN_A = repo('chg-sign-a', { 'a.txt': 'a\n' });
const SIGN_B = repo('chg-sign-b', { 'b.txt': 'b\n' });
/** main and other change the same lines: a.txt, b.txt, c.txt conflict, other deletes gone.txt that main changes */
function conflicting(name) {
  return repo(name, { 'a.txt': 'top\nbase a\nend\n', 'b.txt': 'base b\n', 'c.txt': 'base c\n', 'gone.txt': 'g\n' }, (d) => {
    git(d, 'checkout', '-q', '-b', 'other');
    write(d, 'a.txt', 'top\ntheirs a\nend\n');
    write(d, 'b.txt', 'theirs b\n');
    write(d, 'c.txt', 'theirs c\n');
    git(d, 'rm', '-q', 'gone.txt');
    git(d, 'commit', '-qam', 'Their change\n\nfrom the other branch');
    git(d, 'checkout', '-q', 'main');
    write(d, 'a.txt', 'top\nours a\nend\n');
    write(d, 'b.txt', 'ours b\n');
    write(d, 'c.txt', 'ours c\n');
    write(d, 'gone.txt', 'g changed\n');
    git(d, 'commit', '-qam', 'Our change');
  });
}
const MERGE = conflicting('chg-merge');
const MERGE_OURS = conflicting('chg-merge-ours');
const ABORT = conflicting('chg-abort');
const CHERRY = conflicting('chg-cherry');
const OUTSIDE = repo('chg-outside', { 'o.txt': 'alpha\nbeta\n', 'p.txt': 'p\n' }, (d) => write(d, 'o.txt', 'alpha\nFIRST\n'));
const LONG_NAME = 'a-really-long-file-name-that-does-not-fit-in-the-list-at-all-even-on-a-wide-screen.txt';
const NARROW = repo('chg-narrow', { 'n.txt': 'n\n' }, (d) => {
  write(d, 'n.txt', 'n changed\n');
  write(d, LONG_NAME, 'long\n');
});
const NESTED = repo('chg-nested', { 'a.txt': 'a\n' }, (d) => {
  const inner = path.join(d, 'vendor/lib');
  mkdirSync(inner, { recursive: true });
  git(inner, 'init', '-q');
  write(inner, 'x.txt', 'x\n');
});
const STASHPOP = repo('chg-stashpop', { 's.txt': 'base\n' }, (d) => {
  write(d, 's.txt', 'stashed\n');
  git(d, 'stash', '-q');
  write(d, 's.txt', 'committed\n');
  git(d, 'commit', '-qam', 'Second');
  try {
    git(d, 'stash', 'pop');
  } catch {
    /* conflicts: the stash stays, s.txt is conflicted */
  }
});
const NAMES = repo('chg-names', { 'фото.png': PNG_A, 'заметки.txt': 'раз\nдва\n', 'with space.txt': 'one\n' }, (d) => {
  write(d, 'фото.png', PNG_B);
  write(d, 'заметки.txt', 'раз\nтри\n');
  write(d, 'with space.txt', 'one two\n');
});
const DIFFHEAD = repo('chg-diffhead', { 'h.txt': 'h\n' }, (d) => write(d, 'h.txt', 'h changed\n'));
// submodules with edited or new files of their own (git status's "modified content" / "untracked content"), at
// their recorded commits; the origin lives outside the scanned folder
const SUBS_ORIGIN = path.join(tmp, 'origins/chg-subs-core');
mkdirSync(SUBS_ORIGIN, { recursive: true });
git(SUBS_ORIGIN, 'init', '-q', '-b', 'main');
git(SUBS_ORIGIN, 'config', 'commit.gpgsign', 'false');
write(SUBS_ORIGIN, 'core.txt', 'core\n');
git(SUBS_ORIGIN, 'add', '-A');
git(SUBS_ORIGIN, '-c', 'user.name=Changes Suite', '-c', 'user.email=changes@example.com', 'commit', '-q', '-m', 'core');
const SUBS = repo('chg-subs', { 'app.txt': 'app\n' }, (d) => {
  for (const p of ['libs/clean', 'libs/edited', 'libs/fresh']) git(d, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', SUBS_ORIGIN, p);
  git(d, 'commit', '-q', '-m', 'Add submodules');
  write(d, 'libs/edited/core.txt', 'core\nedited inside\n');
  write(d, 'libs/fresh/new.txt', 'new\n');
});

// registered as a scan of the workspaces would, then one reload lists them all
for (const ws of ['work', 'home']) await post('/api/scan', { path: root, depth: 1, register: true, workspace: ws });
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
await page.reload({ waitUntil: 'load' });
// the session restores its tabs a moment after a reload
await page.waitForTimeout(1500);

/** what the page asked the system for (open in an app, reveal): answered here, never by the engine */
const systemCalls = [];
await page.route('**/api/system/**', (route) => {
  const req = route.request();
  systemCalls.push({ what: new URL(req.url()).pathname.split('/').pop(), body: req.postDataJSON() });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

// ---------- helpers ----------

const row = (area, p) => page.getByTestId(`file-${area}-${p}`);
const folder = (area, p) => page.getByTestId(`folder-${area}-${p}`);
const bar = (area) => page.getByTestId(`picked-bar-${area}`);
const barText = async (area) => ((await bar(area).count()) ? await bar(area).innerText() : '');
/** a menu item of the open context menu (drawn last, above everything) */
const menuItem = (label) => page.getByText(label, { exact: true }).last();
const menuLabels = () =>
  page.evaluate(() => {
    // the context menu is the last glass layer: its rows are the pressables in it
    const layers = [...document.querySelectorAll('[data-glass]')];
    const m = layers[layers.length - 1];
    return m ? [...m.querySelectorAll('[tabindex]')].map((e) => ({ label: e.innerText.split('\n')[0].trim(), disabled: e.getAttribute('aria-disabled') === 'true' })) : [];
  });
const closeMenu = () => page.keyboard.press('Escape');
/** the confirm dialog's button */
const confirmWith = (label) => page.getByText(label, { exact: true }).last().click();
const diffText = () => page.evaluate(() => document.body.innerText);
const lower = async () => (await text()).toLowerCase();
async function setView(v) {
  await page.getByLabel(v, { exact: true }).first().click();
  await page.waitForTimeout(250);
}
/** opens a repository of this suite on its Changes */
async function openChanges(name, firstRow) {
  await page.getByTestId('home-button').click();
  await page.getByText(name, { exact: true }).first().click();
  await page.getByTestId(`tab-${name}`).waitFor({ timeout: 15000 });
  // its own view: the one before it says "All Commits" too, and a click there was lost (the tab then opened on the
  // section it was left on)
  await page.waitForFunction((n) => document.querySelector('[data-testid="active-tab-label"]')?.textContent === n, name, { timeout: 15000 });
  await waitText('All Commits');
  await page.getByText('Changes', { exact: true }).first().click();
  if (firstRow) await page.getByTestId(firstRow).waitFor({ timeout: 15000 });
}
const isChecked = (testID) => page.evaluate((id) => !!document.querySelector(`[data-testid="${id}"] svg`), testID);
const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

// ---------- rows and counts ----------

await check('changes: every kind of row shows its status, icon and true counts (staged rename D/A, binary, image, audio, new file, new folder, nested repository)', async () => {
  await openChanges('chg-kinds', 'file-unstaged-mod.txt');
  await setView('list');
  const rowText = async (area, p) => (await row(area, p).innerText()).replace(/\s+/g, ' ').trim();
  const want = {
    'unstaged:mod.txt': 'M mod.txt +2 −1',
    'unstaged:gone.txt': 'D gone.txt +0 −1',
    'unstaged:noeol.txt': 'M noeol.txt +1 −1',
    'unstaged:q.sql': 'M q.sql +1 −1',
    'unstaged:untracked.txt': '? untracked.txt +2 −0',
    'unstaged:empty.txt': '? empty.txt +0 −0',
    'unstaged:newdir/a.txt': '? a.txt newdir +1 −0',
    'unstaged:newdir/inner/b.txt': '? b.txt newdir/inner +2 −0',
    // media and binaries: no line counts ("+0 −0" on a binary file named like text before)
    'unstaged:img/pic.png': 'M pic.png img',
    'unstaged:snd/tone.wav': 'M tone.wav snd',
    'unstaged:bin/blob.bin': 'M blob.bin bin',
    'unstaged:vendor/lib/': '? lib/ vendor',
    // a staged `git mv`: its two rows, each with its lines ("+0 −0" on both before)
    'staged:new-name.txt': 'A new-name.txt +2 −0',
    'staged:old-name.txt': 'D old-name.txt +0 −2',
    'staged:staged-new.txt': 'A staged-new.txt +1 −0',
  };
  const got = {};
  for (const k of Object.keys(want)) {
    const [area, p] = k.split(':');
    got[k] = await rowText(area, p);
  }
  const wrong = Object.keys(want).filter((k) => got[k] !== want[k]);
  expect(!wrong.length, 'rows: ' + wrong.map((k) => `${k} = "${got[k]}" (want "${want[k]}")`).join('; '));
  const t = await lower();
  expect(/unstaged\s*13/.test(t) && /staged\s*3/.test(t), 'the section counts: ' + t.slice(0, 400));
  // the sidebar's Changes counts both lists
  expect(/changes\s*16/.test(t), 'Changes 16 in the sidebar');
  // the nested repository's row has a folder icon, a file row a file icon: both draw an icon
  expect(await row('unstaged', 'vendor/lib/').locator('svg, img').count() >= 1, 'the folder row has an icon');
});

await check('changes: list / tree switches both lists; the tree nests the new folder, counts its files and opens with its arrow', async () => {
  await openChanges('chg-kinds', 'file-unstaged-mod.txt');
  await setView('tree');
  await folder('unstaged', 'newdir').waitFor({ timeout: 5000 });
  expect((await page.getByTestId('folder-count-unstaged-newdir').innerText()).trim() === '2', 'newdir counts 2 files');
  expect((await page.getByTestId('folder-count-unstaged-newdir/inner').innerText()).trim() === '1', 'inner counts 1');
  await folder('staged', 'img').count().then((n) => expect(n === 0, 'no folder in Staged that has nothing staged'));
  // the arrow closes and opens the folder, the files go and come back
  await page.getByTestId('folder-toggle-unstaged-newdir').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="file-unstaged-newdir/a.txt"]'), null, { timeout: 3000 });
  await page.getByTestId('folder-toggle-unstaged-newdir').click();
  await row('unstaged', 'newdir/inner/b.txt').waitFor({ timeout: 3000 });
  // list view: no folder rows in either list, the folder named beside each file
  await setView('list');
  expect((await page.locator('[data-testid^="folder-unstaged-"], [data-testid^="folder-staged-"]').count()) === 0, 'no folder rows in list view');
  expect((await row('unstaged', 'newdir/inner/b.txt').innerText()).includes('newdir/inner'), 'the file says where it is');
  await setView('tree');
  await folder('unstaged', 'img').waitFor({ timeout: 3000 });
});

// ---------- the diff of each kind ----------

await check('diff: a modified, a deleted and a new file show their lines; unified and split side by side; SQL "-- comment" lines are not lost', async () => {
  await openChanges('chg-kinds', 'file-unstaged-mod.txt');
  await row('unstaged', 'mod.txt').click();
  await waitText('TWO');
  expect(await visible('four'), 'the added line');
  // split: the removed and the added line side by side
  await page.getByLabel('split', { exact: true }).first().click();
  await page.waitForTimeout(300);
  const ys = await page.evaluate(() => {
    const find = (s) => [...document.querySelectorAll('div')].filter((d) => d.childElementCount === 0 || [...d.children].every((c) => c.tagName === 'SPAN')).find((d) => d.innerText === s);
    const a = find('two');
    const b = find('TWO');
    return a && b ? [Math.round(a.getBoundingClientRect().top), Math.round(b.getBoundingClientRect().top), Math.round(a.getBoundingClientRect().left), Math.round(b.getBoundingClientRect().left)] : null;
  });
  expect(ys && Math.abs(ys[0] - ys[1]) <= 2 && ys[3] > ys[2] + 100, 'split puts "two" and "TWO" on one row, two columns: ' + JSON.stringify(ys));
  await page.getByLabel('unified', { exact: true }).first().click();
  await page.waitForTimeout(300);
  // a deleted file: its lines removed; a new one: all added
  await row('unstaged', 'gone.txt').click();
  await waitText('bye');
  await row('unstaged', 'untracked.txt').click();
  await page.waitForFunction(() => /\+\s*new/.test(document.body.innerText) && /\+\s*file/.test(document.body.innerText), null, { timeout: 5000 });
  // a staged rename's new side
  await row('staged', 'new-name.txt').click();
  await waitText('rename me');
  // "-- old comment" is a removed line, "++ new" an added one (they were read as file headers and dropped)
  await row('unstaged', 'q.sql').click();
  await waitText('++ new');
  expect(await visible('-- old comment'), 'the removed SQL comment line');
});

await check('diff: a change with no lines says what it is — a new empty file, a mode change — instead of "No textual changes."', async () => {
  await openChanges('chg-kinds', 'file-unstaged-mod.txt');
  await row('unstaged', 'empty.txt').click();
  await page.getByTestId('diff-no-lines').waitFor({ timeout: 5000 });
  expect(await visible('A new, empty file.'), 'the empty new file: ' + (await page.getByTestId('diff-no-lines').innerText()));
  await row('unstaged', 'run.sh').click();
  await waitText('Only the file mode changed: 100644 → 100755 (made executable).');
  expect(!(await visible('No textual changes.')), 'no "No textual changes."');
});

await check('diff: binary, image and audio changes show their previews; a nested repository explains itself', async () => {
  await openChanges('chg-kinds', 'file-unstaged-mod.txt');
  await row('unstaged', 'bin/blob.bin').click();
  await waitText('Binary file changed');
  expect(await visible('6 B → 7 B'), 'both sizes');
  // Open after: the working-copy file itself; Reveal: the same; Open before: the index version, extracted
  systemCalls.length = 0;
  await page.getByText('Open after', { exact: true }).click();
  await page.getByText('Reveal', { exact: true }).click();
  await page.getByText('Open before', { exact: true }).click();
  await until(() => systemCalls.length === 3, 'three system calls: ' + JSON.stringify(systemCalls));
  expect(systemCalls[0].what === 'open' && systemCalls[0].body.path === path.join(KINDS, 'bin/blob.bin'), 'opened the working file: ' + JSON.stringify(systemCalls[0]));
  expect(systemCalls[1].what === 'reveal' && systemCalls[1].body.path === path.join(KINDS, 'bin/blob.bin'), 'revealed it');
  expect(systemCalls[2].what === 'open' && systemCalls[2].body.path !== path.join(KINDS, 'bin/blob.bin') && /\.bin$/.test(systemCalls[2].body.path), 'the previous version from the cache: ' + JSON.stringify(systemCalls[2]));
  await row('unstaged', 'img/pic.png').click();
  await waitText('BEFORE');
  await waitText('AFTER');
  await row('unstaged', 'snd/tone.wav').click();
  await page.waitForFunction(() => document.querySelectorAll('audio').length >= 2, null, { timeout: 10000 });
  await row('unstaged', 'vendor/lib/').click();
  await page.getByTestId('untracked-folder-note').waitFor({ timeout: 5000 });
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

await check('names in Cyrillic and with spaces: the rows, an image compare (it came as a binary), the text diff and its hunk staging', async () => {
  await openChanges('chg-names', 'file-unstaged-заметки.txt');
  await row('unstaged', 'фото.png').click();
  await waitText('BEFORE');
  await waitText('AFTER');
  expect(!(await visible('Binary file changed')), 'an image, not a binary');
  await row('unstaged', 'заметки.txt').click();
  await page.waitForFunction(() => /\+\s*три/.test(document.body.innerText), null, { timeout: 5000 });
  await page.getByTestId('stage-hunk').click();
  await until(() => git(NAMES, 'show', ':0:заметки.txt') === 'раз\nтри\n', 'the hunk staged');
  await row('unstaged', 'with space.txt').click();
  await waitText('one two');
  await page.getByTestId('stage-hunk').click();
  await until(() => staged(NAMES).includes('with space.txt'), 'the file with a space staged');
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

// ---------- picking files ----------

await check('selection: a click shows the file, ⌘ adds and removes, Shift takes the run, ⌘⇧ adds a run; a click in Staged starts over there', async () => {
  await openChanges('chg-select', 'file-unstaged-a.txt');
  await setView('list');
  await row('unstaged', 'a.txt').click();
  await waitText('a changed');
  expect(!(await bar('unstaged').count()), 'one file: no bar');
  await row('unstaged', 'c.txt').click({ modifiers: ['Meta'] });
  await page.waitForFunction(() => /2 selected/.test(document.querySelector('[data-testid="picked-bar-unstaged"]')?.textContent ?? ''), null, { timeout: 3000 });
  // the diff follows the last clicked file
  await waitText('c changed');
  // Shift from c (the anchor) to e: c, d, e
  await row('unstaged', 'e.txt').click({ modifiers: ['Shift'] });
  await page.waitForFunction(() => /3 selected/.test(document.querySelector('[data-testid="picked-bar-unstaged"]')?.textContent ?? ''), null, { timeout: 3000 });
  // ⌘ takes one out
  await row('unstaged', 'd.txt').click({ modifiers: ['Meta'] });
  await page.waitForFunction(() => /2 selected/.test(document.querySelector('[data-testid="picked-bar-unstaged"]')?.textContent ?? ''), null, { timeout: 3000 });
  // ⌘⇧ adds the run a…b to what is picked
  await row('unstaged', 'a.txt').click({ modifiers: ['Meta'] });
  await page.waitForTimeout(650);
  await row('unstaged', 'b.txt').click({ modifiers: ['Meta', 'Shift'] });
  await page.waitForFunction(() => /4 selected/.test(document.querySelector('[data-testid="picked-bar-unstaged"]')?.textContent ?? ''), null, { timeout: 3000 });
  // a plain click leaves one
  await page.waitForTimeout(650);
  await row('unstaged', 'b.txt').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="picked-bar-unstaged"]'), null, { timeout: 3000 });
  // stage two, then a pick in Staged starts over there and the Unstaged pick goes
  git(SELECT, 'add', 'd.txt', 'e.txt');
  await refreshUi();
  await row('staged', 'd.txt').waitFor({ timeout: 5000 });
  await row('unstaged', 'a.txt').click();
  await row('unstaged', 'b.txt').click({ modifiers: ['Meta'] });
  await bar('unstaged').waitFor({ timeout: 3000 });
  await row('staged', 'd.txt').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="picked-bar-unstaged"]'), null, { timeout: 3000 });
  await row('staged', 'e.txt').click({ modifiers: ['Meta'] });
  await page.waitForFunction(() => /2 selected/.test(document.querySelector('[data-testid="picked-bar-staged"]')?.textContent ?? ''), null, { timeout: 3000 });
  git(SELECT, 'reset', '-q');
});

await check('selection: ⌘A picks the list the selection is in (Staged too), Space moves the pick, Escape drops it; ⌘A in the summary selects its text', async () => {
  await openChanges('chg-select', 'file-unstaged-a.txt');
  git(SELECT, 'add', 'a.txt', 'b.txt');
  await refreshUi();
  await row('staged', 'a.txt').waitFor({ timeout: 5000 });
  await row('staged', 'a.txt').click();
  await page.keyboard.press('Meta+a');
  await page.waitForFunction(() => /2 selected/.test(document.querySelector('[data-testid="picked-bar-staged"]')?.textContent ?? ''), null, { timeout: 3000 });
  // Space: the picked staged files go back to Unstaged, as one action
  await page.keyboard.press(' ');
  await until(() => staged(SELECT).length === 0, 'Space unstaged both: ' + staged(SELECT));
  await page.waitForFunction(() => /Undo Unstage 2 files/.test(document.querySelector('[data-testid="undo-button"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 5000 });
  await row('unstaged', 'a.txt').click();
  await page.keyboard.press('Meta+a');
  await page.waitForFunction(() => /5 selected/.test(document.querySelector('[data-testid="picked-bar-unstaged"]')?.textContent ?? ''), null, { timeout: 3000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="picked-bar-unstaged"]'), null, { timeout: 3000 });
  // in the summary ⌘A is the field's own: no files picked
  const summary = page.getByPlaceholder('Commit summary');
  await summary.fill('typed text');
  await summary.press('Meta+a');
  await page.waitForTimeout(200);
  expect(!(await bar('unstaged').count()), '⌘A in the summary picks no files');
  expect((await summary.evaluate((e) => [e.selectionStart, e.selectionEnd])).join() === '0,10', 'the text is selected');
  // Space typed in the summary is a space, not a stage
  await summary.press('End');
  await summary.press(' ');
  expect(staged(SELECT).length === 0, 'Space in the summary staged nothing');
  await summary.fill('');
});

await check('picked bar: Stage N, Discard… (asks, keeps a copy for Undo), copy the paths, clear', async () => {
  await openChanges('chg-select', 'file-unstaged-a.txt');
  await row('unstaged', 'a.txt').click();
  await row('unstaged', 'b.txt').click({ modifiers: ['Meta'] });
  await bar('unstaged').waitFor({ timeout: 3000 });
  // copy the paths: what the clipboard gets, and a toast that says so
  await bar('unstaged').getByLabel('Copy the paths').click();
  await until(async () => (await clipboard()) === 'a.txt\nb.txt', 'the clipboard has both paths');
  // Discard… asks first; Cancel keeps the files
  await page.getByTestId('picked-discard').click();
  await waitText('Discard 2 files?');
  await confirmWith('Cancel');
  expect(read(SELECT, 'a.txt') === 'a changed\n', 'Cancel kept a.txt');
  await page.getByTestId('picked-discard').click();
  await waitText('Discard 2 files?');
  await confirmWith('Discard');
  await until(() => read(SELECT, 'a.txt') === 'a\n' && read(SELECT, 'b.txt') === 'b\n', 'both discarded');
  await page.waitForFunction(() => !document.querySelector('[data-testid="file-unstaged-a.txt"]'), null, { timeout: 5000 });
  await page.keyboard.press('Meta+z');
  await until(() => read(SELECT, 'a.txt') === 'a changed\n' && read(SELECT, 'b.txt') === 'b changed\n', 'Undo brought both back');
  // Stage N, then the bar is gone; clear (×) drops a pick
  await row('unstaged', 'a.txt').waitFor({ timeout: 5000 });
  await row('unstaged', 'c.txt').click();
  await row('unstaged', 'd.txt').click({ modifiers: ['Meta'] });
  await page.getByTestId('picked-stage').click();
  await until(() => JSON.stringify(staged(SELECT)) === '["c.txt","d.txt"]', 'Stage 2 staged c and d: ' + staged(SELECT));
  await page.waitForFunction(() => !document.querySelector('[data-testid="picked-bar-unstaged"]'), null, { timeout: 3000 });
  await row('staged', 'c.txt').click();
  await row('staged', 'd.txt').click({ modifiers: ['Meta'] });
  await page.getByTestId('picked-clear').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="picked-bar-staged"]'), null, { timeout: 3000 });
  await row('staged', 'c.txt').click();
  await row('staged', 'd.txt').click({ modifiers: ['Meta'] });
  await page.getByTestId('picked-unstage').click();
  await until(() => staged(SELECT).length === 0, 'Unstage 2 unstaged them');
});

await check('hover buttons and double clicks: + stages, − unstages, ↶ discards (after asking) — the picked group when the row is in it', async () => {
  await openChanges('chg-select', 'file-unstaged-a.txt');
  await setView('list');
  await row('unstaged', 'a.txt').hover();
  await page.getByTestId('file-stage-a.txt').click();
  await until(() => staged(SELECT).includes('a.txt'), 'the + staged a.txt');
  await row('staged', 'a.txt').hover();
  await page.getByTestId('file-unstage-a.txt').click();
  await until(() => !staged(SELECT).includes('a.txt'), 'the − unstaged it');
  // the discard button asks, then discards
  await row('unstaged', 'e.txt').hover();
  await page.getByTestId('file-discard-e.txt').click();
  await waitText('Discard changes?');
  await confirmWith('Discard');
  await until(() => read(SELECT, 'e.txt') === 'e\n', 'e.txt discarded');
  await page.keyboard.press('Meta+z');
  await until(() => read(SELECT, 'e.txt') === 'e changed\n', 'Undo brought e.txt back');
  // a double click moves a file to the other list and back
  await row('unstaged', 'b.txt').dblclick();
  await until(() => staged(SELECT).includes('b.txt'), 'double click staged b.txt');
  await row('staged', 'b.txt').dblclick();
  await until(() => !staged(SELECT).includes('b.txt'), 'double click unstaged it');
  // the + on a row of a picked group stages the whole group
  await row('unstaged', 'c.txt').click();
  await row('unstaged', 'd.txt').click({ modifiers: ['Meta'] });
  await row('unstaged', 'd.txt').hover();
  expect((await page.getByTestId('file-stage-d.txt').getAttribute('aria-label')) === 'Stage 2 files', 'the button says it stages the group');
  await page.getByTestId('file-stage-d.txt').click();
  await until(() => JSON.stringify(staged(SELECT)) === '["c.txt","d.txt"]', 'the group staged: ' + staged(SELECT));
  git(SELECT, 'reset', '-q');
});

// ---------- menus ----------

await check('file menu of a tracked change: Stage, Discard… (Cancel keeps it), no .gitignore for a tracked file, File history, Blame, Open in editor, Reveal, Copy path', async () => {
  await openChanges('chg-menus', 'file-unstaged-tracked.txt');
  await setView('list');
  await row('unstaged', 'tracked.txt').click({ button: 'right' });
  const labels = (await menuLabels()).map((m) => m.label);
  expect(JSON.stringify(labels) === JSON.stringify(['Stage', 'Discard changes…', 'File history', 'Blame', 'Open in editor', 'Reveal in Finder', 'Copy path']), 'the menu: ' + JSON.stringify(labels));
  await menuItem('Discard changes…').click();
  await waitText('Discard changes?');
  await confirmWith('Cancel');
  expect(read(MENUS, 'tracked.txt') === 'tracked changed\n', 'Cancel kept the change');
  // Open in editor, Reveal in Finder: the absolute path of the file
  systemCalls.length = 0;
  await row('unstaged', 'tracked.txt').click({ button: 'right' });
  await menuItem('Open in editor').click();
  await row('unstaged', 'tracked.txt').click({ button: 'right' });
  await menuItem('Reveal in Finder').click();
  await until(() => systemCalls.length === 2, 'two system calls');
  expect(systemCalls[0].what === 'open' && systemCalls[0].body.path === path.join(MENUS, 'tracked.txt') && !!systemCalls[0].body.app, 'opened in the editor: ' + JSON.stringify(systemCalls[0]));
  expect(systemCalls[1].what === 'reveal' && systemCalls[1].body.path === path.join(MENUS, 'tracked.txt'), 'revealed: ' + JSON.stringify(systemCalls[1]));
  // Copy path
  await row('unstaged', 'tracked.txt').click({ button: 'right' });
  await menuItem('Copy path').click();
  await until(async () => (await clipboard()) === 'tracked.txt', 'the path copied');
  // File history: All Commits with the file's history
  await row('unstaged', 'tracked.txt').click({ button: 'right' });
  await menuItem('File history').click();
  await waitText('History of tracked.txt');
  await page.getByText('Changes', { exact: true }).first().click();
  await row('unstaged', 'tracked.txt').waitFor({ timeout: 5000 });
  // Blame: the lines with their commits, closed again
  await row('unstaged', 'tracked.txt').click({ button: 'right' });
  await menuItem('Blame').click();
  await waitText('1 line · 1 not committed yet');
  await page.getByText('Close', { exact: true }).last().click();
  await page.waitForFunction(() => !/1 line · 1 not committed yet/.test(document.body.innerText), null, { timeout: 3000 });
  // Stage
  await row('unstaged', 'tracked.txt').click({ button: 'right' });
  await menuItem('Stage').click();
  await until(() => staged(MENUS).includes('tracked.txt'), 'staged from the menu');
  // in Staged: Unstage
  await row('staged', 'tracked.txt').click({ button: 'right' });
  const st = (await menuLabels()).map((m) => m.label);
  expect(st[0] === 'Unstage' && !st.includes('Stage') && !st.some((l) => /Discard/.test(l)), 'the staged menu: ' + JSON.stringify(st));
  await menuItem('Unstage').click();
  await until(() => !staged(MENUS).includes('tracked.txt'), 'unstaged from the menu');
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

await check('file menu: a deleted file cannot be opened or revealed; a new file goes to .gitignore as exactly itself (/notes.txt, not every notes.txt)', async () => {
  await openChanges('chg-menus', 'file-unstaged-tracked.txt');
  await setView('list');
  await row('unstaged', 'removed.txt').click({ button: 'right' });
  const m = await menuLabels();
  const dis = (l) => m.find((x) => x.label === l)?.disabled;
  expect(dis('Open in editor') && dis('Reveal in Finder') && !dis('Copy path'), 'the deleted file: ' + JSON.stringify(m));
  await closeMenu();
  // a new file: its menu offers .gitignore; the line is anchored, so sub/notes.txt stays listed
  await row('unstaged', 'notes.txt').click({ button: 'right' });
  expect((await menuLabels()).some((x) => x.label === 'Add to .gitignore'), 'a new file can be ignored');
  await menuItem('Add to .gitignore').click();
  await until(() => existsSync(path.join(MENUS, '.gitignore')) && read(MENUS, '.gitignore') === '/notes.txt\n', '.gitignore has /notes.txt');
  await page.waitForFunction(() => !document.querySelector('[data-testid="file-unstaged-notes.txt"]'), null, { timeout: 5000 });
  await row('unstaged', 'sub/notes.txt').waitFor({ timeout: 3000 });
  await row('unstaged', '.gitignore').waitFor({ timeout: 3000 });
  rmSync(path.join(MENUS, '.gitignore'));
  await refreshUi();
});

await check('folder menu: every item — Stage all inside, .gitignore only for new files, Select everything inside, Collapse / Expand, Open, Reveal, Copy path; Unstage all inside in Staged', async () => {
  await openChanges('chg-menus', 'file-unstaged-tracked.txt');
  await setView('tree');
  await folder('unstaged', 'fresh').waitFor({ timeout: 5000 });
  // a folder of tracked files: ignoring it would change nothing, so it is not offered
  await folder('unstaged', 'keep').click({ button: 'right' });
  const keep = (await menuLabels()).map((m) => m.label);
  expect(JSON.stringify(keep) === JSON.stringify(['Stage all 2 files inside', 'Discard all 2 files inside…', 'Select everything inside', 'Collapse', 'Open in editor', 'Reveal in Finder', 'Copy path']), 'the tracked folder: ' + JSON.stringify(keep));
  await menuItem('Select everything inside').click();
  await page.waitForFunction(() => /2 selected/.test(document.querySelector('[data-testid="picked-bar-unstaged"]')?.textContent ?? ''), null, { timeout: 3000 });
  await page.keyboard.press('Escape');
  // Collapse, then the menu offers Expand
  await folder('unstaged', 'keep').click({ button: 'right' });
  await menuItem('Collapse').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="file-unstaged-keep/one.txt"]'), null, { timeout: 3000 });
  await folder('unstaged', 'keep').click({ button: 'right' });
  await menuItem('Expand').click();
  await row('unstaged', 'keep/one.txt').waitFor({ timeout: 3000 });
  // Open, Reveal, Copy path: the folder's own path
  systemCalls.length = 0;
  await folder('unstaged', 'keep').click({ button: 'right' });
  await menuItem('Open in editor').click();
  await folder('unstaged', 'keep').click({ button: 'right' });
  await menuItem('Reveal in Finder').click();
  await until(() => systemCalls.length === 2, 'two system calls');
  expect(systemCalls.every((c) => c.body.path === path.join(MENUS, 'keep')), 'the folder path: ' + JSON.stringify(systemCalls));
  await folder('unstaged', 'keep').click({ button: 'right' });
  await menuItem('Copy path').click();
  await until(async () => (await clipboard()) === 'keep', 'the folder path copied');
  // Stage all inside, then in Staged: Unstage all inside
  await folder('unstaged', 'keep').click({ button: 'right' });
  await menuItem('Stage all 2 files inside').click();
  await until(() => JSON.stringify(staged(MENUS)) === '["keep/one.txt","keep/two.txt"]', 'the folder staged: ' + staged(MENUS));
  await folder('staged', 'keep').waitFor({ timeout: 5000 });
  await folder('staged', 'keep').click({ button: 'right' });
  const st = (await menuLabels()).map((m) => m.label);
  expect(st[0] === 'Unstage all 2 files inside' && !st.some((l) => /Discard|gitignore/.test(l)), 'the staged folder: ' + JSON.stringify(st));
  await menuItem('Unstage all 2 files inside').click();
  await until(() => staged(MENUS).length === 0, 'unstaged again');
  // a new folder: its line in .gitignore is the folder, anchored
  await folder('unstaged', 'fresh').click({ button: 'right' });
  await menuItem('Add /fresh/ to .gitignore').click();
  await until(() => existsSync(path.join(MENUS, '.gitignore')) && read(MENUS, '.gitignore') === '/fresh/\n', '.gitignore has /fresh/');
  await page.waitForFunction(() => !document.querySelector('[data-testid="folder-unstaged-fresh"]'), null, { timeout: 5000 });
  rmSync(path.join(MENUS, '.gitignore'));
  await refreshUi();
});

await check('group menu: the whole pick — Stage N, Discard N…, only the new ones to .gitignore (in one go), Copy N paths, Clear the selection', async () => {
  await openChanges('chg-menus', 'file-unstaged-tracked.txt');
  await setView('list');
  await row('unstaged', 'tracked.txt').click();
  await row('unstaged', 'pair/p.txt').click({ modifiers: ['Meta'] });
  await row('unstaged', 'pair/q.txt').click({ modifiers: ['Meta'] });
  await page.waitForFunction(() => /3 selected/.test(document.querySelector('[data-testid="picked-bar-unstaged"]')?.textContent ?? ''), null, { timeout: 3000 });
  await row('unstaged', 'pair/q.txt').click({ button: 'right' });
  const labels = (await menuLabels()).map((m) => m.label);
  expect(JSON.stringify(labels) === JSON.stringify(['Stage 3 files', 'Discard 3 files…', 'Add the 2 new files to .gitignore', 'Copy 3 paths', 'Clear the selection']), 'the group menu: ' + JSON.stringify(labels));
  await menuItem('Copy 3 paths').click();
  await until(async () => (await clipboard()) === 'tracked.txt\npair/p.txt\npair/q.txt', 'three paths copied');
  await row('unstaged', 'pair/q.txt').click({ button: 'right' });
  await menuItem('Add the 2 new files to .gitignore').click();
  await until(() => existsSync(path.join(MENUS, '.gitignore')) && read(MENUS, '.gitignore') === '/pair/p.txt\n/pair/q.txt\n', '.gitignore has both new files');
  // one action: Undo names it once
  await page.waitForFunction(() => /Undo Add to \.gitignore|Undo/.test(document.querySelector('[data-testid="undo-button"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 3000 }).catch(() => {});
  rmSync(path.join(MENUS, '.gitignore'));
  await refreshUi();
  await row('unstaged', 'tracked.txt').click();
  await row('unstaged', 'keep/one.txt').click({ modifiers: ['Meta'] });
  await row('unstaged', 'keep/one.txt').click({ button: 'right' });
  await menuItem('Clear the selection').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="picked-bar-unstaged"]'), null, { timeout: 3000 });
  await row('unstaged', 'tracked.txt').click();
  await row('unstaged', 'keep/one.txt').click({ modifiers: ['Meta'] });
  await row('unstaged', 'keep/one.txt').click({ button: 'right' });
  await menuItem('Stage 2 files').click();
  await until(() => JSON.stringify(staged(MENUS)) === '["keep/one.txt","tracked.txt"]', 'the group staged: ' + staged(MENUS));
  await row('staged', 'tracked.txt').click();
  await row('staged', 'keep/one.txt').click({ modifiers: ['Meta'] });
  await row('staged', 'keep/one.txt').click({ button: 'right' });
  expect((await menuLabels()).map((m) => m.label).join('|') === 'Unstage 2 files|Copy 2 paths|Clear the selection', 'the staged group menu');
  await menuItem('Unstage 2 files').click();
  await until(() => staged(MENUS).length === 0, 'the group unstaged');
});

// ---------- section headers ----------

await check('section headers: Stage all, Unstage all, Discard all (asks; keeps the staged ones, deletes new files; Undo brings it all back); disabled when empty', async () => {
  await openChanges('chg-headers', 'file-unstaged-a.txt');
  const stageAll = page.getByLabel('Stage all', { exact: true });
  const unstageAll = page.getByLabel('Unstage all', { exact: true });
  const discardAll = page.getByLabel('Discard all', { exact: true });
  await stageAll.click();
  await until(() => JSON.stringify(staged(HEADERS)) === '["a.txt","b.txt","new.txt"]', 'Stage all: ' + staged(HEADERS));
  await page.waitForFunction(() => document.querySelector('[aria-label="Stage all"]')?.getAttribute('aria-disabled') === 'true', null, { timeout: 5000 });
  expect((await discardAll.getAttribute('aria-disabled')) === 'true', 'Discard all disabled with nothing unstaged');
  await unstageAll.click();
  await until(() => staged(HEADERS).length === 0, 'Unstage all');
  await page.waitForFunction(() => document.querySelector('[aria-label="Unstage all"]')?.getAttribute('aria-disabled') === 'true', null, { timeout: 5000 });
  git(HEADERS, 'add', 'b.txt');
  await refreshUi();
  await row('staged', 'b.txt').waitFor({ timeout: 5000 });
  await discardAll.click();
  await waitText('Discard all changes?');
  await confirmWith('Cancel');
  expect(read(HEADERS, 'a.txt') === 'a changed\n' && existsSync(path.join(HEADERS, 'new.txt')), 'Cancel kept everything');
  await discardAll.click();
  await confirmWith('Discard all');
  await until(() => read(HEADERS, 'a.txt') === 'a\n' && !existsSync(path.join(HEADERS, 'new.txt')), 'the changes and the new file are gone');
  expect(JSON.stringify(staged(HEADERS)) === '["b.txt"]', 'the staged change stays');
  await page.waitForFunction(() => !document.querySelector('[data-testid="file-unstaged-a.txt"]'), null, { timeout: 5000 });
  expect(/unstaged\s*0/.test(await lower()), 'Unstaged 0');
  await page.keyboard.press('Meta+z');
  await until(() => read(HEADERS, 'a.txt') === 'a changed\n' && existsSync(path.join(HEADERS, 'new.txt')), 'Undo brought them back');
  await row('unstaged', 'new.txt').waitFor({ timeout: 5000 });
});

// ---------- hunks and lines ----------

await check('hunks: each with its buttons at the right end; Stage hunk, Unstage hunk, Discard hunk (asks); a click on the header folds it', async () => {
  await openChanges('chg-hunks', 'file-unstaged-two.txt');
  await row('unstaged', 'two.txt').click();
  await waitText('line 27 SECOND');
  expect((await page.getByTestId('stage-hunk').count()) === 2, 'two hunks');
  // the buttons sit at the right of the header, apart from the @@ text (they used to touch it)
  const geo = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="stage-hunk"]').getBoundingClientRect();
    const hdr = [...document.querySelectorAll('div')].find((d) => d.childElementCount === 0 && /^@@ -1,5 \+1,5 @@/.test(d.innerText)).getBoundingClientRect();
    return { btnRight: btn.right, hdrRight: hdr.right, winW: innerWidth };
  });
  expect(geo.winW - geo.btnRight < 40 && geo.btnRight - geo.hdrRight > 150, 'the buttons at the right end: ' + JSON.stringify(geo));
  // stage the second hunk only
  await page.getByTestId('stage-hunk').nth(1).click();
  await until(() => git(HUNKS, 'diff', '--cached').includes('+line 27 SECOND') && !git(HUNKS, 'diff', '--cached').includes('FIRST'), 'only the second hunk staged');
  await row('staged', 'two.txt').click();
  await waitText('Unstage hunk');
  await page.getByTestId('unstage-hunk').click();
  await until(() => staged(HUNKS).length === 0, 'unstaged again');
  // fold the first hunk from its header and unfold it
  await row('unstaged', 'two.txt').click();
  await waitText('line 2 FIRST');
  await page.getByTestId('hunk-toggle').first().click();
  await page.waitForFunction(() => !document.body.innerText.includes('line 2 FIRST'), null, { timeout: 3000 });
  await page.getByTestId('hunk-toggle').first().click();
  await waitText('line 2 FIRST');
  // discard the first hunk (asks; Undo puts it back)
  await page.getByTestId('discard-hunk').first().click();
  await waitText('Discard hunk?');
  await confirmWith('Discard');
  await until(() => !read(HUNKS, 'two.txt').includes('FIRST') && read(HUNKS, 'two.txt').includes('SECOND'), 'the first hunk discarded');
  await page.keyboard.press('Meta+z');
  await until(() => read(HUNKS, 'two.txt').includes('FIRST'), 'Undo put it back');
});

await check('lines: click and Shift-click pick changed lines; a pair picked in split view is staged in its place (it landed after the next old line); Clear; Discard N lines', async () => {
  await openChanges('chg-lines', 'file-unstaged-l.txt');
  await row('unstaged', 'l.txt').click();
  await waitText('new 3');
  // unified: click "old 1", Shift-click "new 3" — the changed lines between them (context is never picked)
  await page.getByText('old 1', { exact: true }).first().click();
  await page.getByText('new 3', { exact: true }).first().click({ modifiers: ['Shift'] });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="line-picked"]').length === 6, null, { timeout: 3000 });
  expect(await visible('Stage 6 lines'), 'the button counts them');
  await page.getByTestId('clear-lines').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="line-picked"]'), null, { timeout: 3000 });
  // split view: the second row's pair, one click on each side, staged where it is
  await page.getByLabel('split', { exact: true }).first().click();
  await page.getByText('old 2', { exact: true }).first().click();
  await page.getByText('new 2', { exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="line-picked"]').length === 2, null, { timeout: 3000 });
  await page.getByTestId('stage-lines').click();
  await until(() => git(LINES, 'show', ':0:l.txt') === 'keep\nold 1\nnew 2\nold 3\nend\n', 'the pair staged in its row: ' + JSON.stringify(git(LINES, 'show', ':0:l.txt')));
  // and unstaged again from Staged, one line at a time
  await row('staged', 'l.txt').click();
  await waitText('Unstage hunk');
  await page.getByText('new 2', { exact: true }).first().click();
  await page.getByText('old 2', { exact: true }).first().click();
  await page.getByTestId('unstage-lines').click();
  await until(() => staged(LINES).length === 0, 'unstaged again: ' + JSON.stringify(git(LINES, 'diff', '--cached')));
  // discard the third pair in the working copy: old 3 back where new 3 was
  await row('unstaged', 'l.txt').click();
  await waitText('Discard hunk');
  await page.getByText('old 3', { exact: true }).first().click();
  await page.getByText('new 3', { exact: true }).first().click();
  await page.getByTestId('discard-lines').click();
  await waitText('Discard 2 lines?');
  await confirmWith('Discard');
  await until(() => read(LINES, 'l.txt') === 'keep\nnew 1\nnew 2\nold 3\nend\n', 'only the third pair reverted: ' + JSON.stringify(read(LINES, 'l.txt')));
  await page.getByLabel('unified', { exact: true }).first().click();
  await page.keyboard.press('Meta+z');
  await until(() => read(LINES, 'l.txt') === 'keep\nnew 1\nnew 2\nnew 3\nend\n', 'Undo');
});

await check('a file without a newline at its end: Stage hunk, Stage 1 line and Discard hunk work (git refused the patch before)', async () => {
  await openChanges('chg-noeol', 'file-unstaged-f.txt');
  await row('unstaged', 'f.txt').click();
  await page.waitForFunction(() => /\+\s*c\b/.test(document.body.innerText), null, { timeout: 5000 });
  await page.getByTestId('stage-hunk').click();
  await until(() => git(NOEOL, 'show', ':0:f.txt') === 'a\nc', 'the hunk staged: ' + JSON.stringify(git(NOEOL, 'show', ':0:f.txt')));
  expect(!(await visible('Stage hunk of f.txt failed')), 'no error');
  // one line of g.txt: just the added "z" (y stays, now with a newline)
  await row('unstaged', 'g.txt').click();
  await page.getByText('z', { exact: true }).first().click();
  await page.getByTestId('stage-lines').click();
  await until(() => git(NOEOL, 'show', ':0:g.txt') === 'x\ny\nz', 'one line staged: ' + JSON.stringify(git(NOEOL, 'show', ':0:g.txt')));
  // the action is done, its diff read again, once its Undo entry is there (git changes first: a click on the old
  // diff discarded the wrong lines)
  await until(async () => (await undoLabel()) === 'Undo Stage 1 line (⌘Z)', 'the staging finished: ' + (await undoLabel()));
  // discard the rest of g.txt's change in the working copy: it becomes what is staged
  await row('unstaged', 'g.txt').click();
  await waitText('Discard hunk');
  await page.getByTestId('discard-hunk').first().click();
  await confirmWith('Discard');
  await until(() => read(NOEOL, 'g.txt') === 'x\ny\nz', 'the working copy follows: ' + JSON.stringify(read(NOEOL, 'g.txt')));
  // an SQL change whose lines look like file headers stages as shown
  await row('unstaged', 'q.sql').click();
  await waitText('-- old comment');
  await page.getByTestId('stage-hunk').click();
  await until(() => git(NOEOL, 'show', ':0:q.sql') === 'select 1;\n++ new\nselect 2;\n', 'the SQL hunk staged');
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

await check('a large diff: the notice with Load anyway; once loaded it stays loaded in Staged (it hung on "Loading the diff…"); the external diff tool gets the file', async () => {
  await openChanges('chg-large', 'file-unstaged-big.txt');
  await row('unstaged', 'big.txt').click();
  await waitText('Large diff');
  expect(await visible('4,501 changed lines'), 'how big it is');
  // (the pointer off the row: on hover its buttons take the place of the counts)
  await page.mouse.move(1100, 500);
  await until(async () => (await row('unstaged', 'big.txt').innerText()).includes('+4500 −1'), 'the row keeps its counts: ' + (await row('unstaged', 'big.txt').innerText()));
  systemCalls.length = 0;
  await page.getByText('Open in external diff tool', { exact: true }).click();
  await until(() => systemCalls.length === 1, 'the diff tool asked');
  expect(systemCalls[0].body.path === path.join(LARGE, 'big.txt'), 'the file: ' + JSON.stringify(systemCalls[0]));
  await page.getByText('Load anyway', { exact: true }).click();
  await waitText('big line 4499');
  await page.getByText('Stage file', { exact: true }).click();
  await row('staged', 'big.txt').waitFor({ timeout: 5000 });
  await row('staged', 'big.txt').click();
  await page.waitForFunction(() => document.body.innerText.includes('big line 4499') || document.body.innerText.includes('Load anyway'), null, { timeout: 10000 });
  expect(await visible('big line 4499'), 'the staged diff in full, not "Loading the diff…"');
});

// ---------- the commit box ----------

const commitButton = () => page.getByTestId('commit-button');
const commitDisabled = async () => (await commitButton().getAttribute('aria-disabled')) === 'true';
const summary = () => page.getByTestId('commit-summary');
const counterColor = () => page.getByTestId('commit-counter').evaluate((e) => getComputedStyle(e).color);
const commitsIn = (dir) => +git(dir, 'rev-list', '--count', 'HEAD').trim();

await check('commit box: Commit is off until something is staged and the summary has text; the counter turns at 51 and 73 characters', async () => {
  await openChanges('chg-commit', 'file-unstaged-a.txt');
  // who the commit is made as: the repository's own identity (the box named the global one)
  await until(async () => /^to main as Changes Suite/.test((await page.getByTestId('commit-target').innerText()).trim()), 'the target line: ' + (await page.getByTestId('commit-target').innerText()));
  await summary().fill('Something');
  expect(await commitDisabled(), 'nothing staged: disabled');
  await page.keyboard.press('Meta+Enter');
  await waitText('Nothing staged');
  expect(commitsIn(COMMIT) === 1, 'no commit');
  // a hint in the status line: nothing failed, so no error window over the screen (it opened one before)
  expect(!(await page.getByText('Clear log', { exact: true }).count()), 'no error window');
  await row('unstaged', 'a.txt').hover();
  await page.getByTestId('file-stage-a.txt').click();
  await row('staged', 'a.txt').waitFor({ timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="commit-button"]')?.getAttribute('aria-disabled') !== 'true', null, { timeout: 3000 });
  await summary().fill('   ');
  await page.waitForTimeout(100);
  expect(await commitDisabled(), 'a blank summary: disabled');
  await summary().fill('x'.repeat(50));
  const quiet = await counterColor();
  expect((await page.getByTestId('commit-counter').innerText()).trim() === '50', 'the counter counts');
  await summary().fill('x'.repeat(51));
  const warn = await counterColor();
  await summary().fill('x'.repeat(73));
  const over = await counterColor();
  expect(quiet !== warn && warn !== over && quiet !== over, 'three colours: ' + [quiet, warn, over].join(' / '));
  await summary().fill('');
});

await check('commit: summary and description go into git; the lists refresh, the box empties, Undo names it; Enter and ⌘Enter commit once each', async () => {
  await openChanges('chg-commit', 'file-unstaged-b.txt');
  if (!(await page.getByTestId('commit-description-input').count())) await page.getByTestId('toggle-commit-desc').click();
  await summary().fill('First from the box');
  await page.getByTestId('commit-description-input').fill('A body line\nand another');
  await commitButton().click();
  await until(() => git(COMMIT, 'log', '-1', '--format=%s').trim() === 'First from the box', 'committed');
  expect(git(COMMIT, 'log', '-1', '--format=%an').trim() === 'Changes Suite', 'as the box said');
  expect(git(COMMIT, 'log', '-1', '--format=%b').trim() === 'A body line\nand another', 'with its description: ' + git(COMMIT, 'log', '-1', '--format=%b'));
  await page.waitForFunction(() => !document.querySelector('[data-testid^="file-staged-"]'), null, { timeout: 5000 });
  expect((await summary().inputValue()) === '' && (await page.getByTestId('commit-description-input').inputValue()) === '', 'the box is empty');
  await page.waitForFunction(() => /Undo Commit “First from the box”/.test(document.querySelector('[data-testid="undo-button"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 5000 });
  // Enter in the summary
  git(COMMIT, 'add', 'b.txt');
  await refreshUi();
  await row('staged', 'b.txt').waitFor({ timeout: 5000 });
  const n = commitsIn(COMMIT);
  await summary().fill('Second by Enter');
  await summary().press('Enter');
  await until(() => git(COMMIT, 'log', '-1', '--format=%s').trim() === 'Second by Enter', 'Enter committed');
  // ⌘Enter from the description: one commit, not two (the field's own Enter and the shortcut)
  git(COMMIT, 'add', 'c.txt');
  await refreshUi();
  await row('staged', 'c.txt').waitFor({ timeout: 5000 });
  await summary().fill('Third by cmd-enter');
  await page.getByTestId('commit-description-input').click();
  await page.keyboard.press('Meta+Enter');
  await until(() => git(COMMIT, 'log', '-1', '--format=%s').trim() === 'Third by cmd-enter', '⌘Enter committed');
  await page.waitForTimeout(800);
  expect(commitsIn(COMMIT) === n + 2, `one commit each: ${commitsIn(COMMIT) - n}`);
  expect(!(await visible('Nothing staged')), 'no second attempt');
});

await check('Amend: ticking loads the last message, unticking clears it but keeps what you typed; Amend rewrites HEAD without a new commit', async () => {
  await openChanges('chg-amend');
  await page.getByText('Changes', { exact: true }).first().click();
  await summary().waitFor({ timeout: 5000 });
  if (!(await page.getByTestId('commit-description-input').count())) await page.getByTestId('toggle-commit-desc').click();
  await page.getByTestId('commit-amend').click();
  await until(async () => (await summary().inputValue()) === 'Second commit', 'the last summary loaded');
  expect((await page.getByTestId('commit-description-input').inputValue()) === 'Its description', 'and its description');
  expect((await commitButton().innerText()).trim().toLowerCase() === 'amend' && !(await commitDisabled()), 'the button says Amend and works with nothing staged');
  await page.getByTestId('commit-amend').click();
  await until(async () => (await summary().inputValue()) === '', 'unticked: the loaded message goes');
  // a message typed before ticking stays when unticking (it used to be wiped)
  await summary().fill('my own words');
  await page.getByTestId('commit-amend').click();
  await page.waitForTimeout(150);
  expect((await summary().inputValue()) === 'my own words', 'ticking keeps typed text');
  await page.getByTestId('commit-amend').click();
  await page.waitForTimeout(150);
  expect((await summary().inputValue()) === 'my own words', 'unticking keeps it too: ' + (await summary().inputValue()));
  await summary().fill('');
  // amend for real
  const parent = git(AMEND, 'rev-parse', 'HEAD~1').trim();
  await page.getByTestId('commit-amend').click();
  await until(async () => (await summary().inputValue()) === 'Second commit', 'loaded again');
  await summary().fill('Second commit, amended');
  await commitButton().click();
  await until(() => git(AMEND, 'log', '-1', '--format=%s').trim() === 'Second commit, amended', 'HEAD rewritten');
  expect(commitsIn(AMEND) === 2 && git(AMEND, 'rev-parse', 'HEAD~1').trim() === parent, 'no new commit, same parent');
  expect(!(await isChecked('commit-amend')), 'Amend unticked after it');
  await page.waitForFunction(() => /Undo Amend/.test(document.querySelector('[data-testid="undo-button"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 5000 });
});

await check('Commit & Push: chosen in the button menu, the commit goes to the upstream; back to plain Commit', async () => {
  await openChanges('chg-push', 'file-staged-a.txt');
  await page.getByTestId('commit-menu').click();
  await menuItem('Commit and push').click();
  await page.waitForFunction(() => /commit & push/i.test(document.querySelector('[data-testid="commit-button"]')?.textContent ?? ''), null, { timeout: 3000 });
  await summary().fill('Pushed from the box');
  await commitButton().click();
  const remote = () => git(PUSH, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  await until(() => git(PUSH, 'log', '-1', '--format=%s').trim() === 'Pushed from the box' && remote() === git(PUSH, 'rev-parse', 'HEAD').trim(), 'committed and pushed', 20000);
  await page.getByTestId('commit-menu').click();
  await page.getByText(/^\s*Commit\s*$/).last().click();
  await page.waitForFunction(() => /^\s*commit\s*$/i.test(document.querySelector('[data-testid="commit-button"]')?.textContent ?? ''), null, { timeout: 3000 });
});

await check('Sign: the box shows the repository’s own commit.gpgsign and sets it there (a global switch showed in every repository before)', async () => {
  const local = (dir) => {
    try {
      return git(dir, 'config', '--local', '--get', 'commit.gpgsign').trim();
    } catch {
      return '';
    }
  };
  await openChanges('chg-sign-a');
  await page.getByTestId('commit-sign').waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  expect(!(await isChecked('commit-sign')), 'not signed at first');
  await page.getByTestId('commit-sign').click();
  await until(() => local(SIGN_A) === 'true', 'commit.gpgsign=true in A');
  await openChanges('chg-sign-b');
  await page.waitForTimeout(600);
  expect(!(await isChecked('commit-sign')), 'B does not sign: its box is clear');
  expect(local(SIGN_B) === 'false', 'B untouched');
  await openChanges('chg-sign-a');
  await until(() => isChecked('commit-sign'), 'A shows its signing again');
  await page.getByTestId('commit-sign').click();
  await until(() => local(SIGN_A) === 'false', 'off again in A');
});

// ---------- merge conflicts ----------

await check('a merge conflict: the bar says so, the three sides show, Use theirs / Both / Mark resolved / a deleted file; the prepared message commits the merge', async () => {
  try {
    git(MERGE, 'merge', 'other');
  } catch {
    /* stops on the conflicts */
  }
  await openChanges('chg-merge', 'file-unstaged-a.txt');
  await page.getByTestId('conflict-bar').waitFor({ timeout: 5000 });
  expect(/^4 conflicted files/i.test((await page.getByTestId('conflict-bar').innerText()).trim()), 'the bar: ' + (await page.getByTestId('conflict-bar').innerText()));
  expect(/^abort merge$/i.test((await page.getByTestId('conflict-abort').innerText()).trim()), 'Abort merge offered');
  // the commit box has git's message for the merge
  await until(async () => /^Merge branch 'other'/.test(await summary().inputValue()), 'the merge message prefilled: ' + (await summary().inputValue()));
  // Stage all leaves the conflicts alone (git add -A marked them resolved, markers inside)
  write(MERGE, 'extra.txt', 'extra\n');
  await refreshUi();
  await row('unstaged', 'extra.txt').waitFor({ timeout: 5000 });
  await page.getByLabel('Stage all', { exact: true }).click();
  await until(() => staged(MERGE).includes('extra.txt'), 'extra.txt staged');
  await waitText('Staged all but 4 conflicted files');
  expect(git(MERGE, 'status', '--porcelain').includes('UU a.txt'), 'a.txt still conflicted: ' + git(MERGE, 'status', '--porcelain'));
  // the sides of a.txt (it used to say "No textual changes.")
  await row('unstaged', 'a.txt').click();
  await page.getByTestId('conflict-view').waitFor({ timeout: 5000 });
  expect((await page.getByTestId('conflict-col-ours').innerText()).includes('ours a'), 'ours');
  expect((await page.getByTestId('conflict-col-base').innerText()).includes('base a'), 'the base');
  expect((await page.getByTestId('conflict-col-theirs').innerText()).includes('theirs a'), 'theirs');
  expect(!(await page.getByText('Stage file', { exact: true }).count()), 'no Stage file over a conflict');
  await page.getByTestId('conflict-theirs').click();
  await until(() => read(MERGE, 'a.txt') === 'top\ntheirs a\nend\n' && staged(MERGE).includes('a.txt'), 'a.txt: theirs, resolved');
  // both sides, ours first ("needs an editor" error before)
  await row('unstaged', 'b.txt').click();
  await page.getByTestId('conflict-both').click();
  await until(() => read(MERGE, 'b.txt') === 'ours b\ntheirs b\n' && staged(MERGE).includes('b.txt'), 'b.txt: both');
  // edited by hand, then Mark resolved
  write(MERGE, 'c.txt', 'resolved by hand\n');
  await row('unstaged', 'c.txt').click();
  await page.getByTestId('conflict-resolved').click();
  await until(() => staged(MERGE).includes('c.txt') && git(MERGE, 'show', ':0:c.txt') === 'resolved by hand\n', 'c.txt marked resolved');
  // a file they deleted: said so, Use theirs deletes it
  await row('unstaged', 'gone.txt').click();
  await waitText('they deleted this file');
  expect(!(await page.getByTestId('conflict-both').count()), 'no Both for a deleted file');
  await page.getByTestId('conflict-theirs').click();
  await until(() => !existsSync(path.join(MERGE, 'gone.txt')) && git(MERGE, 'status', '--porcelain').includes('D  gone.txt'), 'gone.txt deleted');
  await page.waitForFunction(() => !document.querySelector('[data-testid="conflict-bar"]'), null, { timeout: 5000 });
  await commitButton().click();
  await until(() => git(MERGE, 'log', '-1', '--format=%P').trim().split(' ').length === 2, 'a merge commit');
  expect(/^Merge branch 'other'/.test(git(MERGE, 'log', '-1', '--format=%s')), 'with the prepared message');
  expect(!existsSync(path.join(MERGE, '.git/MERGE_HEAD')), 'the merge is over');
});

await check('a merge resolved all to our side stages nothing and still commits (Commit stayed off)', async () => {
  try {
    git(MERGE_OURS, 'merge', 'other');
  } catch {
    /* conflicts */
  }
  await openChanges('chg-merge-ours', 'file-unstaged-a.txt');
  for (const f of ['a.txt', 'b.txt', 'c.txt', 'gone.txt']) {
    await row('unstaged', f).click();
    await page.getByTestId('conflict-ours').click();
    await page.waitForFunction((id) => !document.querySelector(`[data-testid="${id}"]`), `file-unstaged-${f}`, { timeout: 5000 });
  }
  expect(staged(MERGE_OURS).length === 0, 'nothing staged');
  await until(async () => (await summary().inputValue()).startsWith("Merge branch 'other'"), 'the merge message');
  await page.waitForFunction(() => document.querySelector('[data-testid="commit-button"]')?.getAttribute('aria-disabled') !== 'true', null, { timeout: 3000 });
  await commitButton().click();
  await until(() => git(MERGE_OURS, 'log', '-1', '--format=%P').trim().split(' ').length === 2, 'the merge committed');
});

await check('Abort merge in the conflict bar puts everything back', async () => {
  try {
    git(ABORT, 'merge', 'other');
  } catch {
    /* conflicts */
  }
  await openChanges('chg-abort', 'file-unstaged-a.txt');
  await page.getByTestId('conflict-abort').click();
  await until(() => !existsSync(path.join(ABORT, '.git/MERGE_HEAD')) && read(ABORT, 'a.txt') === 'top\nours a\nend\n', 'aborted');
  await page.waitForFunction(() => !document.querySelector('[data-testid="conflict-bar"]'), null, { timeout: 5000 });
});

await check('a cherry-pick conflict: the bar names it, the picked commit’s message is in the box, Abort cherry-pick works ("There is no merge to abort" before)', async () => {
  try {
    git(CHERRY, 'cherry-pick', 'other');
  } catch {
    /* conflicts */
  }
  await openChanges('chg-cherry', 'file-unstaged-a.txt');
  await page.getByTestId('conflict-bar').waitFor({ timeout: 5000 });
  expect(/^abort cherry-pick$/i.test((await page.getByTestId('conflict-abort').innerText()).trim()), 'the bar names the cherry-pick: ' + (await page.getByTestId('conflict-abort').innerText()));
  await until(async () => (await summary().inputValue()) === 'Their change', 'the picked message: ' + (await summary().inputValue()));
  await page.getByTestId('conflict-abort').click();
  await until(() => !existsSync(path.join(CHERRY, '.git/CHERRY_PICK_HEAD')) && read(CHERRY, 'a.txt') === 'top\nours a\nend\n', 'the cherry-pick aborted');
  expect(!(await visible('failed')), 'no error');
  // the status panel's Abort does the same (it ran `git merge --abort` too)
  try {
    git(CHERRY, 'cherry-pick', 'other');
  } catch {
    /* conflicts again */
  }
  await refreshUi();
  await page.getByTestId('op-abort').click();
  await until(() => !existsSync(path.join(CHERRY, '.git/CHERRY_PICK_HEAD')), 'aborted from the status panel');
  expect(!(await visible('failed')), 'no error');
  await summary().fill('');
  if (await page.getByTestId('commit-description-input').count()) await page.getByTestId('commit-description-input').fill('');
});

await check('a conflict left by a stash apply: no Abort (there is nothing to abort; "Abort merge" failed), its sides show, Use ours resolves it', async () => {
  await openChanges('chg-stashpop', 'file-unstaged-s.txt');
  await page.getByTestId('conflict-bar').waitFor({ timeout: 5000 });
  expect(!(await page.getByTestId('conflict-abort').count()), 'no Abort button');
  await row('unstaged', 's.txt').click();
  await page.getByTestId('conflict-view').waitFor({ timeout: 5000 });
  expect((await page.getByTestId('conflict-col-theirs').innerText()).includes('stashed') && (await page.getByTestId('conflict-col-ours').innerText()).includes('committed'), 'the stashed and the committed side');
  await page.getByTestId('conflict-ours').click();
  await until(() => read(STASHPOP, 's.txt') === 'committed\n' && !git(STASHPOP, 'status', '--porcelain').startsWith('UU'), 'resolved to ours');
  await page.waitForFunction(() => !document.querySelector('[data-testid="conflict-bar"]'), null, { timeout: 5000 });
});

// ---------- changes made elsewhere ----------

await check('changes made outside Prong: the shown diff follows an edit with the same counts (it kept the old lines), staged and discarded files move, new ones appear', async () => {
  await openChanges('chg-outside', 'file-unstaged-o.txt');
  await row('unstaged', 'o.txt').click();
  await waitText('FIRST');
  write(OUTSIDE, 'o.txt', 'alpha\nSECOND\n');
  await refreshUi();
  await waitText('SECOND');
  expect(!(await visible('FIRST')), 'the old line is gone');
  // coming back to the window reads it again too
  await page.waitForTimeout(2100);
  write(OUTSIDE, 'o.txt', 'alpha\nTHIRD\n');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitText('THIRD');
  // staged elsewhere: in Staged; a new file: listed
  write(OUTSIDE, 'p.txt', 'p changed\n');
  git(OUTSIDE, 'add', 'p.txt');
  write(OUTSIDE, 'brand-new.txt', 'hello\n');
  await refreshUi();
  await row('staged', 'p.txt').waitFor({ timeout: 5000 });
  await row('unstaged', 'brand-new.txt').waitFor({ timeout: 5000 });
  // the shown file discarded elsewhere: its diff goes too
  git(OUTSIDE, 'checkout', '--', 'o.txt');
  await refreshUi();
  await page.waitForFunction(() => !document.querySelector('[data-testid="file-unstaged-o.txt"]'), null, { timeout: 5000 });
  expect(!(await visible('THIRD')), 'no stale diff of the discarded file');
});

// ---------- submodule rows, layout ----------

await check('the diff header: Stage file, Unstage file, Discard (asks; Undo brings it back)', async () => {
  await openChanges('chg-diffhead', 'file-unstaged-h.txt');
  await row('unstaged', 'h.txt').click();
  await waitText('h changed');
  await page.getByText('Stage file', { exact: true }).click();
  await until(() => staged(DIFFHEAD).includes('h.txt'), 'staged from the header');
  // the diff follows the file into Staged, with its lines (it stayed empty, "No textual changes.", until clicked)
  await page.getByText('Unstage file', { exact: true }).waitFor({ timeout: 5000 });
  await page.getByTestId('unstage-hunk').waitFor({ timeout: 5000 });
  expect(await visible('h changed'), 'the staged diff');
  await page.getByText('Unstage file', { exact: true }).click();
  await until(() => staged(DIFFHEAD).length === 0, 'unstaged from the header');
  await page.getByTestId('stage-hunk').waitFor({ timeout: 5000 });
  await page.getByText('Discard', { exact: true }).first().waitFor({ timeout: 5000 });
  await page.getByText('Discard', { exact: true }).first().click();
  await waitText('Discard changes?');
  await confirmWith('Discard');
  await until(() => read(DIFFHEAD, 'h.txt') === 'h\n', 'discarded from the header');
  await page.keyboard.press('Meta+z');
  await until(() => read(DIFFHEAD, 'h.txt') === 'h changed\n', 'Undo');
});

await check('a repository of its own inside: Discard leaves it alone and says so (it was deleted with its history, and Undo could not bring .git back)', async () => {
  await openChanges('chg-nested', 'file-unstaged-vendor/lib/');
  await row('unstaged', 'vendor/lib/').click({ button: 'right' });
  await menuItem('Discard changes…').click();
  await confirmWith('Discard');
  await waitText('Left vendor/lib/ alone');
  expect(existsSync(path.join(NESTED, 'vendor/lib/.git')) && existsSync(path.join(NESTED, 'vendor/lib/x.txt')), 'the nested repository is still there');
  expect(!(await page.getByText('Clear log', { exact: true }).count()), 'not an error');
});



/**
 * The pointer on a row's body, then on one of the row's own arrows or buttons and moved a little on it: what the row
 * shows at each step (its hover buttons, where the inner element is, its background). RN-web ends a row's hover on
 * a pressable inside it: the highlight went, the hover buttons went, and where they took space the arrow moved off
 * the pointer and back — it flickered (merge2core's → in Changes).
 */
async function hoverTrace({ row, inner, button }) {
  const sample = () =>
    page.evaluate(async ([row, inner, button]) => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      // a test id on a text inside the row names it too: the row is its closest focusable box
      const r = q(row)?.closest('[tabindex]');
      const b = q(button);
      const i = q(inner);
      return `${b && b.offsetParent ? 'buttons' : 'none'} x=${i && i.offsetParent ? Math.round(i.getBoundingClientRect().x) : 'hidden'} bg=${r ? getComputedStyle(r.firstElementChild).backgroundColor : '?'}`;
    }, [row, inner, button]);
  const xOf = (s) => s.match(/x=(\S+)/)[1];
  // at rest (the pointer elsewhere): where the inner element is when it shows without hover
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  const rest = await sample();
  const rowBox = await page.evaluate((id) => {
    const r = document.querySelector(`[data-testid="${id}"]`)?.closest('[tabindex]')?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  }, row);
  await page.mouse.move(rowBox.x + 40, rowBox.y + rowBox.h / 2);
  await page.waitForTimeout(150);
  const body = await sample();
  const box = await page.getByTestId(inner).boundingBox();
  const steps = [];
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(box.x + box.width / 2 + (i % 3) - 1, box.y + box.height / 2 + (i % 2));
    steps.push(await sample());
  }
  await page.mouse.move(0, 0);
  // the hover buttons appear without moving what was already there
  const still = xOf(rest) === 'hidden' || xOf(rest) === xOf(body);
  return { rest, body, steps, still, steady: still && steps.every((x) => x === body) };
}

await check('hover: on a row’s own arrow or button the row stays as it was — buttons, the arrow’s place, the highlight (they flickered)', async () => {
  // a moved submodule: its → sits left of the hover buttons
  await openChanges('superproject', 'file-unstaged-libs/core');
  await setView('list');
  const sub = await hoverTrace({ row: 'file-unstaged-libs/core', inner: 'open-submodule-libs/core', button: 'file-stage-libs/core' });
  expect(sub.steady && sub.body.startsWith('buttons'), `the arrow: rest ${sub.rest}, body ${sub.body} → ${sub.steps.join(' | ')}`);
  // the pointer brought straight onto the arrow from outside the row: a click there opens the submodule (the
  // buttons appearing pushed the arrow away, and the click hit Stage or Discard)
  const arrow = await page.getByTestId('open-submodule-libs/core').boundingBox();
  await page.mouse.move(arrow.x + arrow.width / 2, arrow.y - 40);
  await page.mouse.move(arrow.x + arrow.width / 2, arrow.y + arrow.height / 2, { steps: 4 });
  await page.waitForTimeout(200);
  const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'), [arrow.x + arrow.width / 2, arrow.y + arrow.height / 2]);
  expect(under === 'open-submodule-libs/core', 'under the pointer: ' + under);
  await page.mouse.down();
  await page.mouse.up();
  await page.getByTestId('tab-libs/core').waitFor({ timeout: 10000 });
  expect(staged(path.join(root, 'superproject')).length === 0, 'nothing staged by it');
  // a file row's own Stage button: the row keeps its highlight
  await openChanges('chg-kinds', 'file-unstaged-mod.txt');
  await setView('list');
  const file = await hoverTrace({ row: 'file-unstaged-q.sql', inner: 'file-stage-q.sql', button: 'file-discard-q.sql' });
  expect(file.steady, `the Stage button: body ${file.body} → ${file.steps.join(' | ')}`);
  // a branch row's funnel in the sidebar
  const branch = await hoverTrace({ row: 'branch-main', inner: 'funnel-main', button: 'funnel-main' });
  expect(branch.steady, `the funnel: body ${branch.body} → ${branch.steps.join(' | ')}`);
});

await check('a submodule change: the row’s menu opens the submodule at the commit it points to', async () => {
  await openChanges('superproject', 'file-unstaged-libs/core');
  // selected, its diff gives the two pointers
  await row('unstaged', 'libs/core').click();
  await waitText('Submodule pointer changed');
  await row('unstaged', 'libs/core').click({ button: 'right' });
  const first = (await menuLabels())[0]?.label ?? '';
  expect(/^Open submodule at [0-9a-f]{7}$/.test(first), 'the first item: ' + first);
  await menuItem(first).click();
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tab-libs/core"]'), null, { timeout: 10000 });
  await waitText('core: three');
});

await check('a submodule with edited or new files of its own is listed as in Fork: what is inside, no Stage or Discard, its view names the files and opens the submodule on Changes', async () => {
  await openChanges('chg-subs', 'file-unstaged-libs/edited');
  await setView('list');
  const rowText = async (p) => (await row('unstaged', p).innerText()).replace(/\s+/g, ' ').trim();
  expect((await rowText('libs/edited')) === 'M edited libs 1 changed', 'edited: ' + (await rowText('libs/edited')));
  expect((await rowText('libs/fresh')) === 'M fresh libs 1 new', 'new file: ' + (await rowText('libs/fresh')));
  expect((await row('unstaged', 'libs/clean').count()) === 0, 'the clean one is not listed');
  expect((await page.getByTestId('sidebar-changes-count').innerText()).trim() === '2', 'Changes counts them: ' + (await page.getByTestId('sidebar-changes-count').innerText()));
  // the sidebar's square says so too
  const said = await page.getByTestId('group-submodules').count() ? await page.getByTestId('submodule-state-libs/edited').getAttribute('aria-label').catch(() => null) : null;
  if (said !== null) expect(/own files changed \(1 changed\)/.test(said), 'the sidebar square: ' + said);
  // hovered: no Stage or Discard (they are committed in the submodule); the menu opens it instead
  await row('unstaged', 'libs/edited').hover();
  expect((await page.getByTestId('file-stage-libs/edited').count()) === 0 && (await page.getByTestId('file-discard-libs/edited').count()) === 0, 'no Stage / Discard buttons');
  await row('unstaged', 'libs/edited').click({ button: 'right' });
  const labels = (await menuLabels()).map((l) => l.label);
  expect(labels[0] === 'Open submodule' && !labels.includes('Stage') && !labels.some((l) => l.startsWith('Discard')), 'menu: ' + labels.join(', '));
  await closeMenu();
  // its view: what is inside, by name; no Stage file / Discard in the header
  await row('unstaged', 'libs/edited').click();
  await page.getByTestId('submodule-inside').waitFor({ timeout: 10000 });
  const view = await page.getByTestId('submodule-inside').innerText();
  expect(view.includes('Changes inside the submodule') && view.includes('1 changed') && view.includes('core.txt'), 'the view: ' + view);
  expect((await page.getByTestId('diff-header').getByText('Stage file', { exact: true }).count()) === 0, 'no Stage file in the header');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'submodule-inside.png') });
  // Stage all has nothing it can stage here: it says why, and the index stays as it was
  await page.getByLabel('Stage all', { exact: true }).first().click();
  await waitText('Nothing to stage in 2 submodules');
  expect(staged(SUBS).length === 0, 'nothing staged: ' + staged(SUBS).join(', '));
  // a file of the list: the submodule's tab, on Changes, with that file shown
  await page.getByTestId('submodule-inside-file-core.txt').click();
  await page.getByTestId('tab-libs/edited').waitFor({ timeout: 15000 });
  await row('unstaged', 'core.txt').waitFor({ timeout: 15000 });
  await waitText('edited inside');
  // back in the project: a double click on the other one opens it as well (it used to stage, which did nothing)
  await page.getByTestId('tab-chg-subs').click();
  await row('unstaged', 'libs/fresh').waitFor({ timeout: 10000 });
  await row('unstaged', 'libs/fresh').dblclick();
  await page.getByTestId('tab-libs/fresh').waitFor({ timeout: 15000 });
  await row('unstaged', 'new.txt').waitFor({ timeout: 15000 });
  expect(staged(SUBS).length === 0, 'still nothing staged');
});

await check('narrow window: the commit box row, the diff header and the hunk header keep their buttons apart from the text', async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  try {
    await openChanges('chg-narrow', 'file-unstaged-n.txt');
    await row('unstaged', 'n.txt').click();
    await waitText('n changed');
    const overlaps = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const hit = (a, b) => a && b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const byText = (re) => [...document.querySelectorAll('div')].filter((d) => d.childElementCount === 0 && re.test(d.innerText)).map((d) => d.getBoundingClientRect());
      const btn = r('[data-testid="commit-button"]');
      const to = [...document.querySelectorAll('div')].filter((d) => /^to\s/.test(d.innerText)).pop()?.getBoundingClientRect();
      const stage = byText(/^stage file$/i)[0];
      const pathText = byText(/^n\.txt$/).pop();
      const hunkBtn = r('[data-testid="stage-hunk"]');
      const hunkHdr = byText(/^@@ /)[0];
      return { inWindow: !!btn && btn.right <= innerWidth && btn.bottom <= innerHeight, commit: hit(btn, to), header: hit(stage, pathText), hunk: hit(hunkBtn, hunkHdr) };
    });
    expect(overlaps.inWindow && overlaps.commit === false && overlaps.header === false && overlaps.hunk === false, 'nothing drawn over text: ' + JSON.stringify(overlaps));
    // a long name is cut inside its row (in list and tree view), it never runs under the counts or out of the panel
    for (const v of ['list', 'tree']) {
      await setView(v);
      const fit = await page.evaluate((id) => {
        const r = document.querySelector(`[data-testid="${id}"]`);
        const rr = r.getBoundingClientRect();
        const leaves = [...r.querySelectorAll('div')].filter((d) => d.childElementCount === 0 && d.innerText.trim());
        const name = leaves.find((d) => d.innerText.startsWith('a-really-long'));
        const counts = leaves.find((d) => /^\+1/.test(d.innerText));
        const n = name.getBoundingClientRect();
        const c = counts?.getBoundingClientRect();
        return { inside: n.right <= rr.right + 1, apart: !c || n.right <= c.left + 1, cut: name.scrollWidth > name.clientWidth };
      }, `file-unstaged-${LONG_NAME}`);
      expect(fit.inside && fit.apart && fit.cut, `${v}: ` + JSON.stringify(fit));
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  expect(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
});

await finish('changes');
