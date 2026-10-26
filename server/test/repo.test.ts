import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';
import { makeFixtureRepo } from './fixture.js';

describe('Repo', () => {
  let root: string;
  let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-test-'));
    fx = await makeFixtureRepo(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('detects repositories', () => {
    expect(Repo.isRepo(fx.dir)).toBe(true);
    expect(Repo.isRepo(root)).toBe(false);
  });

  it('builds a snapshot with topo-ordered commits, refs, remotes and clean status', async () => {
    const s = await fx.repo.snapshot();
    expect(s.commits.length).toBe(6);
    expect(s.commits[0].subject).toMatch(/^Merge branch 'feature\/x'/);
    expect(s.commits[0].parents).toHaveLength(2);
    expect(s.head).toBe(s.commits[0].sha);
    const names = s.refs.map((r) => `${r.kind}:${r.name}`);
    expect(names).toContain('branch:main');
    expect(names).toContain('branch:feature/x');
    expect(names).toContain('remote:origin/main');
    expect(names).toContain('tag:v1.0.0');
    const main = s.refs.find((r) => r.name === 'main')!;
    expect(main.current).toBe(true);
    expect(main.upstream).toBe('origin/main');
    expect(main.ahead).toBe(0);
    expect(s.remotes[0]).toMatchObject({ name: 'origin' });
    expect(s.unstaged).toEqual([]);
    expect(s.staged).toEqual([]);
    expect(s.op.kind).toBe('none');
    // every parent sha is present in the list (graph can be laid out)
    const shas = new Set(s.commits.map((c) => c.sha));
    for (const c of s.commits) for (const p of c.parents) expect(shas.has(p)).toBe(true);
  });

  it('shows commit files with hunks', async () => {
    const s = await fx.repo.snapshot();
    const changeB = s.commits.find((c) => c.subject === 'Change b')!;
    const files = await fx.repo.commitFiles(changeB.sha);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(1);
    expect(files[0].hunks![0].lines.find((l) => l.kind === 'add')?.text).toBe('const b = 3;');
  });

  it('stages, unstages, diffs and commits working-copy changes', async () => {
    fx.write('src/a.ts', 'const a = 10;\nconst b = 3;\nexport default a + b;\n');
    fx.write('new.txt', 'hello\n');
    let st = await fx.repo.status();
    expect(st.unstaged.map((f) => `${f.status}:${f.path}`).sort()).toEqual(['?:new.txt', 'M:src/a.ts']);
    expect(st.unstaged.find((f) => f.path === 'src/a.ts')).toMatchObject({ additions: 1, deletions: 1 });
    const d = await fx.repo.fileDiff('src/a.ts', 'unstaged');
    expect(d!.hunks![0].lines.filter((l) => l.kind === 'del')[0].text).toBe('const a = 1;');
    const nd = await fx.repo.fileDiff('new.txt', 'unstaged');
    expect(nd).toMatchObject({ status: '?', additions: 1 });
    await fx.repo.stage(['src/a.ts']);
    st = await fx.repo.status();
    expect(st.staged.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(st.unstaged.map((f) => f.path)).toEqual(['new.txt']);
    const sd = await fx.repo.fileDiff('src/a.ts', 'staged');
    expect(sd!.additions).toBe(1);
    await fx.repo.unstage(['src/a.ts']);
    st = await fx.repo.status();
    expect(st.staged).toEqual([]);
    await fx.repo.stageAll();
    const sha = await fx.repo.commit('Edit a, add new.txt');
    const s = await fx.repo.snapshot();
    expect(s.head).toBe(sha);
    expect(s.commits[0].subject).toBe('Edit a, add new.txt');
    expect(s.unstaged).toEqual([]);
    expect(s.refs.find((r) => r.name === 'main')!.ahead).toBe(1);
  });

  it('stages and unstages a single hunk', async () => {
    fx.write('src/a.ts', 'const a = 10;\nconst b = 3;\nexport default a + b;\n' + '\n'.repeat(20) + 'const z = 1;\n');
    // two separated changes → two hunks after first commit of the base
    await fx.repo.stageAll();
    await fx.repo.commit('Add z');
    fx.write('src/a.ts', 'const a = 11;\nconst b = 3;\nexport default a + b;\n' + '\n'.repeat(20) + 'const z = 2;\n');
    const d = (await fx.repo.fileDiff('src/a.ts', 'unstaged'))!;
    expect(d.hunks!.length).toBe(2);
    await fx.repo.stageHunk(d, d.hunks![0]);
    const staged = (await fx.repo.fileDiff('src/a.ts', 'staged'))!;
    expect(staged.hunks!.length).toBe(1);
    expect(staged.hunks![0].lines.some((l) => l.text === 'const a = 11;')).toBe(true);
    const rest = (await fx.repo.fileDiff('src/a.ts', 'unstaged'))!;
    expect(rest.hunks!.length).toBe(1);
    expect(rest.hunks![0].lines.some((l) => l.text === 'const z = 2;')).toBe(true);
    await fx.repo.unstageHunk(staged, staged.hunks![0]);
    expect((await fx.repo.status()).staged).toEqual([]);
    await fx.repo.discardHunk(rest, rest.hunks![1 - 1]);
    const after = await fx.repo.fileDiff('src/a.ts', 'unstaged');
    expect(after!.hunks!.length).toBe(1);
    await fx.repo.discardAll();
    expect((await fx.repo.status()).unstaged).toEqual([]);
  });

  it('pushes, fetches with progress and tracks ahead/behind', async () => {
    const lines: string[] = [];
    await fx.repo.push({}, (l) => lines.push(l));
    let s = await fx.repo.snapshot();
    expect(s.refs.find((r) => r.name === 'main')!.ahead).toBe(0);
    await fx.repo.fetch('--all', true, (l) => lines.push(l));
    s = await fx.repo.snapshot();
    expect(s.refs.find((r) => r.name === 'origin/main')!.sha).toBe(s.head);
  });

  it('stashes and restores', async () => {
    fx.write('src/a.ts', 'stashed change\n');
    await fx.repo.stashPush('wip test', false, true);
    expect((await fx.repo.status()).unstaged).toEqual([]);
    const stashes = await fx.repo.stashes();
    expect(stashes[0].message).toMatch(/wip test/);
    const files = await fx.repo.stashFiles(0);
    expect(files[0].path).toBe('src/a.ts');
    await fx.repo.stashApply(0, true);
    expect((await fx.repo.status()).unstaged.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(await fx.repo.stashes()).toEqual([]);
    await fx.repo.discardAll();
  });

  it('creates branches, tags, cherry-picks, reverts and resets', async () => {
    const base = await fx.repo.head();
    await fx.repo.createBranch('topic', 'HEAD', true);
    fx.write('topic.txt', 'topic\n');
    await fx.repo.stageAll();
    const topicSha = await fx.repo.commit('Topic commit');
    await fx.repo.checkout('main');
    fx.write('main-moves.txt', 'x\n');
    await fx.repo.stageAll();
    await fx.repo.commit('main moves');
    await fx.repo.cherryPick(topicSha);
    let head = await fx.repo.log(3, ['HEAD']);
    expect(head[0].subject).toBe('Topic commit');
    expect(head[0].sha).not.toBe(topicSha);
    await fx.repo.revert(head[0].sha);
    head = await fx.repo.log(3, ['HEAD']);
    expect(head[0].subject).toMatch(/^Revert "Topic commit"/);
    await fx.repo.reset(base, 'hard');
    expect(await fx.repo.head()).toBe(base);
    await fx.repo.createTag('v1.1.0', 'HEAD');
    expect((await fx.repo.refs()).some((r) => r.kind === 'tag' && r.name === 'v1.1.0')).toBe(true);
    await fx.repo.deleteTag('v1.1.0');
    await fx.repo.renameBranch('topic', 'topic-renamed');
    await fx.repo.deleteBranch('topic-renamed', true);
    expect((await fx.repo.refs()).some((r) => r.name.startsWith('topic'))).toBe(false);
  });

  it('runs an interactive rebase from a todo list (reword, squash, drop)', async () => {
    const base = await fx.repo.head();
    await fx.repo.createBranch('rb', 'HEAD', true);
    for (const n of [1, 2, 3]) {
      fx.write(`rb${n}.txt`, `${n}\n`);
      await fx.repo.stageAll();
      await fx.repo.commit(`rb ${n}`);
    }
    const before = await fx.repo.log(10, ['HEAD']);
    const [c3, c2, c1] = before;
    const r = await fx.repo.rebaseInteractive(base, [
      { sha: c1.sha, action: 'reword', message: 'rb one (reworded)' },
      { sha: c2.sha, action: 'drop' },
      { sha: c3.sha, action: 'squash' },
    ]);
    expect(r.conflicts).toBe(false);
    const after = await fx.repo.log(10, ['HEAD']);
    expect(after[0].subject).toBe('rb one (reworded)');
    expect(after[0].body).toContain('rb 3');
    expect(after[1].sha).toBe(base);
    expect(existsSync(path.join(fx.dir, 'rb2.txt'))).toBe(false);
    expect(existsSync(path.join(fx.dir, 'rb3.txt'))).toBe(true);
    await fx.repo.checkout('main');
    await fx.repo.deleteBranch('rb', true);
  });

  it('reports merge conflicts and aborts', async () => {
    const base = await fx.repo.head();
    await fx.repo.createBranch('c1', 'HEAD', true);
    fx.write('conflict.txt', 'one\n');
    await fx.repo.stageAll();
    await fx.repo.commit('c1');
    await fx.repo.checkout('main');
    fx.write('conflict.txt', 'two\n');
    await fx.repo.stageAll();
    await fx.repo.commit('main side');
    const m = await fx.repo.merge('c1');
    expect(m.conflicts).toBe(true);
    const st = await fx.repo.status();
    expect(st.unstaged.find((f) => f.path === 'conflict.txt')?.status).toBe('U');
    expect((await fx.repo.opState()).kind).toBe('merge');
    await fx.repo.mergeAbort();
    expect((await fx.repo.opState()).kind).toBe('none');
    await fx.repo.reset(base, 'hard');
    await fx.repo.deleteBranch('c1', true);
  });

  it('clones with progress', async () => {
    const dest = path.join(root, 'cloned');
    const lines: string[] = [];
    const r = await Repo.clone(fx.bare, dest, false, (l) => lines.push(l));
    const s = await r.snapshot();
    expect(s.commits.length).toBeGreaterThan(0);
    expect(s.remotes[0].url).toBe(fx.bare);
  });
});
