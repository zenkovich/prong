import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtureRepo } from './fixture.js';
import { parseDiff } from '../src/git/parse.js';

/**
 * What the history view asks of the engine: the search over the whole history, a file's name in each commit of
 * its history, merges cherry-picked and reverted, a stash made into a branch, diffs with more context, mode changes.
 */
describe('history', () => {
  let root: string;
  let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-history-'));
    fx = await makeFixtureRepo(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('searches the whole history: message, body, author, e-mail, an id prefix; stops at the limit and says so', async () => {
    const all = await fx.repo.log(100);
    const subjects = async (q: string, limit?: number) => (await fx.repo.searchLog(q, ['--all'], limit)).commits.map((c) => c.subject);
    expect((await subjects('FEATURE')).sort()).toEqual(["Merge branch 'feature/x'", 'Add feature', 'Tweak feature'].sort());
    // in the body too
    await fx.repo.commit('Plain subject\n\nthe body mentions a Needle here', { allowEmpty: true });
    expect(await subjects('needle')).toEqual(['Plain subject']);
    expect(await subjects('test@example')).toHaveLength(all.length + 1);
    const change = all.find((c) => c.subject === 'Change b')!;
    expect(await subjects(change.sha.slice(0, 8))).toEqual(['Change b']);
    expect(await subjects('nothing like this')).toEqual([]);
    const capped = await fx.repo.searchLog('test user', ['--all'], 2);
    expect(capped.commits).toHaveLength(2);
    expect(capped.more).toBe(true);
    // within revisions (the branch filter)
    const guide = all.find((c) => c.subject === 'Add guide')!.sha;
    expect((await fx.repo.searchLog('feature', [guide])).commits.map((c) => c.subject)).toEqual([]);
    expect((await fx.repo.searchLog('feature', ['feature/x'])).commits.map((c) => c.subject)).toEqual(['Tweak feature', 'Add feature']);
    expect((await fx.repo.searchLog('', ['--all'])).commits).toEqual([]);
  });

  it('names the file in each commit of its history, across a rename', async () => {
    await fx.repo.git(['mv', 'docs/guide.md', 'docs/manual.md']);
    await fx.repo.commit('Rename the guide');
    const h = await fx.repo.logFile('docs/manual.md');
    expect(h.map((c) => [c.subject, c.fileName])).toEqual([
      ['Rename the guide', 'docs/manual.md'],
      ['Add guide', 'docs/guide.md'],
    ]);
  });

  it('cherry-picks a merge commit (what it brought in) and reverts one', async () => {
    const merge = (await fx.repo.log(20)).find((c) => c.parents.length > 1)!;
    await fx.repo.createBranch('pick-here', 'main~3', true);
    const r = await fx.repo.cherryPick(merge.sha);
    expect(r.conflicts).toBe(false);
    const files = (await fx.repo.git(['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n');
    expect(files).toEqual(['src/feature.ts']);
    await fx.repo.checkout('main');
    const rv = await fx.repo.revert(merge.sha);
    expect(rv.conflicts).toBe(false);
    expect((await fx.repo.git(['ls-tree', '--name-only', '-r', 'HEAD'])).stdout).not.toContain('src/feature.ts');
    await fx.repo.reset('HEAD~1', 'hard');
    await fx.repo.deleteBranch('pick-here', true);
  });

  it('makes a branch from a stash: where it was made, checked out, its changes applied, the stash dropped', async () => {
    const base = await fx.repo.head();
    fx.write('README.md', '# Fixture\nstashed\n');
    await fx.repo.stashPush('wip', false, true);
    // the stash's own commits are not history: not in the log, its pages, the search or a commit's position
    const stashCommit = (await fx.repo.stashes())[0].sha;
    const isStash = (subject: string) => /^(On |WIP on |index on |untracked files on )/.test(subject);
    expect((await fx.repo.log(100)).filter((c) => isStash(c.subject))).toEqual([]);
    expect((await fx.repo.logPage(0, 100)).filter((c) => isStash(c.subject))).toEqual([]);
    expect((await fx.repo.searchLog('wip')).commits).toEqual([]);
    expect(await fx.repo.logPosition(stashCommit)).toBe(-1);
    await fx.repo.commit('Moved on', { allowEmpty: true });
    const made = await fx.repo.stashBranch('from-stash', 0);
    expect(made.name).toBe('from-stash');
    expect(await fx.repo.head()).toBe(base);
    expect((await fx.repo.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('from-stash');
    expect((await fx.repo.status()).unstaged.map((f) => f.path)).toEqual(['README.md']);
    expect(await fx.repo.stashes()).toHaveLength(0);
    await fx.repo.discard(['README.md']);
    await fx.repo.checkout('main');
  });

  it('reads a commit file with more context when asked (Expand context)', async () => {
    fx.write('long.txt', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    await fx.repo.stageAll();
    await fx.repo.commit('Long');
    fx.write('long.txt', Array.from({ length: 30 }, (_, i) => (i === 14 ? 'fifteen' : `line ${i + 1}`)).join('\n') + '\n');
    await fx.repo.stageAll();
    const sha = await fx.repo.commit('Edit long');
    const lines = (f: Awaited<ReturnType<typeof fx.repo.commitFileDiff>>) => f!.hunks!.flatMap((h) => h.lines.map((l) => l.text));
    expect(lines(await fx.repo.commitFileDiff(sha, 'long.txt'))).not.toContain('line 11');
    const wide = lines(await fx.repo.commitFileDiff(sha, 'long.txt', undefined, false, 13));
    expect(wide).toContain('line 2');
    expect(wide).toContain('line 28');
    fx.write('long.txt', Array.from({ length: 30 }, (_, i) => (i === 14 ? 'fifteen!' : `line ${i + 1}`)).join('\n') + '\n');
    expect(lines(await fx.repo.fileDiff('long.txt', 'unstaged', false, 20))).toContain('line 1');
    await fx.repo.discard(['long.txt']);
  });

  it('tells a mode change apart from "no textual changes"', async () => {
    fx.write('run.sh', 'echo hi\n');
    await fx.repo.stageAll();
    await fx.repo.commit('Script');
    chmodSync(path.join(fx.dir, 'run.sh'), 0o755);
    await fx.repo.stageAll();
    const sha = await fx.repo.commit('Make it executable');
    const f = await fx.repo.commitFileDiff(sha, 'run.sh');
    expect(f?.mode).toEqual({ before: '100644', after: '100755' });
    expect(f?.hunks ?? []).toHaveLength(0);
    // the parser alone
    const [p] = parseDiff('diff --git a/x b/x\nold mode 100755\nnew mode 100644\n');
    expect(p.mode).toEqual({ before: '100755', after: '100644' });
  });
});
