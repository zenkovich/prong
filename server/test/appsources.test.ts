import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppSources, buildUi, currentUiBuild, resetUiToFactory } from '../src/appsources.js';
import { runGit } from '../src/git/run.js';

let root: string;
const prevEnv = { ...process.env };
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'prong-app-'));
  process.env.PRONG_STATE_DIR = path.join(root, 'state');
});
afterAll(() => {
  process.env = prevEnv;
  rmSync(root, { recursive: true, force: true });
});

const makeSources = (name: string) => {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
  writeFileSync(path.join(dir, 'src/Toolbar.tsx'), 'export const theme = true;\n');
  writeFileSync(path.join(dir, 'src/Other.tsx'), 'export const other = 1;\n');
  writeFileSync(path.join(dir, 'node_modules/x/index.js'), 'junk\n');
  return dir;
};

describe('app sources: shadow version log', () => {
  it('keeps the log outside a plain folder and commits only what the agent changed', async () => {
    const dir = makeSources('plain');
    const app = new AppSources(dir);
    expect(app.own).toBe(false);
    const before = await app.prepare();
    expect(before).toEqual({});
    expect(existsSync(path.join(dir, '.git'))).toBe(false); // nothing written into the folder
    expect(app.gitDir.startsWith(path.join(root, 'state', 'app-sources'))).toBe(true);
    // the user edited a file by hand, then the agent edits another file and adds one
    writeFileSync(path.join(dir, 'src/Other.tsx'), 'export const other = 2; // user\n');
    const base = await app.prepare();
    expect(base).toEqual({}); // the manual edit went into the shadow log as "Manual changes"
    writeFileSync(path.join(dir, 'src/Toolbar.tsx'), 'export const theme = false;\n');
    writeFileSync(path.join(dir, 'src/New.tsx'), 'export const n = 1;\n');
    const v = await app.record('убери иконку темы', base);
    expect(v!.files).toEqual(['src/New.tsx', 'src/Toolbar.tsx']);
    expect((await app.dirty()).size).toBe(0);
    expect((await app.git(['log', '--format=%s'])).stdout.trim().split('\n')).toEqual(['agent: убери иконку темы', 'Manual changes', 'Baseline: sources before the first agent change']);
    // an edit made during the run that the agent did not make is not part of its version
    writeFileSync(path.join(dir, 'src/Other.tsx'), 'export const other = 3; // user again\n');
    const base2 = await app.prepare();
    writeFileSync(path.join(dir, 'src/Late.tsx'), 'x\n');
    expect((await app.record('late', base2))!.files).toEqual(['src/Late.tsx']);
    await app.revert((await app.versions()).find((x) => x.title === 'late')!.sha);
    expect(await app.record('nothing', await app.prepare())).toBeNull();
    const versions = await app.versions();
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ n: 1, title: 'убери иконку темы', prompt: 'убери иконку темы', status: 'applied' });
    expect(versions[1]).toMatchObject({ n: 2, title: 'late', status: 'reverted' });
    expect(versions[0].files.map((f) => [f.path, f.status])).toEqual([
      ['src/New.tsx', 'A'],
      ['src/Toolbar.tsx', 'M'],
    ]);
    // node_modules never enters the log
    const tracked = (await app.git(['ls-files'])).stdout;
    expect(tracked).not.toContain('node_modules');
  });

  it('reverts and re-applies a version even with manual edits since, and the log reflects it', async () => {
    const dir = path.join(root, 'plain');
    const app = new AppSources(dir);
    const [v1] = await app.versions();
    writeFileSync(path.join(dir, 'src/Other.tsx'), 'export const other = 4; // edited after the version\n');
    const r = await app.revert(v1.sha);
    expect(readFileSync(path.join(dir, 'src/Other.tsx'), 'utf8')).toContain('edited after the version');
    expect(readFileSync(path.join(dir, 'src/Toolbar.tsx'), 'utf8')).toBe('export const theme = true;\n');
    expect(existsSync(path.join(dir, 'src/New.tsx'))).toBe(false);
    let [v] = await app.versions();
    expect(v).toMatchObject({ status: 'reverted', revertSha: r });
    await app.revert(r); // re-apply = revert the revert
    [v] = await app.versions();
    expect(v.status).toBe('applied');
    expect(v.revertSha).toBeUndefined();
    expect(readFileSync(path.join(dir, 'src/Toolbar.tsx'), 'utf8')).toBe('export const theme = false;\n');
  });

  it("uses the folder's own repository when it has one, without committing unrelated edits", async () => {
    const dir = makeSources('own');
    await runGit(['init', '-q', dir], { cwd: root });
    for (const [k, v] of [['user.name', 'U'], ['user.email', 'u@x'], ['commit.gpgsign', 'false']]) await runGit(['config', k, v], { cwd: dir });
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    await runGit(['add', '-A'], { cwd: dir });
    await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
    const app = new AppSources(dir);
    expect(app.own).toBe(true);
    writeFileSync(path.join(dir, 'src/Other.tsx'), 'user wip\n');
    const base = await app.prepare();
    writeFileSync(path.join(dir, 'src/Toolbar.tsx'), 'agent\n');
    const v = await app.record('agent edit', base);
    expect(v!.files).toEqual(['src/Toolbar.tsx']);
    const log = (await runGit(['log', '--format=%s'], { cwd: dir })).stdout.trim().split('\n');
    expect(log[0]).toBe('agent: agent edit');
    const st = (await runGit(['status', '--porcelain'], { cwd: dir })).stdout;
    expect(st).toContain('src/Other.tsx');
  });
});

describe('interface build', () => {
  it('builds into a new folder, points the engine at it, prunes old builds and resets to factory', async () => {
    const dir = path.join(root, 'plain');
    process.env.PRONG_UI_BUILD_CMD = 'mkdir -p {out} && printf "<html><meta name=prong-build content=%s>" $$ > {out}/index.html';
    expect(currentUiBuild()).toBeNull();
    const outs: string[] = [];
    for (let i = 0; i < 4; i++) {
      outs.push(await buildUi(dir));
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(currentUiBuild()).toBe(outs[3]);
    expect(readFileSync(path.join(outs[3], 'index.html'), 'utf8')).toContain('prong-build');
    expect(existsSync(outs[0])).toBe(false); // keeps the newest three
    expect(existsSync(outs[1])).toBe(true);
    resetUiToFactory();
    expect(currentUiBuild()).toBeNull();
  });
  it('a factory build newer than the agent build wins (the app was rebuilt from the same sources)', async () => {
    const dir = path.join(root, 'plain');
    process.env.PRONG_UI_BUILD_CMD = 'mkdir -p {out} && printf "<html>" > {out}/index.html';
    const agent = await buildUi(dir);
    const factory = path.join(root, 'factory-newer');
    mkdirSync(factory, { recursive: true });
    expect(currentUiBuild(factory)).toBe(agent); // no factory index yet
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(path.join(factory, 'index.html'), '<html>new factory</html>');
    expect(currentUiBuild(factory)).toBeNull();
    resetUiToFactory();
  });
  it('a failing build keeps the current interface and reports the output', async () => {
    const dir = path.join(root, 'plain');
    process.env.PRONG_UI_BUILD_CMD = 'mkdir -p {out} && printf "<html>" > {out}/index.html';
    const good = await buildUi(dir);
    process.env.PRONG_UI_BUILD_CMD = 'echo "SyntaxError: Unexpected token in src/Toolbar.tsx" >&2; exit 1';
    await expect(buildUi(dir)).rejects.toThrow(/SyntaxError: Unexpected token/);
    expect(currentUiBuild()).toBe(good);
    resetUiToFactory();
  });
});

describe('app sources over HTTP', () => {
  let base: string;
  let close: () => void;
  let factory: string;
  beforeAll(async () => {
    factory = path.join(root, 'factory-web');
    mkdirSync(factory, { recursive: true });
    writeFileSync(path.join(factory, 'index.html'), '<html>factory</html>');
    process.env.PRONG_WEB_DIR = factory;
    process.env.PRONG_UI_BUILD_CMD = 'mkdir -p {out} && printf "<html>agent build</html>" > {out}/index.html';
    // api.ts reads PRONG_WEB_DIR when it loads
    const { createApi } = await import('../src/api.js');
    const { server } = createApi();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());
  const post = async (p: string, body: unknown) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

  it('records a version, rebuilds, serves the new build, broadcasts a reload, and resets to factory', async () => {
    const sources = makeSources('http');
    const events: any[] = [];
    const ctl = new AbortController();
    const sse = await fetch(base + '/api/events', { signal: ctl.signal });
    const reader = sse.body!.getReader();
    void (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let k;
          while ((k = buf.indexOf('\n\n')) >= 0) {
            const data = buf.slice(0, k).split('\n').find((l) => l.startsWith('data:'));
            buf = buf.slice(k + 2);
            if (data) events.push(JSON.parse(data.slice(5)));
          }
        }
      } catch {
        /* closed */
      }
    })();
    expect(await (await fetch(base + '/api/health')).json()).toMatchObject({ ui: 'static', uiBuild: 'factory' });
    const { before } = await post('/api/app/prepare', { sources });
    writeFileSync(path.join(sources, 'src/Toolbar.tsx'), 'changed\n');
    const v = await post('/api/app/record', { sources, message: 'hide the theme button', before });
    expect(v.files).toEqual(['src/Toolbar.tsx']);
    const list = await post('/api/app/versions', { sources });
    expect(list.map((x: any) => x.title)).toEqual(['hide the theme button']);
    const op = await post('/api/app/rebuild', { sources });
    for (let i = 0; i < 100 && !events.some((e) => e.event === 'ui-updated'); i++) await new Promise((r) => setTimeout(r, 30));
    expect(events.find((e) => e.opId === op.opId && e.done)?.error).toBeUndefined();
    expect(events.some((e) => e.event === 'ui-updated')).toBe(true);
    expect(await (await fetch(base + '/')).text()).toBe('<html>agent build</html>');
    expect(await (await fetch(base + '/api/health')).json()).toMatchObject({ uiBuild: 'agent' });
    await post('/api/app/factory', {});
    expect(await (await fetch(base + '/')).text()).toBe('<html>factory</html>');
    const r = await post('/api/app/revert', { sources, sha: v.sha });
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(path.join(sources, 'src/Toolbar.tsx'), 'utf8')).toBe('export const theme = true;\n');
    ctl.abort();
  });
});
