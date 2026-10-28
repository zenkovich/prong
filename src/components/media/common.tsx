import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { FileChange } from '../../git/types';
import * as live from '../../state/live';
import type { MediaSide } from '../../state/live';
import { FONT, useTheme } from '../../theme';
import { openDialog } from '../../state/store';
import { Icon } from '../../ui/Icon';
import { Badge, Button, Txt } from '../../ui/primitives';
import { fmtBytes, signedBytes, SideState } from './mediaMath';
export { fmtBytes, sideState, signedBytes } from './mediaMath';
export type { SideState } from './mediaMath';

/** Loads where both sides of a change live; re-runs when the selection changes. */
export function useMediaSides(file: FileChange, area: 'unstaged' | 'staged' | 'commit' | 'stash', rev: string) {
  const [state, setState] = useState<{ key: string; loading: boolean; error: string | null; before?: MediaSide; after?: MediaSide }>({ key: '', loading: true, error: null });
  // read again on demand (a Git LFS object just downloaded): the same selection, quietly
  const [nonce, setNonce] = useState(0);
  const key = `${area}|${rev}|${file.path}|${file.oldPath ?? ''}|${file.status}`;
  // a new selection shows "loading" until its answer arrives (derived from the key, no reset in the effect);
  // a refreshed file object for the same selection refetches quietly (a working-copy edit gets a new URL)
  useEffect(() => {
    let alive = true;
    live
      .mediaSides(area, rev, file)
      .then((s) => alive && setState({ key, loading: false, error: null, ...s }))
      .catch((e) => alive && setState({ key, loading: false, error: String(e?.message ?? e) }));
    return () => {
      alive = false;
    };
  }, [key, area, rev, file, nonce]);
  const reload = () => setNonce((n) => n + 1);
  return state.key === key ? { ...state, reload } : { key, loading: true, error: null as string | null, before: undefined, after: undefined, reload };
}

/**
 * A change whose Git LFS object is not on this machine (a commit of the history, a file .lfsconfig leaves out of
 * downloads): what it is and how big, and a button that downloads it for the preview. The working copy stays as it is.
 */
export function LfsNotHere({ before, after, onDownloaded }: { before?: MediaSide; after?: MediaSide; onDownloaded: () => void }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const missing = [before, after].filter((s): s is MediaSide => !!s?.lfs && !s.lfs.local);
  const bytes = missing.reduce((n, s) => n + s.bytes, 0);
  const pointer = [after, before].find((s) => s?.lfs?.pointerFile);
  const sizes = [before && `before ${fmtBytes(before.bytes)}${before.lfs && !before.lfs.local ? ' (not here)' : ''}`, after && `after ${fmtBytes(after.bytes)}${after.lfs && !after.lfs.local ? ' (not here)' : ''}`].filter(Boolean).join('   →   ');
  return (
    <View style={{ flex: 1 }} testID="lfs-not-here">
      <View style={{ alignItems: 'center', paddingTop: 40, paddingHorizontal: 24 }}>
        <Icon name="cloud" size={34} color={t.textFaint} />
        <Txt weight="600" style={{ marginTop: 10 }}>
          In Git LFS, not downloaded
        </Txt>
        <Txt size={FONT.sm} muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 460 }}>
          git keeps a pointer to this file; its content is on the LFS server. Download it to see it here (the working copy is not changed).
        </Txt>
        <Txt size={FONT.sm} faint mono style={{ marginTop: 6 }}>
          {sizes}
        </Txt>
        <View style={{ flexDirection: 'row', marginTop: 14, gap: 8 } as any}>
          <Button
            label={busy ? 'Downloading…' : `Download ${fmtBytes(bytes)}`}
            icon="pull"
            primary
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void live.downloadLfs(missing).then((ok) => {
                setBusy(false);
                if (ok) onDownloaded();
              });
            }}
            testID="lfs-download"
          />
          {pointer ? <Button label="Restore in the working copy…" icon="cloud" onPress={() => openDialog({ type: 'lfs', focus: pointer.file })} testID="lfs-restore-file" /> : null}
        </View>
      </View>
    </View>
  );
}

const COPY: Record<SideState, { badge: string; text: string }> = {
  added: { badge: 'new file', text: 'no previous version' },
  deleted: { badge: 'deleted', text: 'removed in this change · showing the last version' },
  unchanged: { badge: 'same content', text: 'both versions are byte-identical' },
  modified: { badge: 'modified', text: '' },
  missing: { badge: 'no content', text: 'the file exists on neither side' },
};

/** One line above every media preview: what happened to the file, both sizes, and open/reveal actions. */
export function SideBanner({ state, kind, before, after, beforeInfo, afterInfo }: { state: SideState; kind: 'image' | 'audio' | 'video' | 'binary'; before?: MediaSide; after?: MediaSide; beforeInfo?: string; afterInfo?: string }) {
  const t = useTheme();
  const color = state === 'added' ? t.add : state === 'deleted' ? t.del : state === 'modified' ? t.warn : t.textMuted;
  const c = COPY[state];
  const part = (label: string, side?: MediaSide, info?: string) => (side ? `${label} ${[info, fmtBytes(side.bytes)].filter(Boolean).join(' · ')}` : null);
  const sizes =
    state === 'modified'
      ? [part('before', before, beforeInfo), part('after', after, afterInfo), before && after ? signedBytes(after.bytes - before.bytes) : null].filter(Boolean).join('   →   ')
      : part(state === 'deleted' ? 'last version' : '', after ?? before, after ? afterInfo : beforeInfo)?.trim();
  const worktree = [after, before].find((s) => s?.rev === 'WORKTREE');
  return (
    <View testID="media-banner" style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: t.border, flexWrap: 'wrap', gap: 8 } as any}>
      <Badge bg={color + '22'} color={color}>
        {c.badge}
      </Badge>
      {before?.lfs || after?.lfs ? (
        <Badge bg={t.info + '22'} color={t.info} testID="media-lfs">
          git lfs
        </Badge>
      ) : null}
      {c.text ? (
        <Txt size={FONT.sm} muted>
          {c.text}
        </Txt>
      ) : null}
      {sizes ? (
        <Txt size={FONT.xs} faint mono numberOfLines={1} style={{ flexShrink: 1 }}>
          {sizes}
        </Txt>
      ) : null}
      <View style={{ flex: 1 }} />
      {before && kind !== 'image' ? <Button small label="Open before" icon="external" onPress={() => void live.openBlob(before)} /> : null}
      {after ? <Button small label={kind === 'image' ? 'Open' : 'Open after'} icon="external" onPress={() => void live.openBlob(after)} /> : null}
      {!after && before && kind === 'image' ? <Button small label="Open" icon="external" onPress={() => void live.openBlob(before)} /> : null}
      {worktree?.lfs?.pointerFile ? <Button small label="Restore file…" icon="cloud" onPress={() => openDialog({ type: 'lfs', focus: worktree.file })} testID="media-lfs-restore" /> : null}
      {worktree && !worktree.lfs?.pointerFile ? <Button small label="Reveal" icon="folder" onPress={() => void live.revealBlob(worktree)} /> : null}
    </View>
  );
}
