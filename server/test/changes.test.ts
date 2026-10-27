import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';
import { runGit } from '../src/git/run.js';
import { parseDiff } from '../src/git/parse.js';

/** The Changes view's engine side: what a user stages, sees and resolves, against real git. */
async function freshRepo(root: string, name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  const repo = await Repo.init(dir);
  await repo.setConfig('user.name', 'Test User');
  await repo.setConfig('user.email', 'test@example.com');
  await repo.setConfig('commit.gpgsign', 'false');
  const write = (f: string, c: string) => writeFileSync(path.join(dir, f), c);
  for (const [f, c] of Object.entries(files)) write(f, c);
  await repo.stageAll();
  await repo.commit('Initial commit');
  return { repo, dir, write, index: async (f: string) => (await runGit(['show', `:0:${f}`], { cwd: dir })).stdout };
}

describe('Changes: diffs and staging', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-changes-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('stages, unstages and discards a hunk of a file with no newline at its end', async () => {
    const fx = await freshRepo(root, 'noeol', { 'f.txt': 'a\nb' });
    fx.write('f.txt', 'a\nc');
    const f = (await fx.repo.fileDiff('f.txt', 'unstaged'))!;
    expect(f.hunks![0].lines.filter((l) => l.noEol).map((l) => l.text)).toEqual(['b', 'c']);
    // "patch does not apply" before: the marker was dropped
    await fx.repo.stageHunk(f, f.hunks![0]);
    expect(await fx.index('f.txt')).toBe('a\nc');
    const s = (await fx.repo.fileDiff('f.txt', 'staged'))!;
    await fx.repo.unstageHunk(s, s.hunks![0]);
    expect(await fx.index('f.txt')).toBe('a\nb');
    const u = (await fx.repo.fileDiff('f.txt', 'unstaged'))!;
    await fx.repo.discardHunk(u, u.hunks![0]);
    expect(readFileSync(path.join(fx.dir, 'f.txt'), 'utf8')).toBe('a\nb');
  });

  it('stages single lines next to the missing final newline (the patches src/git/lineStaging builds)', async () => {
    const fx = await freshRepo(root, 'noeol-lines', { 'f.txt': 'a\nb' });
    fx.write('f.txt', 'a\nc');
    const f = (await fx.repo.fileDiff('f.txt', 'unstaged'))!;
    const L = (kind: 'ctx' | 'add' | 'del', text: string, noEol = false) => ({ kind, text, ...(noEol ? { noEol } : {}) });
    // only the new line: the old last line stays and gets a newline
    await fx.repo.stageHunk(f, { id: 'p1', header: '@@ -1,2 +1,3 @@', lines: [L('ctx', 'a'), L('del', 'b', true), L('add', 'b'), L('add', 'c', true)] });
    expect(await fx.index('f.txt')).toBe('a\nb\nc');
    await fx.repo.unstageAll();
    // only the removal
    await fx.repo.stageHunk(f, { id: 'p2', header: '@@ -1,2 +1,1 @@', lines: [L('ctx', 'a'), L('del', 'b', true)] });
    expect(await fx.index('f.txt')).toBe('a\n');
    await fx.repo.unstageAll();
    // discard only the removal: b comes back, c stays last without a newline
    await fx.repo.discardHunk(f, { id: 'p3', header: '@@ -1,3 +1,2 @@', lines: [L('ctx', 'a'), L('del', 'b'), L('ctx', 'c', true)] });
    expect(readFileSync(path.join(fx.dir, 'f.txt'), 'utf8')).toBe('a\nb\nc');
  });

  it('reads removed and added lines that look like file headers ("-- comment" in SQL or Lua)', async () => {
    const fx = await freshRepo(root, 'sql', { 'q.sql': 'select 1;\n-- old comment\nselect 2;\n' });
    fx.write('q.sql', 'select 1;\n++ new\nselect 2;\n');
    const f = (await fx.repo.fileDiff('q.sql', 'unstaged'))!;
    expect(f.hunks![0].lines.map((l) => l.kind + ':' + l.text)).toEqual(['ctx:select 1;', 'del:-- old comment', 'add:++ new', 'ctx:select 2;']);
    expect([f.additions, f.deletions]).toEqual([1, 1]);
    await fx.repo.stageHunk(f, f.hunks![0]);
    expect(await fx.index('q.sql')).toBe('select 1;\n++ new\nselect 2;\n');
  });

  it('counts a staged rename as its two rows (D and A, as the status lists it) and marks binaries', async () => {
    const fx = await freshRepo(root, 'counts', { 'old.txt': 'one\ntwo\n', 'data.bin': 'x\0y' });
    await fx.repo.git(['mv', 'old.txt', 'new.txt']);
    fx.write('data.bin', 'x\0z\0w');
    const st = await fx.repo.status();
    const staged = Object.fromEntries(st.staged.map((f) => [f.path, [f.status, f.additions, f.deletions]]));
    expect(staged).toEqual({ 'new.txt': ['A', 2, 0], 'old.txt': ['D', 0, 2] });
    const bin = st.unstaged.find((f) => f.path === 'data.bin')!;
    expect(bin.kind).toBe('binary');
  });

  it('explains a change without lines: a mode change', async () => {
    const fx = await freshRepo(root, 'mode', { 'run.sh': 'echo hi\n' });
    chmodSync(path.join(fx.dir, 'run.sh'), 0o755);
    const f = (await fx.repo.fileDiff('run.sh', 'unstaged'))!;
    expect(f.mode).toEqual({ before: '100644', after: '100755' });
    expect(f.hunks).toBeUndefined();
    const [p] = parseDiff('diff --git a/x b/x\nold mode 100755\nnew mode 100644\n');
    expect(p.mode).toEqual({ before: '100755', after: '100644' });
  });

  it('leaves a repository of its own alone when discarding (its history cannot be copied for Undo)', async () => {
    const fx = await freshRepo(root, 'nested', { 'a.txt': 'a\n' });
    const inner = path.join(fx.dir, 'vendor/lib');
    mkdirSync(inner, { recursive: true });
    await runGit(['init', '-q'], { cwd: inner });
    writeFileSync(path.join(inner, 'x.txt'), 'x\n');
    fx.write('junk.txt', 'junk\n');
    const listed = (await fx.repo.status()).unstaged.map((f) => f.path).sort();
    expect(listed).toEqual(['junk.txt', 'vendor/lib/']);
    expect(await fx.repo.discard(['junk.txt', 'vendor/lib/'])).toEqual({ kept: ['vendor/lib/'] });
    // the rest of the discard happened, the repository is untouched
    expect(existsSync(path.join(fx.dir, 'junk.txt'))).toBe(false);
    expect(existsSync(path.join(inner, '.git')) && existsSync(path.join(inner, 'x.txt'))).toBe(true);
  });

  it('reads non-ASCII names in diffs as they are (git quoted them: "\\321\\204…")', async () => {
    const fx = await freshRepo(root, 'cyrillic', { 'файл.txt': 'a\n', 'фото.png': '\x89PNG\0\0\0' });
    fx.write('файл.txt', 'b\n');
    const f = (await fx.repo.fileDiff('файл.txt', 'unstaged'))!;
    expect(f.hunks![0].lines.map((l) => l.text)).toEqual(['a', 'b']);
    await fx.repo.stageHunk({ ...f, path: 'файл.txt' }, f.hunks![0]);
    expect(await fx.index('файл.txt')).toBe('b\n');
    const head = await fx.repo.commitFiles((await fx.repo.head()) as string);
    expect(head.map((x) => x.path).sort()).toEqual(['файл.txt', 'фото.png']);
    expect(head.find((x) => x.path === 'фото.png')?.kind).toBe('image');
  });

  it('adds lines to .gitignore on lines of their own (an empty file gets no blank first line)', async () => {
    const fx = await freshRepo(root, 'ignore', { 'a.txt': 'a\n', '.gitignore': '' });
    await fx.repo.appendIgnore('/one.txt');
    await fx.repo.appendIgnore('/two.txt\n/three.txt');
    expect(readFileSync(path.join(fx.dir, '.gitignore'), 'utf8')).toBe('/one.txt\n/two.txt\n/three.txt\n');
  });
});

describe('Changes: merge conflicts', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-conflicts-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** main and other both change line 2 of a.txt; `other` also deletes gone.txt, which main changes */
  async function conflicted(name: string, how: 'merge' | 'cherry-pick' = 'merge') {
    const fx = await freshRepo(root, name, { 'a.txt': 'top\nbase\nend\n', 'gone.txt': 'g\n' });
    await fx.repo.createBranch('other', 'HEAD', true);
    fx.write('a.txt', 'top\ntheirs\nend\n');
    await fx.repo.git(['rm', '-q', 'gone.txt']);
    await fx.repo.stageAll();
    await fx.repo.commit('Their change');
    await fx.repo.checkout('main');
    fx.write('a.txt', 'top\nours\nend\n');
    fx.write('gone.txt', 'g changed\n');
    await fx.repo.stageAll();
    await fx.repo.commit('Our change');
    const r = how === 'merge' ? await fx.repo.merge('other') : await fx.repo.cherryPick('other');
    expect(r.conflicts).toBe(true);
    return fx;
  }

  it('shows the conflicting regions of ours, the base and theirs (a conflicted file used to read as "No textual changes")', async () => {
    const fx = await conflicted('sides');
    const f = (await fx.repo.fileDiff('a.txt', 'unstaged'))!;
    expect(f.status).toBe('U');
    expect(f.conflict).toEqual({ ours: ['ours'], base: ['base'], theirs: ['theirs'] });
    const d = (await fx.repo.fileDiff('gone.txt', 'unstaged'))!;
    expect(d.conflict?.deleted).toBe('theirs');
    expect(await fx.repo.conflictOf('README-none')).toBeNull();
  });

  it('keeps both sides, ours first, and marks the file resolved', async () => {
    const fx = await conflicted('both');
    await fx.repo.resolveConflict('a.txt', 'both');
    expect(readFileSync(path.join(fx.dir, 'a.txt'), 'utf8')).toBe('top\nours\ntheirs\nend\n');
    expect(await fx.repo.stages('a.txt')).toEqual({});
    await expect(fx.repo.resolveConflict('gone.txt', 'both')).rejects.toThrow(/deleted on one side/);
  });

  it('takes the side that deleted the file by deleting it, the other by keeping it', async () => {
    const fx = await conflicted('deleted');
    await fx.repo.resolveConflict('gone.txt', 'theirs');
    expect((await fx.repo.status()).staged.find((f) => f.path === 'gone.txt')?.status).toBe('D');
    const fx2 = await conflicted('kept');
    await fx2.repo.resolveConflict('gone.txt', 'ours');
    expect(readFileSync(path.join(fx2.dir, 'gone.txt'), 'utf8')).toBe('g changed\n');
    expect(await fx2.repo.stages('gone.txt')).toEqual({});
  });

  it('a merge in progress carries the message git prepared; Abort ends it', async () => {
    const fx = await conflicted('msg');
    const op = await fx.repo.opState();
    expect(op.kind).toBe('merge');
    expect(op.message).toMatch(/^Merge branch 'other'/);
    expect(op.message).not.toMatch(/#/);
    await fx.repo.mergeAbort();
    expect((await fx.repo.opState()).kind).toBe('none');
  });

  it('Abort ends a cherry-pick that stopped on conflicts ("There is no merge to abort" before)', async () => {
    const fx = await conflicted('cp', 'cherry-pick');
    const op = await fx.repo.opState();
    expect(op.kind).toBe('cherry-pick');
    expect(op.message).toBe('Their change');
    await fx.repo.mergeAbort();
    expect((await fx.repo.opState()).kind).toBe('none');
    expect(readFileSync(path.join(fx.dir, 'a.txt'), 'utf8')).toBe('top\nours\nend\n');
  });

  it('sees an operation in a repository whose .git is a file (a submodule, a worktree)', async () => {
    const fx = await conflicted('linked');
    const linked = path.join(root, 'linked-view');
    await runGit(['init', '-q', linked], { cwd: root });
    rmSync(path.join(linked, '.git'), { recursive: true, force: true });
    writeFileSync(path.join(linked, '.git'), `gitdir: ${path.join(fx.dir, '.git')}\n`);
    expect((await new Repo(linked).opState()).kind).toBe('merge');
  });
});
