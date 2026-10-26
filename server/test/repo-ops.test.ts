import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';
import { makeFixtureRepo } from './fixture.js';
import { runGit } from '../src/git/run.js';

/** Operations the first repo suite does not touch: remotes, upstreams, discard, blame, file history, rebase, pull, amend. */
describe('Repo operations', () => {
  let root: string;
  let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-ops-'));
    fx = await makeFixtureRepo(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('adds, edits and removes remotes', async () => {
    await fx.repo.addRemote('mirror', 'https://example.com/a.git');
    expect((await fx.repo.remotes()).map((r) => r.name).sort()).toEqual(['mirror', 'origin']);
    await fx.repo.setRemoteUrl('mirror', 'https://example.com/b.git');
    expect((await fx.repo.remotes()).find((r) => r.name === 'mirror')?.url).toBe('https://example.com/b.git');
    await fx.repo.removeRemote('mirror');
    expect((await fx.repo.remotes()).map((r) => r.name)).toEqual(['origin']);
  });

  it('sets an upstream and reports it on the branch', async () => {
    await fx.repo.createBranch('tracked', 'HEAD', true);
    await fx.repo.push({ remote: 'origin', branch: 'tracked' });
    await fx.repo.setUpstream('tracked', 'origin/tracked');
    const b = (await fx.repo.refs()).find((r) => r.kind === 'branch' && r.name === 'tracked');
    expect(b?.upstream).toBe('origin/tracked');
    await fx.repo.checkout('main');
    await fx.repo.deleteBranch('tracked', true);
  });

  it('discards tracked modifications and untracked files', async () => {
    fx.write('src/a.ts', 'broken\n');
    fx.write('junk.txt', 'junk\n');
    let st = await fx.repo.status();
    expect(st.unstaged.map((f) => f.path).sort()).toEqual(['junk.txt', 'src/a.ts']);
    await fx.repo.discard(['src/a.ts', 'junk.txt']);
    st = await fx.repo.status();
    expect(st.unstaged).toHaveLength(0);
    expect(existsSync(path.join(fx.dir, 'junk.txt'))).toBe(false);
    fx.write('more.txt', 'x\n');
    fx.write('README.md', 'changed\n');
    await fx.repo.discardAll();
    expect((await fx.repo.status()).unstaged).toHaveLength(0);
    expect(readFileSync(path.join(fx.dir, 'README.md'), 'utf8')).toBe('# Fixture\n');
  });

  it('blames lines and lists a file history with contents at a revision', async () => {
    const blame = await fx.repo.blame('src/a.ts');
    expect(blame).toHaveLength(3);
    expect(blame[1].line).toBe('const b = 3;');
    expect(blame[1].author).toBe('Test User');
    expect(blame[1].sha).toMatch(/^[0-9a-f]{40}$/);
    const history = await fx.repo.logFile('src/a.ts');
    expect(history.map((c) => c.subject)).toEqual(['Change b', 'Initial commit']);
    expect(await fx.repo.fileAt(history[1].sha, 'src/a.ts')).toContain('const b = 2;');
    expect(await fx.repo.fileAt(history[1].sha, 'nope.ts')).toBeNull();
  });

  it('checks out a detached commit and appends ignore patterns', async () => {
    const commits = await fx.repo.log(5, ['HEAD']);
    await fx.repo.checkoutDetached(commits[2].sha);
    expect((await fx.repo.refs()).some((r) => r.kind === 'branch' && r.current)).toBe(false);
    expect(await fx.repo.head()).toBe(commits[2].sha);
    await fx.repo.checkout('main');
    await fx.repo.appendIgnore('*.log');
    await fx.repo.appendIgnore('tmp/');
    expect(readFileSync(path.join(fx.dir, '.gitignore'), 'utf8')).toContain('*.log\n');
    expect(readFileSync(path.join(fx.dir, '.gitignore'), 'utf8')).toContain('tmp/\n');
    await fx.repo.discardAll();
    rmSync(path.join(fx.dir, '.gitignore'), { force: true });
  });

  it('rebases a branch, reports conflicts, continues after resolving and aborts', async () => {
    await fx.repo.createBranch('rb', 'HEAD', true);
    fx.write('rb.txt', 'rb\n');
    await fx.repo.stageAll();
    await fx.repo.commit('rb commit');
    await fx.repo.checkout('main');
    fx.write('main2.txt', 'm\n');
    await fx.repo.stageAll();
    await fx.repo.commit('main 2');
    await fx.repo.checkout('rb');
    expect((await fx.repo.rebase('main')).conflicts).toBe(false);
    expect((await fx.repo.log(2, ['HEAD'])).map((c) => c.subject)).toEqual(['rb commit', 'main 2']);

    // now a real conflict on the same file
    fx.write('clash.txt', 'rb side\n');
    await fx.repo.stageAll();
    await fx.repo.commit('rb clash');
    await fx.repo.checkout('main');
    fx.write('clash.txt', 'main side\n');
    await fx.repo.stageAll();
    await fx.repo.commit('main clash');
    await fx.repo.checkout('rb');
    expect((await fx.repo.rebase('main')).conflicts).toBe(true);
    expect((await fx.repo.opState()).kind).toBe('rebase');
    await fx.repo.rebaseAbort();
    expect((await fx.repo.opState()).kind).toBe('none');
    expect((await fx.repo.rebase('main')).conflicts).toBe(true);
    writeFileSync(path.join(fx.dir, 'clash.txt'), 'both sides\n');
    await fx.repo.stage(['clash.txt']);
    await fx.repo.rebaseContinue();
    expect((await fx.repo.opState()).kind).toBe('none');
    expect((await fx.repo.log(1, ['HEAD']))[0].subject).toBe('rb clash');
    await fx.repo.checkout('main');
    await fx.repo.deleteBranch('rb', true);
  });

  it('pulls fast-forward changes pushed from another clone', async () => {
    const other = path.join(root, 'other');
    await Repo.clone(fx.bare, other, false);
    const o = new Repo(other);
    await o.setConfig('user.name', 'Other');
    await o.setConfig('user.email', 'other@example.com');
    writeFileSync(path.join(other, 'from-other.txt'), 'hi\n');
    await o.stageAll();
    await o.commit('From other clone');
    await o.push({ remote: 'origin', branch: 'main' });
    await fx.repo.fetch();
    const main = (await fx.repo.refs()).find((r) => r.kind === 'branch' && r.name === 'main');
    expect(main?.behind).toBe(1);
    await fx.repo.pull('merge');
    expect(existsSync(path.join(fx.dir, 'from-other.txt'))).toBe(true);
    expect((await fx.repo.refs()).find((r) => r.kind === 'branch' && r.name === 'main')?.behind ?? 0).toBe(0);
  });

  it('amends the last commit and allows empty commits', async () => {
    const before = await fx.repo.log(1, ['HEAD']);
    fx.write('amend.txt', 'a\n');
    await fx.repo.stageAll();
    const sha = await fx.repo.commit(`${before[0].subject} (amended)`, { amend: true });
    const after = await fx.repo.log(1, ['HEAD']);
    expect(after[0].sha).toBe(sha);
    expect(after[0].subject).toBe(`${before[0].subject} (amended)`);
    expect((await fx.repo.commitFiles(sha)).some((f) => f.path === 'amend.txt')).toBe(true);
    const empty = await fx.repo.commit('empty marker', { allowEmpty: true });
    expect((await fx.repo.commitFiles(empty))).toHaveLength(0);
  });

  it('stashes with keep-index and untracked files, drops a stash', async () => {
    fx.write('keep.txt', 'staged\n');
    await fx.repo.stage(['keep.txt']);
    fx.write('untracked.txt', 'u\n');
    await fx.repo.stashPush('mixed', true, true);
    let st = await fx.repo.status();
    expect(st.staged.map((f) => f.path)).toEqual(['keep.txt']); // kept in the index
    expect(existsSync(path.join(fx.dir, 'untracked.txt'))).toBe(false);
    const stashes = await fx.repo.stashes();
    expect(stashes[0].message).toContain('mixed');
    await fx.repo.stashDrop(0);
    expect(await fx.repo.stashes()).toHaveLength(0);
    await fx.repo.unstageAll();
    await fx.repo.discardAll();
    st = await fx.repo.status();
    expect(st.staged).toHaveLength(0);
  });

  it('pages the log and filters by revision', async () => {
    const all = await fx.repo.log(50, ['--all']);
    const page = await fx.repo.logPage(2, 3);
    expect(page.map((c) => c.sha)).toEqual(all.slice(2, 5).map((c) => c.sha));
    const onlyMain = await fx.repo.log(50, ['main']);
    expect(onlyMain.length).toBeLessThanOrEqual(all.length);
    expect(onlyMain.every((c) => all.some((a) => a.sha === c.sha))).toBe(true);
  });
});

describe('branch deletion', () => {
  let root: string;
  let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-del-'));
    fx = await makeFixtureRepo(root);
    await fx.repo.push({ remote: 'origin', branch: 'feature/x' });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const names = async () => (await fx.repo.refs()).map((r) => r.name);

  it('deletes a remote branch without touching local branches', async () => {
    expect(await names()).toContain('origin/feature/x');
    await fx.repo.deleteRemoteBranch('origin', 'feature/x');
    expect(await names()).not.toContain('origin/feature/x');
    expect(await names()).toContain('feature/x');
  });
  it('drops a stale remote-tracking ref when the remote already lost the branch', async () => {
    await fx.repo.push({ remote: 'origin', branch: 'feature/x' });
    await runGit(['push', fx.bare, '--delete', 'feature/x'], { cwd: fx.dir }); // deleted elsewhere
    expect(await names()).toContain('origin/feature/x');
    await fx.repo.deleteRemoteBranch('origin', 'feature/x');
    expect(await names()).not.toContain('origin/feature/x');
  });
  it('deletes a local branch together with the branch it tracks on the remote', async () => {
    await fx.repo.createBranch('tmp/one', 'HEAD', false);
    await fx.repo.push({ remote: 'origin', branch: 'tmp/one', setUpstream: false });
    await fx.repo.setUpstream('tmp/one', 'origin/tmp/one');
    await fx.repo.deleteBranch('tmp/one', true, 'origin');
    const n = await names();
    expect(n).not.toContain('tmp/one');
    expect(n).not.toContain('origin/tmp/one');
    const remote = (await runGit(['branch', '--list', 'tmp/one'], { cwd: fx.bare })).stdout.trim();
    expect(remote).toBe('');
  });
});

describe('partial staging through hunk patches', () => {
  let root: string;
  let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-lines-'));
    fx = await makeFixtureRepo(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('stages only some lines of a brand-new (untracked) file', async () => {
    fx.write('notes.txt', 'a\nb\nc\n');
    const f = (await fx.repo.fileDiff('notes.txt', 'unstaged'))!;
    expect(f.status).toBe('?');
    // what the app builds for "pick lines 1 and 3": a creation with just those lines
    const part = { id: 'p', header: '@@ -0,0 +1,2 @@', lines: [f.hunks![0].lines[0], f.hunks![0].lines[2]] };
    await fx.repo.stageHunk(f, part);
    const cached = (await runGit(['show', ':0:notes.txt'], { cwd: fx.dir })).stdout;
    expect(cached).toBe('a\nc\n');
    expect(readFileSync(path.join(fx.dir, 'notes.txt'), 'utf8')).toBe('a\nb\nc\n');
  });
  it('unstages one line of a staged change with a reverse patch', async () => {
    const s = (await fx.repo.fileDiff('notes.txt', 'staged'))!;
    // remove "c" from the index, keep "a": the unpicked addition stays as context
    const lines = s.hunks![0].lines;
    const part = { id: 'u', header: '@@ -1,1 +1,2 @@', lines: [{ ...lines[0], kind: 'ctx' as const }, lines[1]] };
    await fx.repo.unstageHunk(s, part);
    expect((await runGit(['show', ':0:notes.txt'], { cwd: fx.dir })).stdout).toBe('a\n');
  });
});
