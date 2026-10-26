import React, { useState } from 'react';
import { Image, View } from 'react-native';
import { useStore } from '../state/store';
import { isDark, useTheme } from '../theme';
import { ICONS } from './fileIconMap.generated';
import { resolveFileIcon, resolveFolderIcon } from './fileIconResolve';
export { canonFolder, resolveFileIcon, resolveFolderIcon } from './fileIconResolve';
export type { IconSource } from './fileIconResolve';

/**
 * File and folder icons: Material Icon Theme for the ~1400 extensions and ~2100 file names it knows, the
 * operating system's icon (served by the engine) for everything else, a plain document icon as the last resort.
 *
 * Lookup follows VS Code: exact file name, then the longest compound extension (`d.ts` before `ts`), light-theme
 * overrides first when the scheme is light.
 */

/** URL of a bundled icon: static files next to the web build (served by Expo in dev, by the engine in the app) */
export const themeIconUrl = (icon: string) => `/file-icons/${icon}.svg`;

let systemBase = '';
/** engine base URL for OS icons; set once from App (the engine is not imported here) */
export function setSystemIconBase(url: string) {
  systemBase = url;
}
const systemFailed = new Set<string>();

export function FileIcon({ name, size = 14 }: { name: string; size?: number }) {
  const t = useTheme();
  const online = useStore((s) => s.engine.online);
  const light = !isDark(t.name);
  const src = resolveFileIcon(name, light);
  const [failed, setFailed] = useState(false);
  let uri: string;
  if (src.kind === 'system' && online && systemBase && !systemFailed.has(src.ext) && !failed) uri = `${systemBase}/api/fileicon?ext=${encodeURIComponent(src.ext)}`;
  else uri = themeIconUrl(src.kind === 'theme' ? src.icon : ICONS.file);
  return (
    <View style={{ width: size, height: size }} testID={`file-icon-${src.kind === 'theme' ? src.icon : 'system-' + src.ext}`}>
      <Image
        source={{ uri }}
        style={{ width: size, height: size }}
        resizeMode="contain"
        onError={() => {
          if (src.kind === 'system') systemFailed.add(src.ext);
          setFailed(true);
        }}
      />
    </View>
  );
}

export function FolderIcon({ name, open, size = 14 }: { name: string; open: boolean; size?: number }) {
  const t = useTheme();
  const icon = resolveFolderIcon(name, open, !isDark(t.name));
  return <Image source={{ uri: themeIconUrl(icon) }} style={{ width: size, height: size }} resizeMode="contain" testID={`folder-icon-${icon}`} />;
}
