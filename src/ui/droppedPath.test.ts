import { describe, expect, it } from 'vitest';
import { droppedPath } from './droppedPath';

const dt = (data: Record<string, string>) => ({ getData: (t: string) => data[t] ?? '' });

describe('droppedPath: what a drop on the window opens', () => {
  it('a file:// address (Finder in a browser that gives one), decoded, without a trailing slash', () => {
    expect(droppedPath(dt({ 'text/uri-list': 'file:///Users/me/work/my%20repo/\r\n' }))).toBe('/Users/me/work/my repo');
    expect(droppedPath(dt({ 'text/uri-list': '# comment\nfile:///tmp/x' }))).toBe('/tmp/x');
  });
  it('a typed or pasted path', () => {
    expect(droppedPath(dt({ 'text/plain': '  ~/work/homescapes/ ' }))).toBe('~/work/homescapes');
    expect(droppedPath(dt({ 'text/plain': '/var/repos/alpha' }))).toBe('/var/repos/alpha');
  });
  it('nothing for a web link, plain words or a folder without a path', () => {
    expect(droppedPath(dt({ 'text/uri-list': 'https://github.com/x/y' }))).toBeNull();
    expect(droppedPath(dt({ 'text/plain': 'hello world' }))).toBeNull();
    expect(droppedPath(dt({}))).toBeNull();
    expect(droppedPath(null)).toBeNull();
  });
});
