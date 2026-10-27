import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';
import { inRuns } from '../src/git/run.js';
import { restoreFromUndo, saveForUndo } from '../src/undo.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

describe('paths in runs that fit a command line', () => {
  it('splits by bytes, keeps the order, never leaves a run empty', () => {
    const paths = Array.from({ length: 10 }, (_, i) => `dir/file-${i}.txt`); // 18 bytes each with the separator
    const runs = inRuns(paths, 40);
    expect(runs.flat()).toEqual(paths);
    expect(runs.every((r) => r.length === 2)).toBe(true);
    // a path longer than the budget still goes, alone
    expect(inRuns(['x'.repeat(100), 'y'], 10)).toEqual([['x'.repeat(100)], ['y']]);
    expect(inRuns([])).toEqual([]);
  });
});

/** a Changes folder acts on all its files at once: thousands of paths in one stage, unstage, discard */
describe('a folder of files staged, unstaged and discarded at once', () => {
  let root: string;
  let dir: string;
  let repo: Repo;
  // long names: 3 000 of them are well past one 96 KB run
  const names = Array.from({ length: 3000 }, (_, i) => `assets/textures/a-rather-long-folder-name/${String(i).padStart(4, '0')}-texture.json`);
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-folder-'));
    dir = path.join(root, 'r');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'commit.gpgsign', 'false');
    mkdirSync(path.join(dir, 'assets/textures/a-rather-long-folder-name'), { recursive: true });
    for (const n of names) writeFileSync(path.join(dir, n), '1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'textures');
    repo = new Repo(dir);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('stages and unstages every file of the folder', async () => {
    expect(inRuns(names).length).toBeGreaterThan(1);
    for (const n of names) writeFileSync(path.join(dir, n), '2\n');
    await repo.stage(names);
    expect(git(dir, 'diff', '--cached', '--name-only').split('\n')).toHaveLength(names.length);
    await repo.unstage(names);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('discards them with untracked ones among them, and the undo brings them all back', async () => {
    // an untracked file, and an untracked folder git lists as "assets/new/"
    writeFileSync(path.join(dir, 'assets/textures/loose.json'), 'new\n');
    mkdirSync(path.join(dir, 'assets/new'), { recursive: true });
    writeFileSync(path.join(dir, 'assets/new/inside.json'), 'new\n');
    const paths = [...names, 'assets/textures/loose.json', 'assets/new/'];
    const token = await saveForUndo(repo, paths);
    expect(token).toBeTruthy();
    await repo.discard(paths);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(dir, names[0]), 'utf8')).toBe('1\n');
    restoreFromUndo(repo, token!);
    expect(readFileSync(path.join(dir, names[2999]), 'utf8')).toBe('2\n');
    expect(existsSync(path.join(dir, 'assets/new/inside.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'assets/textures/loose.json'))).toBe(true);
  });

  it('an untracked folder is found whichever way status lists it (status.showUntrackedFiles=all)', async () => {
    git(dir, 'config', 'status.showUntrackedFiles', 'all');
    try {
      await repo.discard([...names, 'assets/textures/loose.json', 'assets/new/']);
      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(existsSync(path.join(dir, 'assets/new'))).toBe(false);
    } finally {
      git(dir, 'config', '--unset', 'status.showUntrackedFiles');
    }
  });
});

/** git names a wholly new folder once ("dir/"): Changes lists its files, with their line counts */
describe('new folders in the working copy', () => {
  let root: string;
  let dir: string;
  let repo: Repo;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-untracked-'));
    dir = path.join(root, 'r');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(dir, '.gitignore'), '*.log\n');
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'a');
    repo = new Repo(dir);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists the files of a new folder (not ignored ones), counts their lines, keeps a nested repository whole', async () => {
    mkdirSync(path.join(dir, 'Assets/ImageToUI/deep'), { recursive: true });
    writeFileSync(path.join(dir, 'Assets/ImageToUI/one.json'), '{\n  "a": 1\n}\n');
    writeFileSync(path.join(dir, 'Assets/ImageToUI/deep/two.txt'), 'x\ny'); // no final newline: still 2 lines
    writeFileSync(path.join(dir, 'Assets/ImageToUI/deep/skip.log'), 'ignored\n');
    writeFileSync(path.join(dir, 'Assets/ImageToUI/blob.dat'), Buffer.from([1, 0, 2, 0]));
    writeFileSync(path.join(dir, 'loose.txt'), '1\n2\n3\n');
    execFileSync('git', ['init', '-q', path.join(dir, 'Assets/nested')]);
    writeFileSync(path.join(dir, 'Assets/nested/inner.txt'), 'inner\n');
    const st = await repo.status();
    const byPath = new Map(st.unstaged.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual(['Assets/ImageToUI/blob.dat', 'Assets/ImageToUI/deep/two.txt', 'Assets/ImageToUI/one.json', 'Assets/nested/', 'loose.txt']);
    expect(byPath.get('Assets/ImageToUI/one.json')).toMatchObject({ status: '?', additions: 3, kind: 'text' });
    expect(byPath.get('Assets/ImageToUI/deep/two.txt')?.additions).toBe(2);
    expect(byPath.get('loose.txt')?.additions).toBe(3);
    expect(byPath.get('Assets/ImageToUI/blob.dat')?.kind).toBe('binary');
    // a file inside shows its diff as an addition
    const d = await repo.fileDiff('Assets/ImageToUI/one.json', 'unstaged');
    expect(d).toMatchObject({ status: '?', additions: 3 });
  });

  it('discarding a new folder file by file leaves no empty folders behind', async () => {
    const st = await repo.status();
    const inside = st.unstaged.filter((f) => f.path.startsWith('Assets/ImageToUI/')).map((f) => f.path);
    await repo.discard(inside);
    expect(existsSync(path.join(dir, 'Assets/ImageToUI/deep/two.txt'))).toBe(false);
    // deep/ still holds the ignored log: it stays; ImageToUI/ stays with it
    expect(existsSync(path.join(dir, 'Assets/ImageToUI/deep/skip.log'))).toBe(true);
    rmSync(path.join(dir, 'Assets/ImageToUI/deep/skip.log'));
    writeFileSync(path.join(dir, 'Assets/ImageToUI/deep/again.txt'), 'x\n');
    await repo.discard(['Assets/ImageToUI/deep/again.txt']);
    expect(existsSync(path.join(dir, 'Assets/ImageToUI'))).toBe(false);
    expect(existsSync(path.join(dir, 'Assets/nested/inner.txt'))).toBe(true);
  });
});
