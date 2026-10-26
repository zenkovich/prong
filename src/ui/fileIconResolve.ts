import { ICONS, OPEN_FOLDERS } from './fileIconMap.generated';

/** Icon lookup for files and folders (pure: no React, testable). See FileIcon.tsx. */

const OPEN = new Set(OPEN_FOLDERS);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const canonFolder = (n: string) => n.toLowerCase().replace(/^[._-]+/, '').replace(/_+$/, '');

export type IconSource = { kind: 'theme'; icon: string } | { kind: 'system'; ext: string };

export function resolveFileIcon(pathOrName: string, light = false): IconSource {
  const name = base(pathOrName).toLowerCase();
  const byName = (light && ICONS.light.name[name]) || ICONS.name[name];
  if (byName) return { kind: 'theme', icon: byName };
  const parts = name.split('.');
  // "archive.tar.gz" tries "tar.gz", then "gz"; a leading dot (".env") counts as a name, handled above
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.');
    if (!ext) continue;
    const icon = (light && ICONS.light.ext[ext]) || ICONS.ext[ext];
    if (icon) return { kind: 'theme', icon };
  }
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  return last && /^[a-z0-9][a-z0-9_+-]{0,15}$/.test(last) ? { kind: 'system', ext: last } : { kind: 'theme', icon: ICONS.file };
}

export function resolveFolderIcon(name: string, open: boolean, light = false): string {
  const c = canonFolder(base(name));
  const icon = (light && ICONS.light.folder[c]) || ICONS.folderNames[c];
  if (!icon) return open ? ICONS.folderOpen : ICONS.folder;
  return open && OPEN.has(`${icon}-open`) ? `${icon}-open` : icon;
}

