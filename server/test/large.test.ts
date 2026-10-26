import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRaw } from '../src/git/parse.js';
import { COMMIT_PATCH_FILES, Repo } from '../src/git/repo.js';
import { runGit, runGitLines } from '../src/git/run.js';

/**
 * Large repositories: a commit with more files than the patch limit, history positions, capped git output.
 * (homescapes: a merge with 55 000 files produced a 930 MB patch; a branch 8 000 commits deep froze the client.)
 */
describe('large repositories', () => {
  let dir: string;
  let repo: Repo;
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).toString();
  let wide = '';
  let first = '';
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'prong-large-'));
    git('init', '-q', '-b', 'main');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    first = git('rev-parse', 'HEAD').trim();
    // one commit touching more files than the patch limit, in a few folders
    for (let i = 0; i < COMMIT_PATCH_FILES + 20; i++) {
      const d = path.join(dir, `pkg${i % 4}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, `f${i}.txt`), `line ${i}\n`);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'wide');
    wide = git('rev-parse', 'HEAD').trim();
    for (let i = 0; i < 30; i++) git('commit', '-q', '--allow-empty', '-m', `c${i}`);
    git('branch', 'old', first);
    repo = new Repo(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lists a commit with very many files without diffs, then reads one diff on demand', async () => {
    const files = await repo.commitFiles(wide);
    expect(files.length).toBe(COMMIT_PATCH_FILES + 20);
    expect(files.every((f) => f.lazy && !f.hunks && f.status === 'A')).toBe(true);
    const one = await repo.commitFileDiff(wide, 'pkg1/f1.txt');
    expect(one?.hunks?.[0].lines.map((l) => l.text)).toEqual(['line 1']);
    expect(one?.lazy).toBeFalsy();
  });

  it('keeps sending small commits with their diffs', async () => {
    const files = await repo.commitFiles(first);
    expect(files).toHaveLength(1);
    expect(files[0].lazy).toBeFalsy();
    expect(files[0].hunks?.[0].lines[0].text).toBe('a');
  });

  it('finds the position of a commit in the date-ordered log and stops early', async () => {
    const head = git('rev-parse', 'HEAD').trim();
    expect(await repo.logPosition(head)).toBe(0);
    expect(await repo.logPosition(wide)).toBe(30);
    expect(await repo.logPosition(first)).toBe(31);
    expect(await repo.logPosition(first, ['--all'], 10)).toBe(-1); // deeper than asked
    expect(await repo.logPosition('0'.repeat(40))).toBe(-1);
    // within a filter: the old branch has only its first commit
    expect(await repo.logPosition(first, ['old'])).toBe(0);
  });

  it('reads the log down to a commit and a few past it in one pass', async () => {
    const r = await repo.logUntil(wide, 2, 1);
    expect(r.index).toBe(30);
    expect(r.commits[0].subject).toBe('c27'); // skipped c29, c28
    expect(r.commits.at(-2)?.sha).toBe(wide);
    expect(r.commits.at(-1)?.sha).toBe(first);
    expect((await repo.logUntil(first, 0, 0, ['--all'], 10)).index).toBe(-1); // deeper than allowed
  });

  it('cuts git output at maxBytes and says so', async () => {
    const r = await runGit(['log', '--format=%H %s'], { cwd: dir, maxBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBe(100);
    const full = await runGit(['log', '--format=%H %s'], { cwd: dir, maxBytes: 1 << 20 });
    expect(full.truncated).toBeFalsy();
  });

  it('streams lines and stops when told to', async () => {
    const seen: string[] = [];
    const n = await runGitLines(['rev-list', 'HEAD'], { cwd: dir }, (l) => {
      seen.push(l);
      return seen.length < 3;
    });
    expect(n).toBe(3);
    expect(seen).toHaveLength(3);
  });

  it('file history follows renames hop by hop', async () => {
    const w = (f: string, t: string) => writeFileSync(path.join(dir, f), t);
    w('orig.txt', 'one\ntwo\nthree\nfour\nfive\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'add orig');
    w('orig.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n');
    git('commit', '-qam', 'edit orig');
    git('mv', 'orig.txt', 'middle.txt');
    git('commit', '-qm', 'rename to middle');
    w('middle.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    git('commit', '-qam', 'edit middle');
    git('mv', 'middle.txt', 'final.txt');
    git('commit', '-qm', 'rename to final');
    const h = await repo.logFile('final.txt');
    expect(h.map((c) => c.subject)).toEqual(['rename to final', 'edit middle', 'rename to middle', 'edit orig', 'add orig']);
    expect((await repo.logFile('final.txt', 2)).map((c) => c.subject)).toEqual(['rename to final', 'edit middle']);
    // history and blame of a file as it was in an older commit (its old name is gone from the working copy)
    const editOrig = h.find((c) => c.subject === 'edit orig')!.sha;
    expect((await repo.logFile('orig.txt', 200, editOrig)).map((c) => c.subject)).toEqual(['edit orig', 'add orig']);
    const blame = await repo.blame('orig.txt', editOrig);
    expect(blame.map((l) => l.line)).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
    await expect(repo.blame('orig.txt')).rejects.toThrow();
  });

  it('parses raw listings: statuses, renames, submodules, one entry per path', () => {
    const z = '0'.repeat(40);
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const out = [`:100644 100644 ${a} ${b} M\tsrc/x.ts`, `:000000 100644 ${z} ${b} A\timg/new.png`, `:100644 100644 ${a} ${b} R087\told/name.txt\tnew/name.txt`, `:160000 160000 ${a} ${b} M\tlibs/core`, `:100644 100644 ${a} ${b} M\tsrc/x.ts`, ''].join('\n');
    const files = parseRaw(out);
    expect(files.map((f) => [f.path, f.status, f.kind, !!f.lazy])).toEqual([
      ['src/x.ts', 'M', 'text', true],
      ['img/new.png', 'A', 'image', true],
      ['new/name.txt', 'R', 'text', true],
      ['libs/core', 'M', 'submodule', false],
    ]);
    expect(files[2].oldPath).toBe('old/name.txt');
    expect(files[3].submodule).toEqual({ before: a, after: b });
  });
});
