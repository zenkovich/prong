import React from 'react';
import { Platform, View } from 'react-native';
import type { FileChange } from '../../git/types';
import { FONT, useTheme } from '../../theme';
import { Icon } from '../../ui/Icon';
import { Spinner, Txt } from '../../ui/primitives';
import { AVCompare } from './AVCompare';
import { SideBanner, useMediaSides } from './common';
import { fmtBytes, sideState, signedBytes } from './mediaMath';
import { ImageCompare } from './ImageCompare';

/**
 * Preview of a non-text change: images, audio, video and other binaries. Everything about the two sides
 * (whether they exist, their size, where to fetch them) comes from the engine; nothing is assumed from the
 * diff, which for binaries carries no content at all.
 */
export function MediaPreview({ file, area, rev }: { file: FileChange; area: 'unstaged' | 'staged' | 'commit' | 'stash'; rev: string }) {
  const sides = useMediaSides(file, area, rev);
  const kind = file.kind === 'image' || file.kind === 'audio' || file.kind === 'video' ? file.kind : 'binary';
  if (Platform.OS !== 'web' && kind !== 'binary') return <BinaryInfo {...sides} />;
  if (kind === 'image') return <ImageCompare before={sides.before} after={sides.after} loading={sides.loading} error={sides.error} />;
  if (kind === 'audio' || kind === 'video') return <AVCompare kind={kind} before={sides.before} after={sides.after} loading={sides.loading} error={sides.error} />;
  return <BinaryInfo {...sides} />;
}

function BinaryInfo({ before, after, loading, error }: { before?: any; after?: any; loading: boolean; error?: string | null }) {
  const t = useTheme();
  if (loading)
    return (
      <View style={{ padding: 24, alignItems: 'center' }}>
        <Spinner />
      </View>
    );
  const st = sideState(before, after);
  return (
    <View style={{ flex: 1 }}>
      <SideBanner state={st} kind="binary" before={before} after={after} />
      <View style={{ alignItems: 'center', paddingTop: 40 }}>
        <Icon name="binary" size={34} color={t.textFaint} />
        <Txt weight="600" style={{ marginTop: 10 }}>
          {st === 'added' ? 'Binary file added' : st === 'deleted' ? 'Binary file deleted' : st === 'unchanged' ? 'Binary file, content unchanged' : 'Binary file changed'}
        </Txt>
        {error ? (
          <Txt size={FONT.sm} color={t.del} style={{ marginTop: 6 }}>
            {error}
          </Txt>
        ) : (
          <Txt size={FONT.sm} muted mono style={{ marginTop: 6 }}>
            {before && after ? `${fmtBytes(before.bytes)} → ${fmtBytes(after.bytes)} (${signedBytes(after.bytes - before.bytes)})` : before ? fmtBytes(before.bytes) : after ? fmtBytes(after.bytes) : ''}
          </Txt>
        )}
      </View>
    </View>
  );
}
