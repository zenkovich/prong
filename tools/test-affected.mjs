#!/usr/bin/env node
/**
 * Runs only the tests a change touches, instead of every suite (a full e2e run takes ~15 min one suite at a time).
 *
 *   node tools/test-affected.mjs                 files changed since the last run of this script (mtime)
 *   node tools/test-affected.mjs src/a.tsx ...   these files
 *   --base <ref>                                 files changed against a git ref (committed or not)
 *   --suites changes,history                     these e2e suites, whatever changed
 *   --only <regex>                               only the e2e checks whose names match (E2E_ONLY; not in "main")
 *   --no-e2e / --no-unit                         skip a kind
 *   --dry                                        say what would run
 *
 * Unit tests: `vitest related` for the app and for the engine (the tests that import a changed file). E2E: the suites
 * of the areas changed (table below). Shared code (src/ui, src/state, src/git, the engine) maps to no suite by
 * itself — pick the checks of the scenario with --suites/--only. The web export and the compiled engine the e2e
 * harness serves are rebuilt only when sources are newer than them. Exits 1 when anything failed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = path.join(ROOT, 'macos/build/.test-affected-stamp');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const explicit = args.filter((a, i) => !a.startsWith('--') && !['--base', '--suites', '--only'].includes(args[i - 1]));

/** area → e2e suite (the main run, tools/e2e.mjs, is "main": its checks depend on each other, so it runs whole) */
const AREAS = [
  [/src\/components\/(FileList|ChangesPanel|DiffView|fileTree|LfsDialog|lfsTree)|src\/components\/media\/|src\/git\/(lineStaging|diffContext|gitignore)/, 'changes'],
  [/src\/components\/(CommitList|CommitDetails|graphLayout|commitRefs|branchFilter)|src\/state\/(deepHistory|history)/, 'history'],
  [/src\/components\/(Sidebar|BranchBatchDialog|refSelection|refName|branchNames|pathTree)/, 'sidebar'],
  [/src\/components\/(Toolbar|StatusPanel|ErrorDialog)|src\/state\/(errorHints|longOps)/, 'toolbar'],
  [/src\/screens\/|^App\.tsx|src\/components\/(RepoPicker|dialogs|accountsDialogs|ConnectionDialog|tabLayout)|src\/state\/session|src\/ui\/droppedPath/, 'shell'],
  [/src\/components\/(Agent|versions|Markdown)|src\/agent\//, 'agent'],
  [/^tools\/e2e\/suites\/(\w+)\.mjs$/, '$1'],
  [/^tools\/e2e\.mjs$/, 'main'],
];
const SOURCE = /^(src\/|server\/src\/|server\/test\/|App\.tsx|tools\/e2e)/;

function changedFiles() {
  if (explicit.length) return explicit;
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const base = opt('--base');
  if (base) return [...new Set([...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')])];
  // since the last run: by modification time (the working tree holds much more uncommitted work than one change)
  const since = existsSync(STAMP) ? statSync(STAMP).mtimeMs : Date.now() - 30 * 60 * 1000;
  return [...git('ls-files'), ...git('ls-files', '--others', '--exclude-standard')].filter((f) => SOURCE.test(f) && existsSync(path.join(ROOT, f)) && statSync(path.join(ROOT, f)).mtimeMs > since);
}

const files = changedFiles().filter((f) => SOURCE.test(f));
const suites = new Set(opt('--suites')?.split(',').filter(Boolean) ?? []);
if (!opt('--suites'))
  for (const f of files)
    for (const [rx, s] of AREAS) {
      const m = f.match(rx);
      if (m) suites.add(s === '$1' ? m[1] : s);
    }
const app = files.filter((f) => /^(src\/|App\.tsx)/.test(f) && /\.(tsx?|mjs)$/.test(f));
const engine = files.filter((f) => /^server\/(src|test)\//.test(f)).map((f) => f.replace(/^server\//, ''));
const shared = files.filter((f) => /^(src\/(ui|state|git)\/|src\/theme|server\/src\/)/.test(f) && !/\.test\.ts$/.test(f));
const only = opt('--only');

console.log(`changed: ${files.length ? files.join(', ') : 'nothing'}`);
if (shared.length && !opt('--suites')) console.log(`shared code (no suite of its own; add --suites/--only for its scenario): ${shared.join(', ')}`);
console.log(`unit: app ${flag('--no-unit') || !app.length ? '—' : 'related'} · engine ${flag('--no-unit') || !engine.length ? '—' : 'related'}`);
console.log(`e2e: ${flag('--no-e2e') || !suites.size ? '—' : [...suites].join(', ')}${only ? ` (only /${only}/)` : ''}`);
if (flag('--dry')) process.exit(0);

let failed = [];
const run = (label, cmd, a, cwd = ROOT, env = process.env) => {
  const t0 = Date.now();
  const r = spawnSync(cmd, a, { cwd, env, stdio: 'inherit' });
  console.log(`— ${label}: ${r.status === 0 ? 'ok' : 'FAILED'} (${Math.round((Date.now() - t0) / 1000)} s)`);
  if (r.status !== 0) failed.push(label);
};

if (!flag('--no-unit')) {
  if (app.length) run('unit (app)', 'npx', ['vitest', 'related', '--run', ...app]);
  if (engine.length) run('unit (engine)', 'npx', ['vitest', 'related', '--run', ...engine], path.join(ROOT, 'server'));
}

if (!flag('--no-e2e') && suites.size) {
  // what the harness serves, rebuilt only when older than its sources
  const newest = (dir, rx) => {
    let t = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (rx.test(e.name)) t = Math.max(t, statSync(p).mtimeMs);
      }
    };
    walk(dir);
    return t;
  };
  const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  const web = path.join(ROOT, 'macos/build/web/index.html');
  if (Math.max(newest(path.join(ROOT, 'src'), /\.(tsx?|json)$/), mtime(path.join(ROOT, 'App.tsx'))) > mtime(web)) run('web export', 'npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'macos/build/web']);
  if (newest(path.join(ROOT, 'server/src'), /\.ts$/) > mtime(path.join(ROOT, 'server/dist/src/index.js'))) run('engine build', 'npx', ['tsc', '-p', 'tsconfig.json'], path.join(ROOT, 'server'));
  // the main run's checks build on each other (a branch made by one is used by the next): it runs whole
  const own = [...suites].filter((n) => n !== 'main');
  const env = { ...process.env, E2E_JOBS: process.env.E2E_JOBS ?? '2' };
  if (suites.has('main')) run('e2e (main, whole)', process.execPath, [path.join(ROOT, 'tools/e2e.mjs')], ROOT, env);
  if (own.length) run(`e2e (${own.join('|')})`, process.execPath, [path.join(ROOT, 'tools/e2e/run-all.mjs'), `^(${own.join('|')})$`], ROOT, { ...env, ...(only ? { E2E_ONLY: only } : {}) });
}

if (!failed.length) writeFileSync(STAMP, new Date().toISOString());
console.log(failed.length ? `failed: ${failed.join(', ')}` : 'all passed');
process.exit(failed.length ? 1 : 0);
