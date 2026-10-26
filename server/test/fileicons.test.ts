import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findThemeIcon, mimeDirRank, namesForMime, normalizeExt, parseGioIcons, systemFileIcon, windowsScript, type FsLike } from '../src/fileicons.js';

describe('file icon helpers', () => {
  it('accepts plain extensions only', () => {
    expect(normalizeExt('.PBXProj')).toBe('pbxproj');
    expect(normalizeExt('c++')).toBe('c++');
    expect(normalizeExt('a/b')).toBeNull();
    expect(normalizeExt("x';rm -rf ~")).toBeNull();
    expect(normalizeExt('')).toBeNull();
    expect(normalizeExt('averyveryverylongextension')).toBeNull();
  });
  it('reads gio icon names and derives freedesktop names from MIME types', () => {
    expect(parseGioIcons('uri: file:///tmp/x.py\n  standard::icon: text-x-python, text-x-generic, text-x-python-symbolic\n')).toEqual(['text-x-python', 'text-x-generic']);
    expect(parseGioIcons('nothing')).toEqual([]);
    expect(namesForMime('text/x-python\n')).toEqual(['text-x-python', 'text-x-generic']);
    expect(namesForMime('garbage')).toEqual([]);
  });
  it('ranks MIME icon folders: scalable, then 64, 48, 32; never symbolic or tiny', () => {
    expect(mimeDirRank('scalable/mimetypes')).toBeGreaterThan(mimeDirRank('64x64/mimetypes'));
    expect(mimeDirRank('mimetypes/64')).toBeGreaterThan(mimeDirRank('48x48/mimetypes'));
    expect(mimeDirRank('48x48/mimetypes')).toBeGreaterThan(mimeDirRank('32x32/mimetypes'));
    expect(mimeDirRank('16x16/mimetypes')).toBe(-1);
    expect(mimeDirRank('symbolic/mimetypes')).toBe(-1);
    expect(mimeDirRank('48x48/apps')).toBe(-1);
  });
  it('finds icons in both freedesktop layouts and falls through themes', () => {
    const files = new Set(['/icons/Adwaita/scalable/mimetypes/text-x-generic.svg', '/icons/breeze/mimetypes/64/text-x-python.svg', '/icons/breeze/mimetypes/16/text-x-python.svg']);
    const dirs = new Set(['/icons/Adwaita', '/icons/Adwaita/scalable', '/icons/Adwaita/scalable/mimetypes', '/icons/breeze', '/icons/breeze/mimetypes', '/icons/breeze/mimetypes/64', '/icons/breeze/mimetypes/16']);
    const fs: FsLike = {
      exists: (p) => files.has(p),
      isDir: (p) => dirs.has(p),
      list: (p) => [...dirs, ...files].filter((x) => path.dirname(x) === p).map((x) => path.basename(x)),
    };
    expect(findThemeIcon(['text-x-python'], ['breeze', 'Adwaita'], ['/icons'], fs)).toBe('/icons/breeze/mimetypes/64/text-x-python.svg');
    expect(findThemeIcon(['text-x-python', 'text-x-generic'], ['Adwaita'], ['/icons'], fs)).toBe('/icons/Adwaita/scalable/mimetypes/text-x-generic.svg');
    expect(findThemeIcon(['nothing'], ['Adwaita', 'breeze'], ['/icons'], fs)).toBeNull();
  });
  it('quotes the output folder in the PowerShell script', () => {
    const s = windowsScript(['pbxproj', 'meta'], "C:\\Users\\o'neil\\icons");
    expect(s).toContain("@('pbxproj','meta')");
    expect(s).toContain("C:\\Users\\o''neil\\icons");
  });
});

describe('systemFileIcon', () => {
  let dir: string;
  let prev: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'prong-icons-'));
    prev = process.env.PRONG_STATE_DIR;
    process.env.PRONG_STATE_DIR = dir;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.PRONG_STATE_DIR;
    else process.env.PRONG_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('batches concurrent requests into one render, caches hits and misses', async () => {
    const calls: string[][] = [];
    const render = async (exts: string[], out: string) => {
      calls.push(exts);
      const m = new Map<string, string>();
      for (const e of exts)
        if (e !== 'nope') {
          const f = path.join(out, `test-${e}.png`);
          writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, e.length]));
          m.set(e, f);
        }
      return m;
    };
    const [a, b, c, d] = await Promise.all([systemFileIcon('meta', 'test', render), systemFileIcon('.prefab', 'test', render), systemFileIcon('meta', 'test', render), systemFileIcon('nope', 'test', render)]);
    expect(calls).toEqual([['meta', 'prefab', 'nope']]);
    expect(a!.mime).toBe('image/png');
    expect([...b!.data].at(-1)).toBe(6);
    expect(c!.data.equals(a!.data)).toBe(true);
    expect(d).toBeNull();
    await systemFileIcon('meta', 'test', render);
    await systemFileIcon('nope', 'test', render);
    expect(calls).toHaveLength(1); // both answered from the disk cache
    expect(await systemFileIcon('../x', 'test', render)).toBeNull();
    expect(await systemFileIcon('meta', 'plan9')).toBeNull(); // no renderer for the platform
  });

  it.runIf(process.platform === 'darwin')('renders real macOS icons (PNG, 64×64)', async () => {
    const icon = await systemFileIcon('pbxproj');
    expect(icon?.mime).toBe('image/png');
    expect(icon!.data.subarray(1, 4).toString()).toBe('PNG');
    expect(icon!.data.readUInt32BE(16)).toBe(64);
  });
});
