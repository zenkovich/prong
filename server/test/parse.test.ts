import { describe, expect, it } from 'vitest';
import { hunkPatch, parseDiff, parseLog, parseNumstat, parseRefs, parseRemotes, parseStashList, parseStatus, REC, SEP } from '../src/git/parse.js';
import { progressOf } from '../src/git/run.js';

describe('parseLog', () => {
  it('parses records with parents and multi-line bodies', () => {
    const out =
      ['aaaa1111', 'bbbb2222 cccc3333', 'Andrei', 'a@x.io', '1760000000', 'Merge branch', 'line1\nline2\n'].join(SEP) +
      REC +
      '\n' +
      ['bbbb2222', '', 'Maria', 'm@x.io', '1759990000', 'Initial', ''].join(SEP) +
      REC +
      '\n';
    const c = parseLog(out);
    expect(c).toHaveLength(2);
    expect(c[0].parents).toEqual(['bbbb2222', 'cccc3333']);
    expect(c[0].body).toBe('line1\nline2');
    expect(c[0].date).toBe(1760000000 * 1000);
    expect(c[1].parents).toEqual([]);
    expect(c[1].subject).toBe('Initial');
  });
});

describe('parseRefs', () => {
  it('classifies branches, remotes and tags and reads tracking info', () => {
    const out = [
      ['refs/heads/main', 'a'.repeat(40), '*', 'origin/main', '[ahead 2, behind 1]'].join(SEP),
      ['refs/heads/feature/x', 'b'.repeat(40), '', '', ''].join(SEP),
      ['refs/remotes/origin/main', 'c'.repeat(40), '', '', ''].join(SEP),
      ['refs/tags/v1.0.0', 'd'.repeat(40), '', '', ''].join(SEP),
    ].join('\n');
    const refs = parseRefs(out);
    expect(refs.map((r) => r.kind)).toEqual(['branch', 'branch', 'remote', 'tag']);
    expect(refs[0]).toMatchObject({ name: 'main', current: true, upstream: 'origin/main', ahead: 2, behind: 1 });
    expect(refs[1].current).toBeUndefined();
    expect(refs[2].name).toBe('origin/main');
    expect(refs[3].name).toBe('v1.0.0');
  });
  it('marks an upstream whose remote branch is gone', () => {
    const refs = parseRefs(['refs/heads/old', 'e'.repeat(40), '', 'origin/old', '[gone]'].join(SEP));
    expect(refs[0]).toMatchObject({ upstream: 'origin/old', gone: true });
  });
});

describe('parseRemotes / parseStashList', () => {
  it('dedupes fetch/push lines', () => {
    expect(parseRemotes('origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\n')).toEqual([{ name: 'origin', url: 'git@github.com:a/b.git' }]);
  });
  it('reads stash entries', () => {
    const s = parseStashList(['stash@{0}', 'e'.repeat(40), '1760000000', 'WIP on main: abc Fix'].join(SEP) + '\n');
    expect(s[0]).toMatchObject({ index: 0, message: 'WIP on main: abc Fix' });
  });
});

describe('parseStatus (porcelain v2 -z)', () => {
  it('splits index and worktree changes, renames, untracked and conflicts', () => {
    const z = '\0';
    const out =
      '# branch.oid 1234567\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -2\0' +
      '1 .M N... 100644 100644 100644 abc def src/a.ts' + z +
      '1 M. N... 100644 100644 100644 abc def src/b.ts' + z +
      '1 MM N... 100644 100644 100644 abc def src/c.ts' + z +
      '2 R. N... 100644 100644 100644 abc def R92 docs/README.md' + z + 'README.md' + z +
      '1 .M S.M. 160000 160000 160000 abc def vendor/libgit2' + z +
      'u UU N... 100644 100644 100644 100644 a b c src/Merge.tsx' + z +
      '? new.txt' + z +
      '! ignored.log' + z;
    const r = parseStatus(out);
    expect(r.branch).toMatchObject({ head: 'main', upstream: 'origin/main', ahead: 1, behind: 2 });
    expect(r.unstaged.map((f) => `${f.status}:${f.path}`)).toEqual(['M:src/a.ts', 'M:src/c.ts', 'M:vendor/libgit2', 'U:src/Merge.tsx', '?:new.txt']);
    expect(r.staged.map((f) => `${f.status}:${f.path}`)).toEqual(['M:src/b.ts', 'M:src/c.ts', 'R:docs/README.md']);
    expect(r.staged[2]).toMatchObject({ oldPath: 'README.md', similarity: 92 });
    expect(r.unstaged[2].kind).toBe('submodule');
  });
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function x() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a;
 }
@@ -20,2 +21,2 @@
-old
+new
 ctx
diff --git a/img.png b/img.png
index 3333333..4444444 100644
Binary files a/img.png and b/img.png differ
diff --git a/README.md b/docs/README.md
similarity index 92%
rename from README.md
rename to docs/README.md
index 5555555..6666666 100644
--- a/README.md
+++ b/docs/README.md
@@ -1 +1 @@
-# A
+# B
diff --git a/vendor/libgit2 b/vendor/libgit2
index aaaaaaa..bbbbbbb 160000
--- a/vendor/libgit2
+++ b/vendor/libgit2
@@ -1 +1 @@
-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..7777777
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

describe('parseDiff', () => {
  it('parses hunks with line numbers and counts, binaries, renames, submodules and new files', () => {
    const files = parseDiff(DIFF);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'img.png', 'docs/README.md', 'vendor/libgit2', 'new.txt']);
    const a = files[0];
    expect(a.hunks).toHaveLength(2);
    expect(a.additions).toBe(3);
    expect(a.deletions).toBe(2);
    expect(a.hunks![0].header).toBe('@@ -1,4 +1,5 @@ function x() {');
    expect(a.hunks![0].lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add', 'add', 'ctx', 'ctx']);
    expect(a.hunks![0].lines[1].oldNo).toBe(2);
    expect(a.hunks![0].lines[1].newNo).toBeUndefined();
    expect(a.hunks![0].lines[3]).toMatchObject({ newNo: 3 });
    expect(files[1].kind).toBe('image');
    expect(files[2]).toMatchObject({ status: 'R', oldPath: 'README.md', similarity: 92 });
    expect(files[3].kind).toBe('submodule');
    expect(files[3].submodule).toEqual({ before: 'a'.repeat(40), after: 'b'.repeat(40) });
    expect(files[4]).toMatchObject({ status: 'A', additions: 2 });
  });

  it('marks huge diffs as large', () => {
    const big = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,0 +1,3000 @@\n' + Array.from({ length: 3000 }, (_, i) => `+${i}`).join('\n') + '\n';
    const [f] = parseDiff(big, { largeThreshold: 1000 });
    expect(f.kind).toBe('large');
    expect(f.hunks).toBeUndefined();
    expect(f.additions).toBe(3000);
  });

  it('rebuilds a single-hunk patch that git can apply', () => {
    const [a] = parseDiff(DIFF);
    const p = hunkPatch(a, a.hunks![1]);
    expect(p).toBe('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -20,2 +21,2 @@\n-old\n+new\n ctx\n');
  });
});

describe('parseNumstat', () => {
  it('reads counts and binary markers', () => {
    const m = parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg.png\0');
    expect(m.get('src/a.ts')).toEqual({ additions: 3, deletions: 1 });
    expect(m.get('img.png')).toEqual({ additions: 0, deletions: 0 });
  });
});

describe('progressOf', () => {
  it('maps git phases onto one monotonic bar', () => {
    expect(progressOf('remote: Counting objects: 50% (1/2)')).toBeCloseTo(0.05);
    expect(progressOf('Receiving objects:  38% (700/1842), 2.1 MiB | 4.2 MiB/s')).toBeCloseTo(0.3 + 0.38 * 0.5);
    expect(progressOf('Resolving deltas: 100% (10/10), done.')).toBeCloseTo(0.95);
    expect(progressOf('From github.com:x/y')).toBeNull();
  });
});
