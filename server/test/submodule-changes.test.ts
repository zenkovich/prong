import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INSIDE_WAIT_MS, Repo } from '../src/git/repo.js';

/**
 * Submodules with changes in their own files (git status's "modified content", "untracked content"): the
 * superproject's status skips them for speed (--ignore-submodules=dirty), so they are read submodule by submodule
 * and joined to it. They used to be missing from Changes (Fork lists them).
 */
describe('submodule changes', () => {
  let root: string;
  let origin: string;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  /** a superproject with a submodule of `origin` at each path */
  const superWith = (name: string, paths: string[]) => {
    const sup = path.join(root, name);
    execFileSync('git', ['init', '-q', '-b', 'main', sup]);
    git(sup, 'config', 'commit.gpgsign', 'false');
    for (const p of paths) git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, p);
    git(sup, 'commit', '-q', '-m', 'Add submodules');
    for (const p of paths) git(path.join(sup, p), 'config', 'commit.gpgsign', 'false');
    return sup;
  };
  let sup: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-subchanges-'));
    origin = path.join(root, 'core');
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    git(origin, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(origin, 'core.txt'), 'core\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'core: base');
    sup = superWith('super', ['libs/clean', 'libs/edited', 'libs/fresh', 'libs/moved', 'libs/quiet', 'libs/staged', 'libs/untr']);
    const at = (p: string) => path.join(sup, p);
    writeFileSync(at('libs/edited/core.txt'), 'core\nedited\n');
    writeFileSync(at('libs/fresh/new.txt'), 'new\n');
    // its commit moved (a pointer change) and a file edited on top
    writeFileSync(at('libs/moved/core.txt'), 'core\nmoved\n');
    git(at('libs/moved'), 'commit', '-qam', 'core: moved');
    writeFileSync(at('libs/moved/core.txt'), 'core\nmoved\nand edited\n');
    writeFileSync(at('libs/staged/added.txt'), 'added\n');
    git(at('libs/staged'), 'add', 'added.txt');
    // told to be quiet: edits ignored (.gitmodules), new files ignored (.git/config, which wins over .gitmodules)
    git(sup, 'config', '-f', '.gitmodules', 'submodule.libs/quiet.ignore', 'dirty');
    git(sup, 'config', '-f', '.gitmodules', 'submodule.libs/untr.ignore', 'none');
    git(sup, 'config', 'submodule.libs/untr.ignore', 'untracked');
    // only .gitmodules: `commit -a` would record the moved submodule's commit too
    git(sup, 'commit', '-q', '-m', 'Quiet submodules', '--', '.gitmodules');
    writeFileSync(at('libs/quiet/core.txt'), 'core\nquiet\n');
    writeFileSync(at('libs/untr/only-new.txt'), 'new\n');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads each submodule: edited, new and staged files counted and named; the quiet ones and the clean one left out', async () => {
    const list = await new Repo(sup).submoduleChanges(0);
    expect(list).toEqual([
      { path: 'libs/edited', modified: 1, untracked: 0, files: [{ path: 'core.txt', status: 'M' }] },
      { path: 'libs/fresh', modified: 0, untracked: 1, files: [{ path: 'new.txt', status: '?' }] },
      { path: 'libs/moved', modified: 1, untracked: 0, files: [{ path: 'core.txt', status: 'M' }] },
      { path: 'libs/staged', modified: 1, untracked: 0, files: [{ path: 'added.txt', status: 'A' }] },
    ]);
  });

  it('status lists them as Fork does: at the recorded commit for them alone, a moved one with them added', async () => {
    const st = await new Repo(sup).status();
    const rows = st.unstaged.map((f) => `${f.status} ${f.path} ${f.kind}${f.inside ? (f.inside.only ? ' only' : ' +inside') : ''}`);
    expect(rows).toEqual(['M libs/edited submodule only', 'M libs/fresh submodule only', 'M libs/moved submodule +inside', 'M libs/staged submodule only']);
    // nothing staged in the superproject by any of it
    expect(st.staged).toEqual([]);
  });

  it('the sidebar’s submodules carry them too', async () => {
    const subs = await new Repo(sup).submodules();
    const of = (p: string) => subs.find((s) => s.path === p);
    expect(of('libs/edited')?.inside).toEqual({ modified: 1, untracked: 0 });
    expect(of('libs/moved')).toMatchObject({ state: 'modified', inside: { modified: 1, untracked: 0 } });
    expect(of('libs/clean')?.inside).toBeUndefined();
    expect(of('libs/clean')?.state).toBe('ok');
  });

  it('a read a moment ago is reused; a fresh one sees a new edit, and status lists it then', async () => {
    const r = new Repo(sup);
    await r.submoduleChanges(0);
    writeFileSync(path.join(sup, 'libs/clean/core.txt'), 'core\nnow edited\n');
    expect((await r.status()).unstaged.some((f) => f.path === 'libs/clean')).toBe(false);
    expect((await r.submoduleChanges(0)).map((c) => c.path)).toContain('libs/clean');
    expect((await r.status()).unstaged.find((f) => f.path === 'libs/clean')?.inside?.only).toBe(true);
    git(path.join(sup, 'libs/clean'), 'checkout', '--', 'core.txt');
    await r.submoduleChanges(0);
  });

  it('a slow read does not hold the list: it goes with the last read known, and the fresh read is shared', async () => {
    const other = superWith('super-slow', ['libs/a']);
    writeFileSync(path.join(other, 'libs/a/core.txt'), 'core\nedited\n');
    const was = INSIDE_WAIT_MS.value;
    INSIDE_WAIT_MS.value = 0;
    try {
      const r = new Repo(other);
      const first = await r.status();
      // the read was under way: not listed yet (the client asks for the fresh read and reads again)
      expect(first.unstaged).toEqual([]);
      const fresh = await r.submoduleChanges();
      expect(fresh.map((c) => c.path)).toEqual(['libs/a']);
      expect((await r.status()).unstaged.map((f) => f.path)).toEqual(['libs/a']);
    } finally {
      INSIDE_WAIT_MS.value = was;
    }
  });

  it('a project with no submodules reads nothing', async () => {
    expect(await new Repo(origin).submoduleChanges(0)).toEqual([]);
  });

  it('a submodule not checked out has nothing of its own', async () => {
    const clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', sup, clone]);
    expect(await new Repo(clone).submoduleChanges(0)).toEqual([]);
    expect((await new Repo(clone).status()).unstaged).toEqual([]);
  });
});
