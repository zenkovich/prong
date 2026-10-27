import { describe, expect, it } from 'vitest';
import { lineRange, parseHeader, partialHunk } from './lineStaging';
import type { Hunk } from './types';

const hunk: Hunk = {
  id: 'h1',
  header: '@@ -10,5 +10,6 @@ function f()',
  lines: [
    { kind: 'ctx', oldNo: 10, newNo: 10, text: 'a' },
    { kind: 'del', oldNo: 11, text: 'old b' },
    { kind: 'del', oldNo: 12, text: 'old c' },
    { kind: 'add', newNo: 11, text: 'new b' },
    { kind: 'add', newNo: 12, text: 'new c' },
    { kind: 'add', newNo: 13, text: 'new d' },
    { kind: 'ctx', oldNo: 13, newNo: 14, text: 'e' },
  ],
};
const show = (h: Hunk | null) => (h ? [h.header, ...h.lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)] : null);

describe('line staging', () => {
  it('reads hunk headers, including omitted counts', () => {
    expect(parseHeader('@@ -3 +4,0 @@')).toEqual({ oldStart: 3, oldCount: 1, newStart: 4, newCount: 0, tail: '' });
    expect(parseHeader('garbage')).toBeNull();
  });
  it('stages one replaced line in its place: the other deletion stays as context after it, other additions are dropped', () => {
    // the index gets a, new b, old c, e (it used to get a, old c, new b, e: the pair out of order)
    expect(show(partialHunk(hunk, [1, 3], 'forward'))).toEqual(['@@ -10,4 +10,4 @@ function f()', ' a', '-old b', '+new b', ' old c', ' e']);
  });
  it('stages the second pair of a block where it is (split view pairs row by row)', () => {
    expect(show(partialHunk(hunk, [2, 4], 'forward'))).toEqual(['@@ -10,4 +10,4 @@ function f()', ' a', ' old b', '-old c', '+new c', ' e']);
  });
  it('stages a lone addition', () => {
    expect(show(partialHunk(hunk, [5], 'forward'))).toEqual(['@@ -10,4 +10,5 @@ function f()', ' a', ' old b', ' old c', '+new d', ' e']);
  });
  it('unstages / discards from the new side: unselected additions become context, unselected deletions vanish', () => {
    expect(show(partialHunk(hunk, [4], 'reverse'))).toEqual(['@@ -10,4 +10,5 @@ function f()', ' a', ' new b', '+new c', ' new d', ' e']);
    // old c comes back in its row, beside new c (it used to come back above new b)
    expect(show(partialHunk(hunk, [2], 'reverse'))).toEqual(['@@ -10,6 +10,5 @@ function f()', ' a', ' new b', '-old c', ' new c', ' new d', ' e']);
    // discarding a pair: the old line back where the new one was
    expect(show(partialHunk(hunk, [2, 4], 'reverse'))).toEqual(['@@ -10,5 +10,5 @@ function f()', ' a', ' new b', '-old c', '+new c', ' new d', ' e']);
  });
  it('nothing selected, or only context selected: no patch', () => {
    expect(partialHunk(hunk, [], 'forward')).toBeNull();
    expect(partialHunk(hunk, [0, 6], 'forward')).toBeNull();
  });
  it("a pure deletion at the top uses git's zero-length convention", () => {
    const h: Hunk = { id: 'x', header: '@@ -1,2 +0,0 @@', lines: [{ kind: 'del', oldNo: 1, text: 'x' }, { kind: 'del', oldNo: 2, text: 'y' }] };
    expect(partialHunk(h, [0, 1], 'forward')!.header).toBe('@@ -1,2 +0,0 @@');
  });
  it('picking lines of a brand-new file creates it with just those lines', () => {
    const h: Hunk = { id: 'n', header: '@@ -0,0 +1,3 @@', lines: [{ kind: 'add', newNo: 1, text: 'a' }, { kind: 'add', newNo: 2, text: 'b' }, { kind: 'add', newNo: 3, text: 'c' }] };
    expect(show(partialHunk(h, [0, 2], 'forward'))).toEqual(['@@ -0,0 +1,2 @@', '+a', '+c']);
  });
  describe('a file without a newline at its end', () => {
    // "a\nb" → "a\nc": git marks both b and c "\ No newline at end of file"
    const h: Hunk = {
      id: 'e',
      header: '@@ -1,2 +1,2 @@',
      lines: [
        { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
        { kind: 'del', oldNo: 2, text: 'b', noEol: true },
        { kind: 'add', newNo: 2, text: 'c', noEol: true },
      ],
    };
    const eol = (x: Hunk | null) => x!.lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text + (l.noEol ? '⏎̸' : ''));
    it('both lines picked: the markers stay', () => {
      expect(eol(partialHunk(h, [1, 2], 'forward'))).toEqual([' a', '-b⏎̸', '+c⏎̸']);
    });
    it('staging only the addition: the old last line gains its newline on the new side', () => {
      const p = partialHunk(h, [2], 'forward')!;
      expect(eol(p)).toEqual([' a', '-b⏎̸', '+b', '+c⏎̸']);
      expect(p.header).toBe('@@ -1,2 +1,3 @@');
    });
    it('discarding only the deletion: the line put back is no longer last', () => {
      expect(eol(partialHunk(h, [1], 'reverse'))).toEqual([' a', '-b', ' c⏎̸']);
    });
    it('staging only the deletion: nothing after it, the marker stays', () => {
      expect(eol(partialHunk(h, [1], 'forward'))).toEqual([' a', '-b⏎̸']);
    });
  });
  it('shift-click ranges keep only changed lines', () => {
    expect(lineRange(hunk, 5, 0)).toEqual([1, 2, 3, 4, 5]);
    expect(lineRange(hunk, 2, 2)).toEqual([2]);
  });
});
