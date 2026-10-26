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
  hunk.lines.forEach((l, i) => {
    if (l.kind === 'ctx') return void lines.push(l);
    const picked = sel.has(i);
    if (picked) {
      changed++;
      return void lines.push(l);
    }
    // not selected: keep what the target side already has
    if (direction === 'forward' && l.kind === 'del') lines.push({ ...l, kind: 'ctx' });
    if (direction === 'reverse' && l.kind === 'add') lines.push({ ...l, kind: 'ctx' });
  });
  if (!changed) return null;
  const oldCount = lines.filter((l) => l.kind !== 'add').length;
  const newCount = lines.filter((l) => l.kind !== 'del').length;
  const start = direction === 'forward' ? h.oldStart : h.newStart;
  // a zero-length side starts at the line before (git's convention)
  const oldStart = oldCount === 0 ? Math.max(0, start - 1) : Math.max(1, start);
  const newStart = newCount === 0 ? Math.max(0, start - 1) : Math.max(1, start);
  return { id: `${hunk.id}:lines`, header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${h.tail}`, lines };
}

/** indices of changed lines between two clicked lines (shift-click selects a range of changed lines) */
export function lineRange(hunk: Hunk, a: number, b: number): number[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const out: number[] = [];
  for (let i = from; i <= to; i++) if (hunk.lines[i] && hunk.lines[i].kind !== 'ctx') out.push(i);
  return out;
}
