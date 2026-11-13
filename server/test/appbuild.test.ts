import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, buildOutdated, newerBuildOnDisk, runningBundle, saveHandoff, takeHandoff } from '../src/appbuild.js';

/** Prong building itself (macos/build.sh) and restarting into the build, the chat handed over */
describe('app build and restart', () => {
  let dir: string;
  let sources: string;
  const before = { state: process.env.PRONG_STATE_DIR, cmd: process.env.PRONG_APP_BUILD_CMD };
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'prong-appbuild-'));
    process.env.PRONG_STATE_DIR = path.join(dir, 'state');
    mkdirSync(process.env.PRONG_STATE_DIR, { recursive: true });
    sources = path.join(dir, 'sources');
    mkdirSync(path.join(sources, 'server/src'), { recursive: true });
    mkdirSync(path.join(sources, 'src'), { recursive: true });
    writeFileSync(path.join(sources, 'server/src/api.ts'), 'export {};\n');
    writeFileSync(path.join(sources, 'src/App.tsx'), 'export {};\n');
  });
  afterAll(() => {
    process.env.PRONG_STATE_DIR = before.state;
    process.env.PRONG_APP_BUILD_CMD = before.cmd;
    if (before.cmd === undefined) delete process.env.PRONG_APP_BUILD_CMD;
    rmSync(dir, { recursive: true, force: true });
  });
  const at = (p: string, t: number) => utimesSync(path.join(sources, p), t / 1000, t / 1000);
  const bundle = () => {
    const plist = path.join(sources, 'macos/build/Prong.app/Contents/Info.plist');
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(plist, '<plist/>');
    return 'macos/build/Prong.app/Contents/Info.plist';
  };

  it('knows the bundle it runs from, and that a dev run has none', () => {
    expect(runningBundle('/Users/a/prong/macos/build/Prong.app/Contents/Resources/bin/node')).toBe('/Users/a/prong/macos/build/Prong.app');
    expect(runningBundle('/opt/homebrew/bin/node')).toBeNull();
  });

  it('a build is outdated when the sources changed after it, and newer than a run that started before it', () => {
    rmSync(path.join(sources, 'macos'), { recursive: true, force: true });
    expect(buildOutdated(sources)).toBe(true);
    expect(newerBuildOnDisk(sources, 0)).toBe(false);
    const plist = bundle();
    const now = Date.now();
    at('server/src/api.ts', now - 60_000);
    at('src/App.tsx', now - 60_000);
    at(plist, now - 1000);
    // the agent ran macos/build.sh after its edits: only a restart is left
    expect(buildOutdated(sources)).toBe(false);
    expect(newerBuildOnDisk(sources, now - 30_000)).toBe(true);
    expect(newerBuildOnDisk(sources, now)).toBe(false);
    // an edit to the engine after that build: it has to be built again
    at('server/src/api.ts', now);
    expect(buildOutdated(sources)).toBe(true);
  });

  it('the chat handed over comes back once, and not when it is old', () => {
    expect(takeHandoff()).toBeNull();
    saveHandoff({ agent: { messages: [{ id: 1, text: 'hi' }] }, restarted: true });
    expect(takeHandoff()).toEqual({ agent: { messages: [{ id: 1, text: 'hi' }] }, restarted: true });
    expect(takeHandoff()).toBeNull();
    saveHandoff({ agent: {} });
    expect(takeHandoff(Date.now() + 10 * 60_000)).toBeNull();
    saveHandoff('not an object');
    saveHandoff([1, 2]);
    expect(takeHandoff()).toBeNull();
  });

  it('runs the build in the sources with its lines, and a failure says what the build said last', async () => {
    process.env.PRONG_APP_BUILD_CMD = 'echo "▸ web build"; pwd; echo "▸ engine build"';
    const lines: string[] = [];
    await buildApp(sources, (l) => lines.push(l));
    expect(lines[0]).toBe('▸ web build');
    expect(lines[1]).toMatch(/sources$/);
    process.env.PRONG_APP_BUILD_CMD = 'echo "▸ engine build"; echo "error TS1005: \';\' expected" >&2; exit 2';
    await expect(buildApp(sources)).rejects.toThrow(/Prong\.app build failed: [\s\S]*TS1005/);
  });

  it('without a stand-in it runs macos/build.sh, which has to be there', async () => {
    delete process.env.PRONG_APP_BUILD_CMD;
    await expect(buildApp(sources)).rejects.toThrow(/build\.sh is missing/);
  });
});
