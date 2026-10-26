import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * File-type icons from the operating system, for extensions the bundled icon set does not know.
 *
 * - macOS: NSWorkspace's icon for the file type, drawn into a 64×64 PNG by a JXA script (one osascript call
 *   renders a whole batch).
 * - Windows: the shell's associated icon for an empty temp file with that extension (System.Drawing).
 * - Linux: the freedesktop icon names for the file's MIME type (gio, else xdg-mime) looked up in the user's
 *   icon theme and the common fallbacks.
 *
 * Results are cached on disk under ~/.prong/cache/icons (`<platform>-<ext>.png|svg`, misses as `.none`, retried
 * after a week), and concurrent requests within a short window are rendered in one batch.
 */

export interface IconResult {
  data: Buffer;
  mime: string;
}

const SIZE = 64;
const NONE_TTL = 7 * 24 * 3600 * 1000;
const BATCH_MS = 25;

const stateDir = () => process.env.PRONG_STATE_DIR ?? path.join(homedir(), '.prong');
const cacheDir = () => path.join(stateDir(), 'cache', 'icons');

/** a file extension we are willing to pass to the OS (no dots, slashes or shell characters) */
export function normalizeExt(ext: string): string | null {
  const e = ext.trim().replace(/^\./, '').toLowerCase();
  return /^[a-z0-9][a-z0-9_+-]{0,15}$/.test(e) ? e : null;
}

const run = (cmd: string, args: string[], timeout = 8000) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout ?? '') }));
  });

// ---------- macOS ----------

export const MAC_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  var dir = argv[0], size = parseInt(argv[1], 10), done = [];
  for (var i = 2; i < argv.length; i++) {
    var ext = argv[i];
    var img = $.NSWorkspace.sharedWorkspace.iconForFileType(ext);
    var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
    img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationCopy, 1.0);
    $.NSGraphicsContext.restoreGraphicsState;
    var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    if (png.writeToFileAtomically(dir + '/darwin-' + ext + '.png', true)) done.push(ext);
  }
  return done.join(',');
}`;

async function renderMac(exts: string[], dir: string): Promise<Map<string, string>> {
  await run('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT, dir, String(SIZE), ...exts], 15000);
  return collect(exts, dir, 'darwin', ['png']);
}

// ---------- Windows ----------

export function windowsScript(exts: string[], dir: string) {
  const list = exts.map((e) => `'${e}'`).join(',');
  return [
    'Add-Type -AssemblyName System.Drawing',
    `foreach ($e in @(${list})) {`,
    `  $tmp = Join-Path $env:TEMP ("prong-icon." + $e)`,
    '  New-Item -Path $tmp -ItemType File -Force | Out-Null',
    '  try {',
    '    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($tmp)',
    `    if ($icon) { $icon.ToBitmap().Save((Join-Path '${dir.replace(/'/g, "''")}' ("win32-" + $e + ".png")), [System.Drawing.Imaging.ImageFormat]::Png) }`,
    '  } catch {}',
    '  Remove-Item $tmp -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('\n');
}

async function renderWindows(exts: string[], dir: string): Promise<Map<string, string>> {
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsScript(exts, dir)], 20000);
  return collect(exts, dir, 'win32', ['png']);
}

// ---------- Linux (freedesktop) ----------

/** icon names gio reports, e.g. `standard::icon: text-x-python, text-x-generic, text-x-python-symbolic` */
export function parseGioIcons(out: string): string[] {
  const line = out.split('\n').find((l) => l.includes('standard::icon:'));
  if (!line) return [];
  return line
    .split('standard::icon:')[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('-symbolic'));
}

/** freedesktop names for a MIME type: `text/x-python` → text-x-python, then the generic `text-x-generic` */
export function namesForMime(mime: string): string[] {
  const m = mime.trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m)) return [];
  const [major] = m.split('/');
  return [m.replace('/', '-'), `${major}-x-generic`];
}

export interface FsLike {
  exists: (p: string) => boolean;
  list: (p: string) => string[];
  isDir: (p: string) => boolean;
}
const realFs: FsLike = {
  exists: existsSync,
  list: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

/** preference for a theme sub-directory holding MIME icons: scalable first, then larger raster sizes */
export function mimeDirRank(rel: string): number {
  if (!/mime/i.test(rel) || /symbolic/i.test(rel)) return -1;
  if (/scalable/i.test(rel)) return 1000;
  const n = rel.match(/(\d+)/);
  const size = n ? parseInt(n[1], 10) : 48;
  if (size < 32) return -1;
  return size === 64 ? 900 : size === 48 ? 800 : size === 32 ? 700 : 600 - Math.abs(size - 64);
}

/**
 * First matching icon file for `names` in `themes` under the usual icon roots. Theme folders are laid out either
 * `<size>/mimetypes` (Adwaita, Papirus) or `mimetypes/<size>` (Breeze); both are found by listing two levels.
 */
export function findThemeIcon(names: string[], themes: string[], roots: string[], fs: FsLike = realFs): string | null {
  for (const theme of themes) {
    for (const root of roots) {
      const tdir = path.join(root, theme);
      if (!fs.isDir(tdir)) continue;
      const dirs: { dir: string; rank: number }[] = [];
      for (const a of fs.list(tdir)) {
        const pa = path.join(tdir, a);
        if (!fs.isDir(pa)) continue;
        const ra = mimeDirRank(a);
        if (ra >= 0) dirs.push({ dir: pa, rank: ra });
        for (const b of fs.list(pa)) {
          const pb = path.join(pa, b);
          const rb = mimeDirRank(`${a}/${b}`);
          if (rb >= 0 && fs.isDir(pb)) dirs.push({ dir: pb, rank: rb });
        }
      }
      dirs.sort((x, y) => y.rank - x.rank);
      for (const name of names) {
        for (const { dir } of dirs) {
          for (const ext of ['.svg', '.png']) {
            const f = path.join(dir, name + ext);
            if (fs.exists(f)) return f;
          }
        }
      }
    }
  }
  return null;
}

async function linuxThemes(): Promise<string[]> {
  const out: string[] = [];
  const g = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'icon-theme'], 3000);
  if (g.code === 0) out.push(g.stdout.trim().replace(/^'|'$/g, ''));
  try {
    const kde = readFileSync(path.join(homedir(), '.config', 'kdeglobals'), 'utf8').match(/^\[Icons\][^[]*?^Theme=(.+)$/m);
    if (kde) out.push(kde[1].trim());
  } catch {
    /* not KDE */
  }
  return [...new Set([...out.filter(Boolean), 'Adwaita', 'breeze', 'Papirus', 'Yaru', 'elementary', 'Humanity', 'hicolor'])];
}

async function renderLinux(exts: string[], dir: string): Promise<Map<string, string>> {
  const themes = await linuxThemes();
  const roots = [path.join(homedir(), '.local/share/icons'), path.join(homedir(), '.icons'), '/usr/share/icons', '/usr/local/share/icons'];
  const out = new Map<string, string>();
  const tmp = path.join(tmpdir(), `prong-icons-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  for (const ext of exts) {
    const probe = path.join(tmp, `probe.${ext}`);
    writeFileSync(probe, '');
    let names = parseGioIcons((await run('gio', ['info', '--attributes=standard::icon', probe], 3000)).stdout);
    if (!names.length) names = namesForMime((await run('xdg-mime', ['query', 'filetype', probe], 3000)).stdout);
    rmSync(probe, { force: true });
    const found = findThemeIcon([...names, 'text-x-generic', 'application-x-generic', 'unknown'], themes, roots);
    if (!found) continue;
    const isSvg = found.endsWith('.svg');
    const target = path.join(dir, `linux-${ext}.${isSvg ? 'svg' : 'png'}`);
    writeFileSync(target, readFileSync(found));
    out.set(ext, target);
  }
  rmSync(tmp, { recursive: true, force: true });
  return out;
}

// ---------- cache + batching ----------

function collect(exts: string[], dir: string, platform: string, kinds: string[]) {
  const out = new Map<string, string>();
  for (const ext of exts)
    for (const k of kinds) {
      const f = path.join(dir, `${platform}-${ext}.${k}`);
      if (existsSync(f)) out.set(ext, f);
    }
  return out;
}

function fromCache(platform: string, ext: string): IconResult | null | undefined {
  const dir = cacheDir();
  for (const [k, mime] of [
    ['png', 'image/png'],
    ['svg', 'image/svg+xml'],
  ] as const) {
    const f = path.join(dir, `${platform}-${ext}.${k}`);
    if (existsSync(f)) return { data: readFileSync(f), mime };
  }
  const miss = path.join(dir, `${platform}-${ext}.none`);
  try {
    if (existsSync(miss) && Date.now() - statSync(miss).mtimeMs < NONE_TTL) return null;
  } catch {
    /* ignore */
  }
  return undefined;
}

export type Renderer = (exts: string[], dir: string) => Promise<Map<string, string>>;
const RENDERERS: Record<string, Renderer> = { darwin: renderMac, win32: renderWindows, linux: renderLinux };

const pending = new Map<string, ((r: IconResult | null) => void)[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush(platform: string, render: Renderer) {
  timer = null;
  const batch = [...pending.entries()];
  pending.clear();
  const exts = batch.map(([e]) => e);
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  let made = new Map<string, string>();
  try {
    made = await render(exts, dir);
  } catch {
    /* no icons this time */
  }
  for (const [ext, waiters] of batch) {
    const file = made.get(ext);
    let result: IconResult | null = null;
    if (file) result = { data: readFileSync(file), mime: file.endsWith('.svg') ? 'image/svg+xml' : 'image/png' };
    else writeFileSync(path.join(dir, `${platform}-${ext}.none`), '');
    for (const w of waiters) w(result);
  }
}

/** The OS icon for files with this extension, or null when the platform has none to offer. */
export function systemFileIcon(rawExt: string, platform: string = process.platform, render: Renderer | undefined = RENDERERS[platform]): Promise<IconResult | null> {
  const ext = normalizeExt(rawExt);
  if (!ext || !render) return Promise.resolve(null);
  const cached = fromCache(platform, ext);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const list = pending.get(ext);
    if (list) list.push(resolve);
    else pending.set(ext, [resolve]);
    if (!timer) timer = setTimeout(() => void flush(platform, render), BATCH_MS);
  });
}
