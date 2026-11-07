import type { DiffLine } from './types';

/**
 * What changed inside a changed line, as Fork shows it: a removed line and the added line that replaces it are
 * compared word by word, and the words that differ get a stronger colour. Lines too different to read as one line
 * edited (less than a third in common) are left plain, like a line rewritten from scratch.
 */

/** [start, end) character ranges of a line */
export type Marks = [number, number][];

/** words (letters, digits, _), runs of spaces, and each other character on its own */
export function wordTokens(s: string): string[] {
  return s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

/** longer lines are not compared (the table is lines × tokens) */
const MAX_TOKENS = 400;
/** the share of the two lines in common below which they are not one line edited */
const MIN_SIMILAR = 0.34;

/** the changed characters of `a` and of `b`, or null when they are too different (or equal) */
export function wordDiff(a: string, b: string): { a: Marks; b: Marks } | null {
  if (a === b) return null;
  const x = wordTokens(a);
  const y = wordTokens(b);
  if (!x.length || !y.length || x.length > MAX_TOKENS || y.length > MAX_TOKENS) return null;
  // longest common subsequence of tokens (lines are short: a plain table is fine)
  const n = x.length;
  const m = y.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  let common = 0;
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (x[i] === y[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
      common += x[i - 1].length;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  // what is in common, not counting the spaces (an indent alone does not make two lines alike)
  const solid = (s: string) => s.replace(/\s+/g, '').length;
  const sharedSolid = x.reduce((k, tok, i) => k + (keepA[i] ? solid(tok) : 0), 0);
  if ((2 * sharedSolid) / Math.max(1, solid(a) + solid(b)) < MIN_SIMILAR || common === 0) return null;
  return { a: marksOf(x, keepA), b: marksOf(y, keepB) };
}

/** ranges of the tokens not kept; a space between two changed words is changed too (one mark, not two) */
function marksOf(tokens: string[], keep: boolean[]): Marks {
  const out: Marks = [];
  let at = 0;
  for (let i = 0; i < tokens.length; i++) {
    const end = at + tokens[i].length;
    const changed = !keep[i] || (/^\s+$/.test(tokens[i]) && i > 0 && i < tokens.length - 1 && !keep[i - 1] && !keep[i + 1]);
    if (changed) {
      const last = out[out.length - 1];
      if (last && last[1] === at) last[1] = end;
      else out.push([at, end]);
    }
    at = end;
  }
  return out;
}

/**
 * The marks of a hunk's lines (by index): each run of removed lines followed by added ones is paired line by line,
 * the k-th removed with the k-th added, as the split view puts them side by side.
 */
export function hunkMarks(lines: DiffLine[]): Map<number, Marks> {
  const out = new Map<number, Marks>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== 'del') {
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < lines.length && lines[i].kind === 'del') dels.push(i++);
    while (i < lines.length && lines[i].kind === 'add') adds.push(i++);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const d = wordDiff(lines[dels[k]].text, lines[adds[k]].text);
      if (!d) continue;
      if (d.a.length) out.set(dels[k], d.a);
      if (d.b.length) out.set(adds[k], d.b);
    }
  }
  return out;
}

/** a line's pieces: [text, marked] in order, cut at the marks (for drawing coloured tokens with marks on top) */
export function cutAtMarks(start: number, text: string, marks: Marks | undefined): [string, boolean][] {
  if (!marks?.length) return [[text, false]];
  const out: [string, boolean][] = [];
  let at = 0;
  for (const [s0, e0] of marks) {
    const s = Math.max(0, s0 - start);
    const e = Math.min(text.length, e0 - start);
    if (e <= 0 || s >= text.length || e <= s) continue;
    if (s > at) out.push([text.slice(at, s), false]);
    out.push([text.slice(Math.max(s, at), e), true]);
    at = e;
  }
  if (at < text.length) out.push([text.slice(at), false]);
  return out;
}
