import type { Commit, ContentKind, DiffLine, FileChange, FileStatus, Hunk, Ref, Remote, Stash, SubmoduleChanges } from '../types.js';

export const SEP = '\x1f';
export const REC = '\x1e';

/** `git log --format=<LOG_FORMAT>` — one record per commit, fields separated by \x1f, records by \x1e. */
export const LOG_FORMAT = `%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%s${SEP}%b${REC}`;

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const rec of out.split(REC)) {
    const r = rec.replace(/^\n/, '');
    if (!r.trim()) continue;
    const [sha, parents, author, email, at, subject, body = ''] = r.split(SEP);
    if (!sha || sha.length < 7) continue;
    commits.push({
      sha,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      email,
      date: parseInt(at, 10) * 1000,
      subject,
      body: body.replace(/\n+$/, ''),
    });
  }
  return commits;
}

// ---------- refs ----------

/** `git for-each-ref --format=<REF_FORMAT> refs/heads refs/remotes refs/tags` */
export const REF_FORMAT = `%(refname)${SEP}%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)${SEP}%(HEAD)${SEP}%(upstream:short)${SEP}%(upstream:track)`;

export function parseRefs(out: string): Ref[] {
  const refs: Ref[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [refname, sha, head, upstream, track] = line.split(SEP);
    let kind: Ref['kind'];
    let name: string;
    if (refname.startsWith('refs/heads/')) {
      kind = 'branch';
      name = refname.slice('refs/heads/'.length);
    } else if (refname.startsWith('refs/remotes/')) {
      kind = 'remote';
      name = refname.slice('refs/remotes/'.length);
    } else if (refname.startsWith('refs/tags/')) {
      kind = 'tag';
      name = refname.slice('refs/tags/'.length);
    } else continue;
    const ref: Ref = { name, kind, sha };
    if (head === '*') ref.current = true;
    if (upstream) {
      ref.upstream = upstream;
      const a = track?.match(/ahead (\d+)/);
      const b = track?.match(/behind (\d+)/);
      ref.ahead = a ? parseInt(a[1], 10) : 0;
      ref.behind = b ? parseInt(b[1], 10) : 0;
      if (/gone/.test(track ?? '')) ref.gone = true;
    }
    refs.push(ref);
  }
  return refs;
}

// ---------- remotes ----------

export function parseRemotes(out: string): Remote[] {
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (m && m[3] === 'fetch') map.set(m[1], m[2]);
  }
  return [...map].map(([name, url]) => ({ name, url }));
}

// ---------- stashes ----------

/** `git stash list --format=%gd%x1f%H%x1f%at%x1f%gs` */
export const STASH_FORMAT = `%gd${SEP}%H${SEP}%at${SEP}%gs`;

export function parseStashList(out: string): Stash[] {
  const stashes: Stash[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ref, sha, at, message] = line.split(SEP);
    const m = ref.match(/stash@\{(\d+)\}/);
    if (!m) continue;
    stashes.push({ index: parseInt(m[1], 10), sha, date: parseInt(at, 10) * 1000, message, files: [] });
  }
  return stashes;
}

// ---------- status (porcelain v2, NUL-terminated) ----------

export interface StatusResult {
  unstaged: FileChange[];
  staged: FileChange[];
  branch?: { head: string; oid: string; upstream?: string; ahead?: number; behind?: number };
}

const IMAGE_RX = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|heic)$/i;
const AUDIO_RX = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|aiff?|caf|weba)$/i;
// .ts is TypeScript, never MPEG transport stream
const VIDEO_RX = /\.(mp4|m4v|mov|webm|ogv|mkv|avi|mpe?g|3gp|wmv|flv)$/i;
const MEDIA_KINDS: ContentKind[] = ['image', 'audio', 'video'];
export const isMediaKind = (k: ContentKind) => MEDIA_KINDS.includes(k);

export function kindOf(path: string): ContentKind {
  return IMAGE_RX.test(path) ? 'image' : AUDIO_RX.test(path) ? 'audio' : VIDEO_RX.test(path) ? 'video' : 'text';
}

// ---------- Git LFS ----------

/** What git stores for a Git LFS file: the object's id (sha256) and the real file's size. */
export interface LfsPointer {
  oid: string;
  size: number;
}
/** git-lfs reads nothing bigger than this as a pointer */
export const LFS_POINTER_MAX = 1024;
const LFS_VERSION = /^version https:\/\/(git-lfs|hawser)\.github\.com\/spec\/v1$/;
const LFS_LINE = /^(version https:\/\/(git-lfs|hawser)\.github\.com\/spec\/v1|oid sha256:[0-9a-f]{64}|size \d+|ext-\d+-[a-z0-9]+ sha256:[0-9a-f]{64})$/;

/** The pointer in a file's content, or null when it is not one (a real file, or too long to be one). */
export function parseLfsPointer(content: string | Buffer): LfsPointer | null {
  if (content.length > LFS_POINTER_MAX) return null;
  const text = typeof content === 'string' ? content : content.toString('utf8');
  const lines = text.replace(/\n$/, '').split('\n');
  if (!LFS_VERSION.test(lines[0] ?? '') || !lines.every((l) => LFS_LINE.test(l))) return null;
  const oid = lines.find((l) => l.startsWith('oid sha256:'))?.slice(11);
  const size = lines.find((l) => l.startsWith('size '));
  return oid && size ? { oid, size: parseInt(size.slice(5), 10) } : null;
}

/**
 * The hunks of a pointer's text diff: a file in Git LFS whose .gitattributes has `filter=lfs` but not `diff=lfs`
 * (the engine diffs `diff=lfs` paths as binaries). Its preview is the real file, not three lines of hashes.
 */
export function isLfsPointerDiff(hunks: Hunk[]): boolean {
  const lines = hunks.flatMap((h) => h.lines);
  return lines.length > 0 && lines.every((l) => LFS_LINE.test(l.text)) && lines.some((l) => LFS_VERSION.test(l.text));
}

/** what a file in Git LFS is previewed as: a picture, a sound or a video by its name, otherwise a binary */
export const lfsKindOf = (path: string): ContentKind => (isMediaKind(kindOf(path)) ? kindOf(path) : 'binary');

function statusChar(c: string): FileStatus {
  switch (c) {
    case 'A':
      return 'A';
    case 'D':
      return 'D';
    case 'R':
      return 'R';
    case 'C':
      return 'C';
    case 'U':
      return 'U';
    default:
      return 'M';
  }
}

export function parseStatus(out: string): StatusResult {
  const unstaged: FileChange[] = [];
  const staged: FileChange[] = [];
  let branch: StatusResult['branch'];
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;
    if (line.startsWith('# branch.')) {
      branch = branch ?? { head: '', oid: '' };
      const [key, ...rest] = line.slice(2).split(' ');
      const val = rest.join(' ');
      if (key === 'branch.head') branch.head = val;
      else if (key === 'branch.oid') branch.oid = val;
      else if (key === 'branch.upstream') branch.upstream = val;
      else if (key === 'branch.ab') {
        const m = val.match(/\+(\d+) -(\d+)/);
        if (m) {
          branch.ahead = parseInt(m[1], 10);
          branch.behind = parseInt(m[2], 10);
        }
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    const type = line[0];
    if (type === '?') {
      unstaged.push({ path: line.slice(2), status: '?', kind: kindOf(line.slice(2)), additions: 0, deletions: 0 });
      continue;
    }
    if (type === '!') continue;
    if (type === '1' || type === '2') {
      const parts = line.split(' ');
      const xy = parts[1];
      const sub = parts[2];
      const isSubmodule = sub.startsWith('S');
      let path: string;
      let oldPath: string | undefined;
      let similarity: number | undefined;
      if (type === '1') path = parts.slice(8).join(' ');
      else {
        const score = parts[8];
        path = parts.slice(9).join(' ');
        oldPath = tokens[++i];
        similarity = parseInt(score.replace(/[RC]/, ''), 10);
      }
      const kind: ContentKind = isSubmodule ? 'submodule' : kindOf(path);
      const x = xy[0];
      const y = xy[1];
      if (x !== '.') staged.push({ path, oldPath, similarity, status: statusChar(x), kind, additions: 0, deletions: 0 });
      if (y !== '.') unstaged.push({ path, oldPath: x === '.' ? oldPath : undefined, status: statusChar(y), kind, additions: 0, deletions: 0 });
      continue;
    }
    if (type === 'u') {
      const parts = line.split(' ');
      const path = parts.slice(10).join(' ');
      unstaged.push({ path, status: 'U', kind: kindOf(path), additions: 0, deletions: 0 });
    }
  }
  return { unstaged, staged, branch };
}

/**
 * The submodules with changes in their own files, joined to a status read with --ignore-submodules=dirty: a listed
 * submodule (its commit moved) gets them as `inside`; one at its recorded commit is listed for them alone (`only`),
 * among the tracked entries in path order as git lists it. A path the list has as something else (a conflict) is
 * left as it is.
 */
export function joinSubmoduleChanges(unstaged: FileChange[], list: SubmoduleChanges[]): FileChange[] {
  const rest = new Map(list.filter((s) => s.modified + s.untracked > 0).map((s) => [s.path, s]));
  if (!rest.size) return unstaged;
  const out = unstaged.map((f) => {
    const s = rest.get(f.path);
    if (!s) return f;
    rest.delete(f.path);
    return f.kind === 'submodule' ? { ...f, inside: { modified: s.modified, untracked: s.untracked, files: s.files } } : f;
  });
  for (const s of [...rest.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const at = out.findIndex((f) => f.status === '?' || f.path > s.path);
    const row: FileChange = { path: s.path, status: 'M', kind: 'submodule', additions: 0, deletions: 0, inside: { modified: s.modified, untracked: s.untracked, files: s.files, only: true } };
    out.splice(at < 0 ? out.length : at, 0, row);
  }
  return out;
}

// ---------- unified diff ----------

/**
 * The commit of a "Subproject commit <sha>" line. A submodule with changes in its own files is "<sha>-dirty" in a
 * working-copy diff: the sha is the commit (it used to be taken whole, and "Go to" looked for "<sha>-dirty").
 */
export const subprojectSha = (s: string) => s.trim().replace(/-dirty$/, '');

export interface ParsedDiff {
  files: FileChange[];
}

let hunkSeq = 0;

export function parseDiff(out: string, opts: { largeThreshold?: number } = {}): FileChange[] {
  const files: FileChange[] = [];
  const lines = out.split('\n');
  let cur: FileChange | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let rawLines = 0;
  const finish = () => {
    if (!cur) return;
    if (cur.kind === 'text' && cur.hunks && cur.hunks.length === 0) cur.hunks = undefined;
    if (cur.kind === 'text' && cur.hunks && isLfsPointerDiff(cur.hunks)) {
      cur.kind = lfsKindOf(cur.path);
      cur.hunks = undefined;
      cur.additions = 0;
      cur.deletions = 0;
    }
    if (cur.kind === 'text' && (cur.hunks?.length ?? 0) === 0 && cur.additions + cur.deletions === 0 && !cur.binary && !cur.submodule) {
      // mode-only change or empty
    }
    if (cur.kind === 'text' && opts.largeThreshold && rawLines > opts.largeThreshold) {
      cur.kind = 'large';
      cur.hunks = undefined;
    }
    files.push(cur);
    cur = null;
    hunk = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      finish();
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      const path = m ? m[2] : line.slice(11);
      cur = { path, status: 'M', kind: kindOf(path), additions: 0, deletions: 0, hunks: [] };
      rawLines = 0;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) {
      cur.status = 'A';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.status = 'D';
      continue;
    }
    if (line.startsWith('similarity index')) {
      cur.similarity = parseInt(line.slice(17), 10);
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice(12);
      cur.status = 'R';
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.path = line.slice(10);
      continue;
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      cur.kind = isMediaKind(cur.kind) ? cur.kind : 'binary';
      cur.hunks = undefined;
      continue;
    }
    // a mode change (chmod +x) says so: a diff without hunks is not "no changes"
    if (line.startsWith('old mode ')) {
      cur.mode = { before: line.slice(9).trim(), after: cur.mode?.after ?? '' };
      continue;
    }
    if (line.startsWith('new mode ')) {
      cur.mode = { before: cur.mode?.before ?? '', after: line.slice(9).trim() };
      continue;
    }
    // file headers come before the first hunk: inside one, "--- x" is a removed line "-- x" (an SQL or Lua comment)
    if (!hunk && (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ '))) continue;
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (!m) continue;
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[3], 10);
      hunk = { id: `h${++hunkSeq}`, header: line, lines: [] };
      if (isMediaKind(cur.kind)) cur.kind = 'text'; // textual media (svg): show the text diff
      (cur.hunks ??= []).push(hunk);
      continue;
    }
    if (!hunk) {
      if (/^[-+]Subproject commit/.test(line)) {
        cur.kind = 'submodule';
        cur.hunks = undefined;
        const sha = subprojectSha(line.slice('+Subproject commit '.length));
        cur.submodule = cur.submodule ?? { before: '', after: '' };
        if (line[0] === '-') cur.submodule.before = sha;
        else cur.submodule.after = sha;
      }
      continue;
    }
    // the line before has no newline at its end: kept, so a patch of this hunk still applies (git apply is strict)
    if (line.startsWith('\\ No newline')) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noEol = true;
      continue;
    }
    const c = line[0];
    const text = line.slice(1);
    if ((c === '+' || c === '-') && text.startsWith('Subproject commit ')) {
      cur.kind = 'submodule';
      cur.hunks = undefined;
      hunk = null;
      cur.submodule = cur.submodule ?? { before: '', after: '' };
      if (c === '-') cur.submodule.before = subprojectSha(text.slice('Subproject commit '.length));
      else cur.submodule.after = subprojectSha(text.slice('Subproject commit '.length));
      continue;
    }
    rawLines++;
    let dl: DiffLine;
    if (c === '+') {
      dl = { kind: 'add', newNo: newNo++, text };
      cur.additions++;
    } else if (c === '-') {
      dl = { kind: 'del', oldNo: oldNo++, text };
      cur.deletions++;
    } else if (c === ' ' || line === '') {
      if (line === '' && i === lines.length - 1) continue;
      dl = { kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text };
    } else continue;
    hunk.lines.push(dl);
  }
  finish();
  return files;
}

/** Rebuild a patch for one hunk of one file so it can be fed to `git apply`. */
/**
 * A one-hunk patch git can apply. It creates or deletes the file only when the hunk really does that (empty old
 * side of a new file / empty new side of a deleted one); a partial hunk of a new file (line staging) is an edit.
 */
export function hunkPatch(file: FileChange, hunk: Hunk): string {
  const m = hunk.header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  const oldEmpty = !!m && m[1] === '0' && m[2] === '0';
  const newEmpty = !!m && m[3] === '0' && m[4] === '0';
  const creates = (file.status === 'A' || file.status === '?') && oldEmpty;
  const deletes = file.status === 'D' && newEmpty;
  const a = creates ? '/dev/null' : `a/${file.oldPath ?? file.path}`;
  const b = deletes ? '/dev/null' : `b/${file.path}`;
  const mode = creates ? 'new file mode 100644\n' : deletes ? 'deleted file mode 100644\n' : '';
  // a line with no newline at its end is followed by git's marker, or the patch does not apply
  const body = hunk.lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text + (l.noEol ? '\n\\ No newline at end of file' : '')).join('\n');
  return `diff --git a/${file.oldPath ?? file.path} b/${file.path}\n${mode}--- ${a}\n+++ ${b}\n${hunk.header}\n${body}\n`;
}

/** Summarise +/- counts from `git diff --numstat -z` into a path → counts map. */
/**
 * `git show --raw --no-abbrev` / `git diff --raw` lines → files without diffs (`lazy`):
 * ":100644 100644 <old> <new> M\tpath", renames "R087\told\tnew"; mode 160000 is a submodule.
 */
export function parseRaw(out: string): FileChange[] {
  const files: FileChange[] = [];
  const seen = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.startsWith(':')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [oldMode, newMode, oldSha, newSha, st] = line.slice(1, tab).split(' ');
    const paths = line.slice(tab + 1).split('\t');
    const letter = (st ?? 'M')[0];
    const status = (['A', 'D', 'R', 'C', 'U'].includes(letter) ? letter : 'M') as FileChange['status'];
    const path = paths[paths.length - 1];
    if (seen.has(path)) continue; // a merge without --first-parent lists a path once per parent
    seen.add(path);
    const isSub = oldMode === '160000' || newMode === '160000';
    const f: FileChange = { path, status, kind: isSub ? 'submodule' : kindOf(path), additions: 0, deletions: 0, lazy: !isSub };
    if (paths.length > 1) f.oldPath = paths[0];
    if (isSub) f.submodule = { before: /^0+$/.test(oldSha ?? '') ? '' : oldSha, after: /^0+$/.test(newSha ?? '') ? '' : newSha };
    files.push(f);
  }
  return files;
}

/** `binary`: git counts no lines ("-\t-"): a binary file whatever its name says */
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary?: boolean }> {
  const map = new Map<string, { additions: number; deletions: number; binary?: boolean }>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const m = t.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    let path = m[3];
    if (path === '') path = tokens[i + 2] ?? '';
    if (m[3] === '') i += 2; // rename: "a\tb\t\0old\0new\0"
    map.set(path, { additions: m[1] === '-' ? 0 : parseInt(m[1], 10), deletions: m[2] === '-' ? 0 : parseInt(m[2], 10), ...(m[1] === '-' && m[2] === '-' ? { binary: true } : {}) });
  }
  return map;
}
