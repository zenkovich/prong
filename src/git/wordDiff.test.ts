import { describe, expect, it } from 'vitest';
import { cutAtMarks, hunkMarks, wordDiff, wordTokens } from './wordDiff';

const marked = (s: string, marks: [number, number][]) => marks.map(([a, b]) => s.slice(a, b));

describe('changed words inside a changed line', () => {
  it('words, spaces and punctuation are tokens', () => {
    expect(wordTokens('const x = foo(1);')).toEqual(['const', ' ', 'x', ' ', '=', ' ', 'foo', '(', '1', ')', ';']);
    expect(wordTokens('ветка main')).toEqual(['ветка', ' ', 'main']);
  });

  it('one word changed: only it is marked, on both sides', () => {
    const a = 'const timeout = 3000;';
    const b = 'const timeout = 5000;';
    const d = wordDiff(a, b)!;
    expect(marked(a, d.a)).toEqual(['3000']);
    expect(marked(b, d.b)).toEqual(['5000']);
  });

  it('an inserted argument is marked on the new side only', () => {
    const d = wordDiff('call(a, b)', 'call(a, x, b)')!;
    expect(d.a).toEqual([]);
    expect(marked('call(a, x, b)', d.b).join('').trim()).toBe('x,');
  });

  it('neighbouring changed words make one mark, the space between included', () => {
    const b = 'let total be zero now';
    const d = wordDiff('let sum is zero now', b)!;
    expect(marked(b, d.b)).toEqual(['total be']);
  });

  it('lines rewritten from scratch are left plain; so are equal lines', () => {
    expect(wordDiff('import React from "react";', 'export default function App() {}')).toBeNull();
    expect(wordDiff('    a', '    b')).toBeNull();
    expect(wordDiff('same', 'same')).toBeNull();
  });

  it('a hunk: the k-th removed line goes with the k-th added one; context and unpaired lines stay plain', () => {
    const m = hunkMarks([
      { kind: 'ctx', text: 'x' },
      { kind: 'del', text: 'retries = 3' },
      { kind: 'del', text: 'name = "old"' },
      { kind: 'add', text: 'retries = 5' },
      { kind: 'add', text: 'name = "new"' },
      { kind: 'add', text: 'a brand new line' },
    ] as any);
    expect([...m.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(m.get(3)).toEqual([[10, 11]]);
  });

  it('a token is cut where a mark starts and ends', () => {
    expect(cutAtMarks(4, 'abcdef', [[5, 7]])).toEqual([['a', false], ['bc', true], ['def', false]]);
    expect(cutAtMarks(0, 'abc', undefined)).toEqual([['abc', false]]);
    expect(cutAtMarks(10, 'abc', [[0, 5]])).toEqual([['abc', false]]);
  });
});
