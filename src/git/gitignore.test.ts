import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ignorePattern } from './gitignore';

describe('ignorePattern', () => {
  it('anchors the path at the root, keeps a folder a folder', () => {
    expect(ignorePattern('notes.txt')).toBe('/notes.txt');
    expect(ignorePattern('sub/notes.txt')).toBe('/sub/notes.txt');
    expect(ignorePattern('fresh/')).toBe('/fresh/');
  });
  it('escapes the characters git reads as a pattern', () => {
    expect(ignorePattern('a*b?[1].txt')).toBe('/a\\*b\\?\\[1\\].txt');
    expect(ignorePattern('!important')).toBe('/\\!important');
    expect(ignorePattern('#hash')).toBe('/\\#hash');
    expect(ignorePattern('back\\slash')).toBe('/back\\\\slash');
    expect(ignorePattern('trailing  ')).toBe('/trailing\\ \\ ');
  });
  it('git ignores exactly those files with these lines', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prong-ignore-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const names = ['notes.txt', 'a*b.txt', 'ab.txt', '[x].txt', 'x.txt', 'trailing ', '#hash'];
      for (const n of names) writeFileSync(path.join(dir, n), 'x');
      execFileSync('mkdir', ['-p', path.join(dir, 'sub')]);
      writeFileSync(path.join(dir, 'sub/notes.txt'), 'x');
      writeFileSync(path.join(dir, '.gitignore'), ['notes.txt', 'a*b.txt', '[x].txt', 'trailing ', '#hash'].map(ignorePattern).join('\n') + '\n');
      const left = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: dir }).toString().split('\0').filter(Boolean).sort();
      expect(left).toEqual(['.gitignore', 'ab.txt', 'sub/notes.txt', 'x.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
