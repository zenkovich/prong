import { describe, expect, it } from 'vitest';
import { langOf, tokenize, type TokenKind } from './highlight';

const kinds = (line: string, path: string) => tokenize(line, langOf(path)).filter((t) => t.kind !== 'plain' && t.kind !== 'punct').map((t) => [t.text.trim(), t.kind] as [string, TokenKind]);

describe('syntax highlighting', () => {
  it('picks a language for every text file, generic when unknown', () => {
    expect(langOf('src/App.tsx').id).toBe('js');
    expect(langOf('main.PY').id).toBe('python');
    expect(langOf('Engine/Core.mm').id).toBe('c');
    expect(langOf('Dockerfile').id).toBe('docker');
    expect(langOf('Makefile').id).toBe('make');
    expect(langOf('config/app.yml').id).toBe('yaml');
    expect(langOf('Cargo.toml').id).toBe('ini');
    expect(langOf('ui/Main.storyboard').id).toBe('markup');
    expect(langOf('notes.txt').id).toBe('generic');
    expect(langOf('LICENSE').id).toBe('generic');
  });
  it('code: keywords, strings, numbers, functions, types, comments', () => {
    expect(kinds("export const x: Foo = load('a', 42); // why", 'a.ts')).toEqual([
      ['export', 'kw'],
      ['const', 'kw'],
      ['Foo', 'type'],
      ['load', 'fn'],
      ["'a'", 'str'],
      ['42', 'num'],
      ['// why', 'cm'],
    ]);
    expect(kinds('def run(self, n=0x1F):  # go', 'x.py')).toEqual([
      ['def', 'kw'],
      ['run', 'fn'],
      ['self', 'kw'],
      ['0x1F', 'num'],
      ['# go', 'cm'],
    ]);
    expect(kinds('#include <stdio.h>', 'a.c')).toEqual([['#include <stdio.h>', 'meta']]);
    expect(kinds(' * part of a block comment', 'a.cpp')).toEqual([['* part of a block comment', 'cm']]);
    expect(kinds('SELECT id FROM users -- all', 'q.sql')).toEqual([
      ['SELECT', 'kw'],
      ['FROM', 'kw'],
      ['-- all', 'cm'],
    ]);
    expect(kinds('echo "$HOME" ${PATH} # x', 'run.sh')).toEqual([
      ['echo', 'kw'],
      ['"$HOME"', 'str'],
      ['${PATH}', 'prop'],
      ['# x', 'cm'],
    ]);
  });
  it('json keys differ from string values', () => {
    expect(kinds('  "name": "prong", "n": 3, "ok": true', 'package.json')).toEqual([
      ['"name"', 'prop'],
      ['"prong"', 'str'],
      ['"n"', 'prop'],
      ['3', 'num'],
      ['"ok"', 'prop'],
      ['true', 'kw'],
    ]);
  });
  it('markup: tags, attributes, values, comments', () => {
    expect(kinds('<a href="x" data-id=\'1\'>t</a> <!-- c -->', 'i.html')).toEqual([
      ['<a', 'tag'],
      ['href', 'attr'],
      ['"x"', 'str'],
      ['data-id', 'attr'],
      ["'1'", 'str'],
      ['>', 'tag'],
      ['</a>', 'tag'], // neighbouring tokens of one kind merge
      ['<!-- c -->', 'cm'],
    ]);
  });
  it('yaml, ini, css, markdown, generic', () => {
    expect(kinds('  timeout: 30 # s', 'a.yml')).toEqual([
      ['timeout', 'prop'],
      ['30', 'num'],
      ['# s', 'cm'],
    ]);
    expect(kinds('[server]', 'a.toml')).toEqual([['[server]', 'tag']]);
    expect(kinds('port = 8080', 'a.ini')).toEqual([
      ['port', 'prop'],
      ['8080', 'num'],
    ]);
    expect(kinds('  color: #fff;', 'a.css')).toEqual([
      ['color', 'prop'],
      ['#fff', 'num'],
    ]);
    expect(kinds('## Title', 'R.md')).toEqual([['## Title', 'heading']]);
    expect(kinds('- use `npm test` and **this**', 'R.md')).toEqual([
      ['-', 'kw'],
      ['`npm test`', 'str'],
      ['**this**', 'emph'],
    ]);
    expect(kinds('# comment', 'notes.txt')).toEqual([['# comment', 'cm']]);
    expect(kinds('version "1.2" is 42', 'notes.txt')).toEqual([
      ['"1.2"', 'str'],
      ['42', 'num'],
    ]);
  });
  it('never loses text', () => {
    for (const [line, file] of [['const a = `x${b}` + "q\\"" // t', 'a.ts'], ['<x a=1/>', 'a.xml'], ['a: [1, "b"]', 'a.yaml']]) {
      expect(tokenize(line, langOf(file)).map((t) => t.text).join('')).toBe(line);
    }
  });
});
