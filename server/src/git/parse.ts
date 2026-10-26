import type { Commit, ContentKind, DiffLine, FileChange, FileStatus, Hunk, Ref, Remote, Stash } from '../types.js';

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

// ---------- unified diff ----------

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
    if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('old mode') || line.startsWith('new mode')) continue;
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
        const sha = line.slice('+Subproject commit '.length).trim();
        cur.submodule = cur.submodule ?? { before: '', after: '' };
        if (line[0] === '-') cur.submodule.before = sha;
        else cur.submodule.after = sha;
      }
      continue;
    }
    if (line.startsWith('\\ No newline')) continue;
    const c = line[0];
    const text = line.slice(1);
    if ((c === '+' || c === '-') && text.startsWith('Subproject commit ')) {
      cur.kind = 'submodule';
      cur.hunks = undefined;
      hunk = null;
      cur.submodule = cur.submodule ?? { before: '', after: '' };
      if (c === '-') cur.submodule.before = text.slice('Subproject commit '.length).trim();
      else cur.submodule.after = text.slice('Subproject commit '.length).trim();
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
  const body = hunk.lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text).join('\n');
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

export function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const m = t.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    let path = m[3];
    if (path === '') path = tokens[i + 2] ?? '';
    if (m[3] === '') i += 2; // rename: "a\tb\t\0old\0new\0"
    map.set(path, { additions: m[1] === '-' ? 0 : parseInt(m[1], 10), deletions: m[2] === '-' ? 0 : parseInt(m[2], 10) });
  }
  return map;
}
