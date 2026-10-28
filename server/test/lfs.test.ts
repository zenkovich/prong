import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLfsPointerDiff, lfsKindOf, parseDiff, parseLfsPointer } from '../src/git/parse.js';
import { LfsNotDownloaded, lfsPatterns, Repo, WORKTREE } from '../src/git/repo.js';

const OID = 'a'.repeat(64);
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12345\n`;

describe('Git LFS pointers', () => {
  it('a pointer is read; real files, long texts and near-misses are not pointers', () => {
    expect(parseLfsPointer(POINTER)).toEqual({ oid: OID, size: 12345 });
    expect(parseLfsPointer(Buffer.from(POINTER))).toEqual({ oid: OID, size: 12345 });
    // an extension line (git-lfs ext-0-<name>) is allowed
    expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${'b'.repeat(64)}\noid sha256:${OID}\nsize 7\n`)).toEqual({ oid: OID, size: 7 });
    expect(parseLfsPointer('PNG\0\0data')).toBeNull();
    expect(parseLfsPointer(`${POINTER}and a line more\n`)).toBeNull();
    expect(parseLfsPointer(POINTER + ' '.repeat(1100))).toBeNull();
    expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\n`)).toBeNull();
  });

  it('a pointer’s text diff (filter=lfs without diff=lfs) is previewed as the file it points to', () => {
    const diff = [
      'diff --git a/img/logo.png b/img/logo.png',
      'index 1111111..2222222 100644',
      '--- a/img/logo.png',
      '+++ b/img/logo.png',
      '@@ -1,3 +1,3 @@',
      ' version https://git-lfs.github.com/spec/v1',
      `-oid sha256:${OID}`,
      '-size 10',
      `+oid sha256:${'c'.repeat(64)}`,
      '+size 20',
      'diff --git a/build/tool.dll b/build/tool.dll',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/build/tool.dll',
      '@@ -0,0 +1,3 @@',
      '+version https://git-lfs.github.com/spec/v1',
      `+oid sha256:${OID}`,
      '+size 99',
      'diff --git a/notes.txt b/notes.txt',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1 +1 @@',
      '-size 10',
      '+size 20',
    ].join('\n');
    const files = parseDiff(diff);
    expect(files.map((f) => [f.path, f.kind, f.additions, f.deletions, !!f.hunks])).toEqual([
      ['img/logo.png', 'image', 0, 0, false],
      ['build/tool.dll', 'binary', 0, 0, false],
      // "size 20" alone, without the version line, is an ordinary text change
      ['notes.txt', 'text', 1, 1, true],
    ]);
    expect(isLfsPointerDiff(files[2].hunks!)).toBe(false);
    expect(lfsKindOf('a/b.ogg')).toBe('audio');
    expect(lfsKindOf('a/b.fbx')).toBe('binary');
  });

  it('a pick becomes git-lfs include patterns, glob characters escaped, bad paths dropped', () => {
    expect(lfsPatterns({ folders: ['fmod/Assets/', 'pics [hd]'], files: ['a*b.png', 'x,y.bin', '../out', '-rf', ''] })).toEqual([
      'fmod/Assets/**',
      'pics \\[hd\\]/**',
      'a\\*b.png',
      // a comma separates patterns and cannot be escaped: it matches as one character
      'x?y.bin',
    ]);
  });
});

let lfs = false;
try {
  execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
  lfs = true;
} catch {
  /* git-lfs not installed: the integration part is skipped */
}

/**
 * A repository with images, a sound and binaries in Git LFS, pushed to a local remote (git-lfs serves a path remote
 * itself), and a clone made without LFS: its working copy holds pointers only, as township's fmod/Assets does
 * (left out by .lfsconfig's fetchexclude).
 */
describe.skipIf(!lfs)('Git LFS files', () => {
  let root: string;
  let src: string;
  let clone: string;
  const was = process.env.GIT_CONFIG_GLOBAL;
  const wasState = process.env.PRONG_STATE_DIR;
  const env = () => ({ ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' });
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const write = (dir: string, file: string, content: string | Buffer) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };
  const isPointer = (dir: string, file: string) => !!parseLfsPointer(readFileSync(path.join(dir, file)));
  const PNG_1 = Buffer.from('\x89PNG\r\n\x1a\n first picture'.padEnd(2000, '.'), 'binary');
  const PNG_2 = Buffer.from('\x89PNG\r\n\x1a\n second picture'.padEnd(3000, '.'), 'binary');

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prong-lfs-'));
    // the previews' blob cache goes here, not into ~/.prong
    process.env.PRONG_STATE_DIR = path.join(root, 'state');
    // git's global config of the run: the LFS filters, no user settings
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
    execFileSync('git', ['init', '-q', '--bare', path.join(root, 'origin.git')]);
    src = path.join(root, 'src');
    execFileSync('git', ['init', '-q', src]);
    write(src, '.gitattributes', ['*.png', '*.ogg', '*.bin'].map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`).join('\n') + '\n');
    write(src, 'a.png', PNG_1);
    write(src, 's.ogg', 'OggS sound');
    write(src, 'data/x.bin', 'x binary');
    write(src, 'data/sub/y.bin', 'y binary');
    write(src, 'pics [hd]/b.png', 'b picture');
    write(src, 'readme.txt', 'plain\n');
    git(src, 'add', '-A');
    git(src, 'commit', '-qm', 'Assets');
    write(src, 'a.png', PNG_2);
    write(src, '.lfsconfig', '[lfs]\n\tfetchexclude = **/*.ogg\n');
    git(src, 'add', '-A');
    git(src, 'commit', '-qm', 'Second picture');
    git(src, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
    git(src, 'push', '-q', 'origin', 'main');
    clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', path.join(root, 'origin.git'), clone], { env: { ...env(), GIT_LFS_SKIP_SMUDGE: '1' }, stdio: 'ignore' });
  });
  afterAll(() => {
    if (was === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = was;
    if (wasState === undefined) delete process.env.PRONG_STATE_DIR;
    else process.env.PRONG_STATE_DIR = wasState;
    rmSync(root, { recursive: true, force: true });
  });

  it('a commit’s LFS picture is an image (not three lines of hashes), its sides the real files', async () => {
    const r = new Repo(src);
    const files = await r.commitFiles(git(src, 'rev-parse', 'HEAD'));
    const png = files.find((f) => f.path === 'a.png')!;
    expect([png.kind, png.hunks]).toEqual(['image', undefined]);
    const first = await r.commitFiles(git(src, 'rev-parse', 'HEAD~1'));
    expect(first.find((f) => f.path === 'data/x.bin')?.kind).toBe('binary');
    expect(first.find((f) => f.path === 'readme.txt')?.kind).toBe('text');
    const sides = await r.mediaSides('a.png', git(src, 'rev-parse', 'HEAD'));
    expect([sides.before?.bytes, sides.after?.bytes]).toEqual([PNG_1.length, PNG_2.length]);
    expect(sides.after?.lfs).toMatchObject({ size: PNG_2.length, local: true });
    const blob = await r.materializeBlob(sides.after!.rev, 'a.png');
    expect(readFileSync(blob!.path).equals(PNG_2)).toBe(true);
    // the copy keeps the extension (Open hands it to an image viewer)
    expect(path.extname(blob!.path)).toBe('.png');
  });

  it('an edited LFS picture in the working copy: an image change, the index side through its pointer', async () => {
    const r = new Repo(src);
    write(src, 'a.png', PNG_1);
    try {
      const f = await r.fileDiff('a.png', 'unstaged');
      expect([f?.kind, f?.hunks]).toEqual(['image', undefined]);
      const sides = await r.mediaSides('a.png', 'unstaged');
      expect(sides.before).toMatchObject({ bytes: PNG_2.length, lfs: { local: true } });
      // the working copy holds the real file: no pointer to follow
      expect(sides.after?.lfs).toBeUndefined();
      expect(sides.after?.bytes).toBe(PNG_1.length);
    } finally {
      git(src, 'checkout', '--', 'a.png');
    }
  });

  it('a clone without LFS: pointers in the working copy, objects not here; a preview downloads one, the files stay', async () => {
    // a cache of its own: the previews above put the same picture into the shared one (by object id: any repository's
    // preview of it is then instant, which is right, but not what this checks)
    process.env.PRONG_STATE_DIR = path.join(root, 'state-clone');
    const r = new Repo(clone);
    const side = await r.blobInfo(WORKTREE, 'a.png');
    expect(side).toMatchObject({ bytes: PNG_2.length, lfs: { local: false, pointerFile: true } });
    await expect(r.materializeBlob('HEAD', 'a.png')).rejects.toBeInstanceOf(LfsNotDownloaded);
    const got = await r.lfsDownload('HEAD', 'a.png');
    expect(got.lfs?.local).toBe(true);
    expect(readFileSync((await r.materializeBlob('HEAD', 'a.png'))!.path).equals(PNG_2)).toBe(true);
    // the working copy is as it was
    expect(isPointer(clone, 'a.png')).toBe(true);
    expect((await r.blobInfo(WORKTREE, 'a.png'))?.lfs).toMatchObject({ local: true, pointerFile: true });
    // left out of downloads by .lfsconfig, but asked for by name
    expect((await r.lfsDownload('HEAD', 's.ogg')).lfs?.local).toBe(true);
    await expect(r.lfsDownload('HEAD', 'readme.txt')).rejects.toThrow(/not a Git LFS file/);
  });

  it('lists what is still a pointer, and what .lfsconfig leaves out of downloads', async () => {
    const list = await new Repo(clone).lfsFiles();
    expect(list.installed).toBe(true);
    expect(list.total).toBe(5);
    expect(list.excluded).toEqual(['**/*.ogg']);
    expect(list.missing.map((f) => `${f.path} ${f.size} ${f.downloaded ? 'here' : 'remote'}`).sort()).toEqual([
      `a.png ${PNG_2.length} here`,
      'data/sub/y.bin 8 remote',
      'data/x.bin 8 remote',
      'pics [hd]/b.png 9 remote',
      's.ogg 10 here',
    ]);
    expect((await new Repo(src).lfsFiles()).missing).toEqual([]);
  });

  it('restores what was picked: a folder, a file without its neighbours below, an excluded file, then all', async () => {
    const r = new Repo(clone);
    const lines: string[] = [];
    await r.lfsRestore({ folders: ['pics [hd]'] }, (l) => lines.push(l));
    expect(isPointer(clone, 'pics [hd]/b.png')).toBe(false);
    expect(readFileSync(path.join(clone, 'pics [hd]/b.png'), 'utf8')).toBe('b picture');
    expect(isPointer(clone, 'a.png')).toBe(true);
    expect(lines.some((l) => /LFS objects/.test(l)), JSON.stringify(lines)).toBe(true);

    // data's own file, not its subfolder's: named, as the dialog names a folder's own files
    await r.lfsRestore({ files: ['data/x.bin', 's.ogg'] });
    expect([isPointer(clone, 'data/x.bin'), isPointer(clone, 'data/sub/y.bin'), isPointer(clone, 's.ogg')]).toEqual([false, true, false]);

    await r.lfsRestore({ all: true });
    expect((await r.lfsFiles()).missing).toEqual([]);
    expect(readFileSync(path.join(clone, 'a.png')).equals(PNG_2)).toBe(true);
    // restoring is not a change
    const st = await r.status();
    expect([...st.staged, ...st.unstaged]).toEqual([]);
  });

  it('files put in place behind the index’s back: their record updated, a real edit left alone', async () => {
    const dir = path.join(root, 'settle');
    execFileSync('git', ['clone', '-q', path.join(root, 'origin.git'), dir], { env: { ...env(), GIT_LFS_SKIP_SMUDGE: '1' }, stdio: 'ignore' });
    // as when git-lfs could not update the index (another git held its lock): the real files, the pointers' sizes
    write(dir, 'data/x.bin', 'x binary');
    write(dir, 'pics [hd]/b.png', 'b picture');
    // and an LFS file really edited
    write(dir, 'data/sub/y.bin', 'y edited');
    // untrimmed: the first line's leading space is part of the status
    const modified = () => execFileSync('git', ['status', '--porcelain'], { cwd: dir, env: env() }).toString().split('\n').filter(Boolean).sort();
    expect(modified()).toEqual([' M "pics [hd]/b.png"', ' M data/sub/y.bin', ' M data/x.bin']);
    await new Repo(dir).lfsSettleIndex();
    expect(modified()).toEqual([' M data/sub/y.bin']);
    // nothing staged by it
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('a conflict between two LFS pictures is a side to take, not lines of hashes', async () => {
    const dir = path.join(root, 'conflict');
    execFileSync('git', ['clone', '-q', src, dir], { stdio: 'ignore' });
    git(dir, 'checkout', '-qb', 'other');
    write(dir, 'a.png', 'other picture');
    git(dir, 'commit', '-qam', 'other');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'a.png', 'main picture');
    git(dir, 'commit', '-qam', 'main');
    try {
      git(dir, 'merge', 'other');
    } catch {
      /* conflicts */
    }
    const f = await new Repo(dir).fileDiff('a.png', 'unstaged');
    expect(f?.conflict?.binary).toBe(true);
  });
});
