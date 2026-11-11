import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/git/repo.js';
import { discardWithUndo, restoreFromUndo } from '../src/undo.js';

/**
 * Discarding thousands of files (Fork does it at once): one status for the plan, files put back by name from the
 * index, what is dropped moved aside for Undo (not copied); and submodules: moved back to the recorded commit, or
 * at it, their own changes dropped.
 */
describe('discard: many files, Undo by moving aside, submodules', () => {
  let root: string;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString().trim();
  const make = (name: string) => {
    const dir = path.join(root, name);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'commit.gpgsign', 'false');
    return dir;
  };
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-discard-fast-'));
    process.env.PRONG_STATE_DIR = path.join(root, 'state');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('3 000 picked files of 6 000: changed, deleted and new ones go, the rest stay; Undo brings them all back', async () => {
    const dir = make('many');
    const name = (i: number) => `a/d${i % 40}/f${i}.txt`;
    for (let i = 0; i < 6000; i++) {
      mkdirSync(path.dirname(path.join(dir, name(i))), { recursive: true });
      writeFileSync(path.join(dir, name(i)), `${i}\n`);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    const picked: string[] = [];
    for (let i = 0; i < 2500; i++) {
      writeFileSync(path.join(dir, name(i)), `changed ${i}\n`);
      picked.push(name(i));
    }
    for (let i = 2500; i < 2600; i++) {
      rmSync(path.join(dir, name(i)));
      picked.push(name(i));
    }
    // not picked: stays changed
    writeFileSync(path.join(dir, name(5000)), 'mine\n');
    mkdirSync(path.join(dir, 'new/deep'), { recursive: true });
    for (let i = 0; i < 400; i++) {
      writeFileSync(path.join(dir, `new/deep/n${i}.txt`), `n${i}\n`);
      picked.push(`new/deep/n${i}.txt`);
    }
    writeFileSync(path.join(dir, 'new/keep.txt'), 'not picked\n');
    const repo = new Repo(dir);
    const plan = await repo.discardPlan(picked);
    expect(plan.restore.length).toBe(2600);
    expect(plan.absent.length).toBe(100);
    expect(plan.remove.length).toBe(400);
    const t = Date.now();
    const { undo } = await discardWithUndo(repo, plan);
    const took = Date.now() - t;
    expect(undo).toBeTruthy();
    expect(git(dir, 'status', '--porcelain', '-uall').split('\n').map((l) => l.trim()).sort()).toEqual(['?? new/keep.txt', 'M a/d0/f5000.txt']);
    expect(existsSync(path.join(dir, 'new/deep'))).toBe(false);
    expect(readFileSync(path.join(dir, name(7)), 'utf8')).toBe('7\n');
    // nothing was copied: the dropped files were moved into the undo folder
    expect(took).toBeLessThan(20_000);
    await restoreFromUndo(repo, undo!);
    expect(readFileSync(path.join(dir, name(7)), 'utf8')).toBe('changed 7\n');
    expect(existsSync(path.join(dir, name(2550)))).toBe(false);
    expect(readFileSync(path.join(dir, 'new/deep/n9.txt'), 'utf8')).toBe('n9\n');
    expect(git(dir, 'status', '--porcelain').split('\n').length).toBe(2600 + 1 + 1);
  });

  it('a whole untracked folder goes in one move; a few paths are asked about by name; a discard that fails puts everything back', async () => {
    const dir = make('few');
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'a');
    mkdirSync(path.join(dir, 'tmp/x'), { recursive: true });
    writeFileSync(path.join(dir, 'tmp/x/1.txt'), '1\n');
    writeFileSync(path.join(dir, 'a.txt'), 'a changed\n');
    const repo = new Repo(dir);
    const plan = await repo.discardPlan(['tmp/', 'a.txt']);
    expect(plan.remove).toEqual(['tmp/']);
    // the index is locked: git refuses to write it; what was moved aside comes back
    writeFileSync(path.join(dir, '.git/index.lock'), '');
    await expect(discardWithUndo(repo, plan)).rejects.toThrow();
    rmSync(path.join(dir, '.git/index.lock'));
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a changed\n');
    expect(readFileSync(path.join(dir, 'tmp/x/1.txt'), 'utf8')).toBe('1\n');
    expect(readdirSync(path.join(process.env.PRONG_STATE_DIR!, 'undo'))).toEqual([]);
    const { undo } = await discardWithUndo(repo, plan);
    expect(existsSync(path.join(dir, 'tmp'))).toBe(false);
    await restoreFromUndo(repo, undo!);
    expect(readFileSync(path.join(dir, 'tmp/x/1.txt'), 'utf8')).toBe('1\n');
  });

  it('submodules: one at the recorded commit has its own changes dropped (and back with Undo); a moved one goes back to the recorded commit (and back to its branch)', async () => {
    const core = make('core');
    writeFileSync(path.join(core, 'core.txt'), 'core\n');
    git(core, 'add', '-A');
    git(core, 'commit', '-qm', 'core');
    const sup = make('super');
    for (const p of ['libs/edited', 'libs/moved']) git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', core, p);
    git(sup, 'commit', '-qm', 'subs');
    const at = (p: string) => path.join(sup, p);
    for (const p of ['libs/edited', 'libs/moved']) git(at(p), 'config', 'commit.gpgsign', 'false');
    writeFileSync(at('libs/edited/core.txt'), 'core\nedited\n');
    writeFileSync(at('libs/edited/new.txt'), 'new\n');
    const recorded = git(at('libs/moved'), 'rev-parse', 'HEAD');
    git(at('libs/moved'), 'switch', '-q', '-c', 'work');
    writeFileSync(at('libs/moved/core.txt'), 'core\nmoved\n');
    git(at('libs/moved'), 'commit', '-qam', 'moved');
    const moved = git(at('libs/moved'), 'rev-parse', 'HEAD');
    const repo = new Repo(sup);
    const plan = await repo.discardPlan(['libs/edited', 'libs/moved']);
    expect(plan.submodules.map((s) => [s.path, !!s.inner])).toEqual([['libs/edited', true], ['libs/moved', false]]);
    const { undo } = await discardWithUndo(repo, plan);
    expect(git(at('libs/edited'), 'status', '--porcelain')).toBe('');
    expect(git(at('libs/moved'), 'rev-parse', 'HEAD')).toBe(recorded);
    expect(git(sup, 'status', '--porcelain')).toBe('');
    await restoreFromUndo(repo, undo!);
    expect(readFileSync(at('libs/edited/core.txt'), 'utf8')).toBe('core\nedited\n');
    expect(readFileSync(at('libs/edited/new.txt'), 'utf8')).toBe('new\n');
    expect(git(at('libs/moved'), 'rev-parse', 'HEAD')).toBe(moved);
    expect(git(at('libs/moved'), 'symbolic-ref', '--short', 'HEAD')).toBe('work');
    // Discard all leaves submodules alone
    const all = await repo.discardPlan(null);
    expect(all.submodules).toEqual([]);
  });

  it("a submodule's staged changes: kept without the tick, dropped with it (index and files back to its commit), both back with Undo", async () => {
    const core = make('core-staged');
    writeFileSync(path.join(core, 'core.txt'), 'core\n');
    git(core, 'add', '-A');
    git(core, 'commit', '-qm', 'core');
    const sup = make('super-staged');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', core, 'libs/core');
    git(sup, 'commit', '-qm', 'sub');
    const at = path.join(sup, 'libs/core');
    git(at, 'config', 'commit.gpgsign', 'false');
    // inside it: a staged change, a new file staged, an untracked one, and an edit on top of the staged version
    writeFileSync(path.join(at, 'core.txt'), 'core\nstaged\n');
    writeFileSync(path.join(at, 'added.txt'), 'added\n');
    git(at, 'add', 'core.txt', 'added.txt');
    writeFileSync(path.join(at, 'free.txt'), 'free\n');
    writeFileSync(path.join(at, 'core.txt'), 'core\nstaged\nand edited\n');
    const repo = new Repo(sup);
    // the engine reads what is staged inside, so the dialog can offer the tick
    const inside = (await repo.submoduleChanges(0)).find((s) => s.path === 'libs/core');
    expect(inside).toMatchObject({ modified: 2, staged: 2, untracked: 1 });
    expect(inside!.files.filter((f) => f.staged).map((f) => f.path).sort()).toEqual(['added.txt', 'core.txt']);
    // without the tick: only the working tree goes back to the index — the staged version stays staged
    const keep = await repo.discardPlan(['libs/core']);
    expect(keep.submodules[0].inner?.reset).toBeFalsy();
    await repo.applyDiscard(keep);
    expect(readFileSync(path.join(at, 'core.txt'), 'utf8')).toBe('core\nstaged\n');
    expect(existsSync(path.join(at, 'free.txt'))).toBe(false);
    expect(git(at, 'status', '--porcelain').split('\n').sort()).toEqual(['A  added.txt', 'M  core.txt']);
    // with the tick: index and files back to the recorded commit, nothing of its own left
    const plan = await repo.discardPlan(['libs/core'], { subStaged: true });
    expect(plan.submodules[0].inner?.reset).toBe(true);
    const { undo } = await discardWithUndo(repo, plan);
    expect(git(at, 'status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(at, 'core.txt'), 'utf8')).toBe('core\n');
    expect(existsSync(path.join(at, 'added.txt'))).toBe(false);
    // Undo puts the files back and the index as it was (read-tree of the tree kept aside)
    await restoreFromUndo(repo, undo!);
    expect(readFileSync(path.join(at, 'core.txt'), 'utf8')).toBe('core\nstaged\n');
    expect(readFileSync(path.join(at, 'added.txt'), 'utf8')).toBe('added\n');
    expect(git(at, 'status', '--porcelain').split('\n').sort()).toEqual(['A  added.txt', 'M  core.txt']);
  });
});
