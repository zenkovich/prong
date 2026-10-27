import type { DiffLine, Hunk } from './types';

/**
 * Staging, unstaging and discarding single lines: a hunk reduced to the selected changed lines, with the
 * rest turned into what the target already contains, so `git apply` (the engine's hunk endpoints) does the rest.
 *
 * forward (stage: index ← worktree change): unselected deletions stay as context, unselected additions are
 *   dropped; counted from the hunk's old start (the index side).
 * reverse (unstage from the staged diff, discard from the unstaged diff; applied with --reverse): unselected
 *   additions stay as context, unselected deletions are dropped; counted from the new start (the side the
 *   reverse patch is applied to).
 */

export function parseHeader(header: string): { oldStart: number; oldCount: number; newStart: number; newCount: number; tail: string } | null {
  const m = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!m) return null;
  return { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], tail: m[5] };
}

export function partialHunk(hunk: Hunk, selected: Iterable<number>, direction: 'forward' | 'reverse'): Hunk | null {
  const sel = new Set(selected);
  const h = parseHeader(hunk.header);
  if (!h) return null;
  const lines: DiffLine[] = [];
  let changed = 0;
  // a change block (its removed lines, then its added ones) goes row by row as split view pairs them: the k-th
  // removed line with the k-th added one. Picking "old 2 → new 2" puts new 2 where old 2 was; line by line in the
  // hunk's order it landed after "old 3" (the unpicked removals, kept as context, came before every addition).
  const emit = (l: DiffLine | undefined, i: number) => {
    if (!l) return;
    if (sel.has(i)) {
      changed++;
      return void lines.push(l);
    }
    // not selected: keep what the target side already has
    if (direction === 'forward' && l.kind === 'del') lines.push({ ...l, kind: 'ctx' });
    if (direction === 'reverse' && l.kind === 'add') lines.push({ ...l, kind: 'ctx' });
  };
  for (let i = 0; i < hunk.lines.length; ) {
    if (hunk.lines[i].kind === 'ctx') {
      lines.push(hunk.lines[i++]);
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    for (; i < hunk.lines.length && hunk.lines[i].kind !== 'ctx'; i++) (hunk.lines[i].kind === 'del' ? dels : adds).push(i);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      if (k < dels.length) emit(hunk.lines[dels[k]], dels[k]);
      if (k < adds.length) emit(hunk.lines[adds[k]], adds[k]);
    }
  }
  if (!changed) return null;
  const out = endOfFile(lines);
  const oldCount = out.filter((l) => l.kind !== 'add').length;
  const newCount = out.filter((l) => l.kind !== 'del').length;
  const start = direction === 'forward' ? h.oldStart : h.newStart;
  // a zero-length side starts at the line before (git's convention)
  const oldStart = oldCount === 0 ? Math.max(0, start - 1) : Math.max(1, start);
  const newStart = newCount === 0 ? Math.max(0, start - 1) : Math.max(1, start);
  return { id: `${hunk.id}:lines`, header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${h.tail}`, lines: out };
}

/**
 * "No newline at end of file" (`noEol`) belongs to the last line of a side. Once some lines are left out it may sit
 * on a line that is no longer last: that line gets its newline back (the side goes on after it), and a context line
 * that is last on one side only is written as its two versions, without and with the newline (git apply refuses
 * a patch that gets this wrong, and a file without a final newline is common).
 */
function endOfFile(lines: DiffLine[]): DiffLine[] {
  if (!lines.some((l) => l.noEol)) return lines;
  const out: DiffLine[] = [];
  const tail: DiffLine[] = [];
  lines.forEach((l, i) => {
    if (!l.noEol) return void out.push(l);
    const rest = lines.slice(i + 1);
    const oldGoesOn = rest.some((x) => x.kind !== 'add');
    const newGoesOn = rest.some((x) => x.kind !== 'del');
    if (l.kind === 'del') out.push(oldGoesOn ? { ...l, noEol: false } : l);
    else if (l.kind === 'add') out.push(newGoesOn ? { ...l, noEol: false } : l);
    else if (oldGoesOn && newGoesOn) out.push({ ...l, noEol: false });
    // last of the old side only: the new side has it with a newline, then more
    else if (newGoesOn) out.push({ ...l, kind: 'del' }, { ...l, kind: 'add', noEol: false });
    // last of the new side only: the old side has it with a newline (its deletions follow), the new one ends with it
    else if (oldGoesOn) {
      out.push({ ...l, kind: 'del', noEol: false });
      tail.push({ ...l, kind: 'add' });
    }
    else out.push(l);
  });
  return [...out, ...tail];
}

/** indices of changed lines between two clicked lines (shift-click selects a range of changed lines) */
export function lineRange(hunk: Hunk, a: number, b: number): number[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const out: number[] = [];
  for (let i = from; i <= to; i++) if (hunk.lines[i] && hunk.lines[i].kind !== 'ctx') out.push(i);
  return out;
}
