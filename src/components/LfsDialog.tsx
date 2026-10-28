import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { LfsFiles } from '../git/GitClient';
import * as live from '../state/live';
import { closeDialog } from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/overlays';
import { Button, Checkbox, PressScale, Spinner, Txt } from '../ui/primitives';
import { fmtBytes } from './media/mediaMath';
import { filesOf, lfsTree, pickedCounts, pickOf, type LfsFolder, type LfsMissing } from './lfsTree';

/** a folder lists its own files one by one when expanded, up to this many (more: one row for them all) */
const FILES_LISTED = 500;

type Row = { kind: 'folder'; folder: LfsFolder; depth: number } | { kind: 'file'; file: LfsMissing; depth: number } | { kind: 'own'; folder: LfsFolder; depth: number };

const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Restoring Git LFS files the working copy holds as pointers: cloned without LFS, or left out of downloads by
 * .lfsconfig (township keeps 10 000 sounds out that way). Folders to pick with counts and sizes; `git lfs pull` of the
 * pick runs as a long operation. `focus`: a file to start with (a preview's "Restore…"), alone picked.
 */
export function LfsDialog({ focus }: { focus?: string }) {
  const t = useTheme();
  const [data, setData] = useState<LfsFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    live.lfsFiles().then(
      (d) => {
        if (!alive) return;
        setData(d);
        const one = focus && d.missing.find((m) => m.path === focus);
        setPicked(new Set(one ? [one.path] : d.missing.map((m) => m.path)));
        // the focused file's folders open, so it is in sight
        if (one) setOpen(new Set(one.path.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
      },
      (e) => alive && setError(String(e?.message ?? e)),
    );
    return () => {
      alive = false;
    };
  }, [focus]);
  const root = useMemo(() => (data ? lfsTree(data.missing) : null), [data]);
  const counts = useMemo(() => (root ? pickedCounts(root, picked) : new Map<string, number>()), [root, picked]);
  const result = useMemo(() => (root ? pickOf(root, picked) : null), [root, picked]);

  const setFiles = (files: LfsMissing[], on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const f of files) {
        if (on) next.add(f.path);
        else next.delete(f.path);
      }
      return next;
    });
  const toggleOpen = (path: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  // kept by full path: a squashed folder ("android/app/src/main/res/raw") is its deepest one, and the focused file's
  // folders are opened as every prefix of its path, so they include it
  const opened = (f: LfsFolder) => open.has(f.path);
  const expandable = (f: LfsFolder) => f.folders.length > 0 || (f.own.length > 1 && f.own.length <= FILES_LISTED);

  const rows: Row[] = [];
  if (root) {
    const ownRows = (f: LfsFolder, depth: number) => {
      if (f.own.length <= FILES_LISTED) for (const file of f.own) rows.push({ kind: 'file', file, depth });
      else rows.push({ kind: 'own', folder: f, depth });
    };
    const walk = (f: LfsFolder, depth: number) => {
      rows.push({ kind: 'folder', folder: f, depth });
      if (!expandable(f) || !opened(f)) return;
      for (const c of f.folders) walk(c, depth + 1);
      if (f.folders.length || f.own.length > 1) ownRows(f, depth + 1);
    };
    for (const c of root.folders) walk(c, 0);
    if (root.own.length) ownRows(root, 0);
  }

  const missing = data?.missing.length ?? 0;
  const here = data ? data.missing.filter((m) => m.downloaded).length : 0;
  const count = result?.count ?? 0;
  const restoreLabel = !count ? 'Restore' : `Restore ${plural(count, 'file')}${result!.toDownload ? ` · ${fmtBytes(result!.toDownload)} to download` : ''}`;
  return (
    <Modal
      title="Restore Git LFS files"
      width={620}
      icon={<Icon name="cloud" size={15} color={t.accent} />}
      testID="lfs-dialog"
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          {missing > 0 && (
            <Button
              label={restoreLabel}
              primary
              style={{ marginLeft: 8 }}
              disabled={!count}
              onPress={() => {
                closeDialog();
                void live.restoreLfs(result!.pick, count);
              }}
              testID="lfs-restore"
            />
          )}
        </>
      }
    >
      {!data && !error && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 18 }} testID="lfs-loading">
          <Spinner />
          <Txt muted style={{ marginLeft: 10 }}>
            Reading the Git LFS files… a big repository takes a few seconds.
          </Txt>
        </View>
      )}
      {error && (
        <Txt color={t.del} testID="lfs-error">
          {error}
        </Txt>
      )}
      {data && !data.installed && (
        <Txt testID="lfs-not-installed">Git LFS is not installed. Install it (brew install git-lfs), then open this again.</Txt>
      )}
      {data?.installed && data.total === 0 && <Txt testID="lfs-none">This repository has no Git LFS files.</Txt>}
      {data?.installed && data.total > 0 && missing === 0 && (
        <Txt testID="lfs-all-here">
          All {plural(data.total, 'Git LFS file')} are in the working copy.
        </Txt>
      )}
      {data && root && missing > 0 && (
        <View>
          <Txt testID="lfs-summary">
            {plural(missing, 'file')} of {data.total.toLocaleString('en-US')} in Git LFS are pointers in the working copy, not the files.
          </Txt>
          <Txt size={FONT.sm} muted style={{ marginTop: 3 }}>
            {root.toDownload ? `${fmtBytes(root.toDownload)} to download` : 'Nothing to download'}
            {here ? ` · ${plural(here, 'file')} already on this machine, only to put in place` : ''}
          </Txt>
          {data.excluded.length > 0 && (
            <View style={{ flexDirection: 'row', marginTop: 10, padding: 8, borderWidth: 1, borderColor: t.border, backgroundColor: t.bg }} testID="lfs-excluded">
              <Icon name="info" size={13} color={t.info} />
              <Txt size={FONT.sm} muted style={{ marginLeft: 8, flex: 1 }}>
                This repository leaves {data.excluded.join(', ')} out of downloads (lfs.fetchexclude), so a pull does not bring them. Restoring here downloads the ones you pick anyway.
              </Txt>
            </View>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingVertical: 2 }}>
            <Checkbox checked={counts.get('') === root.count} mixed={(counts.get('') ?? 0) > 0} onChange={(v) => setFiles(filesOf(root), v)} label="All" testID="lfs-all" />
            <View style={{ flex: 1 }} />
            <Txt size={FONT.sm} faint mono>
              {plural(root.count, 'file')} · {fmtBytes(root.bytes)}
            </Txt>
          </View>
          <ScrollView style={{ maxHeight: 300, borderWidth: 1, borderColor: t.border, backgroundColor: t.bg }} contentContainerStyle={{ paddingVertical: 3 }} testID="lfs-tree">
            {rows.map((r) => {
              const pad = 6 + r.depth * 16;
              if (r.kind === 'file')
                return (
                  <View key={`f:${r.file.path}`} style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: pad + 18, paddingRight: 8, minHeight: 24 }}>
                    <Checkbox checked={picked.has(r.file.path)} onChange={(v) => setFiles([r.file], v)} testID={`lfs-file-${r.file.path}`} />
                    <Txt size={FONT.sm} mono numberOfLines={1} style={{ flex: 1, marginLeft: 6 }}>
                      {nameOf(r.file.path)}
                    </Txt>
                    <Txt size={FONT.xs} faint mono>
                      {fmtBytes(r.file.size)}
                      {r.file.downloaded ? ' · here' : ''}
                    </Txt>
                  </View>
                );
              const f = r.folder;
              if (r.kind === 'own') {
                const n = f.own.filter((m) => picked.has(m.path)).length;
                return (
                  <View key={`o:${f.path}`} style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: pad + 18, paddingRight: 8, minHeight: 24 }}>
                    <Checkbox checked={n === f.own.length} mixed={n > 0} onChange={(v) => setFiles(f.own, v)} testID={`lfs-own-${f.path}`} />
                    <Txt size={FONT.sm} muted numberOfLines={1} style={{ flex: 1, marginLeft: 6 }}>
                      {plural(f.own.length, 'file')} {f.path ? 'right in this folder' : 'at the top of the repository'}
                    </Txt>
                    <Txt size={FONT.xs} faint mono>
                      {fmtBytes(f.own.reduce((s, m) => s + m.size, 0))}
                    </Txt>
                  </View>
                );
              }
              const n = counts.get(f.path) ?? 0;
              const canOpen = expandable(f);
              const isOpen = canOpen && opened(f);
              return (
                <View key={`d:${f.path}`} style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: pad, paddingRight: 8, minHeight: 24 }}>
                  <PressScale onPress={() => canOpen && toggleOpen(f.path)} disabled={!canOpen} scaleTo={0.9} style={{ width: 16, height: 18, alignItems: 'center', justifyContent: 'center', marginRight: 2 }} label={isOpen ? 'Collapse' : 'Expand'} testID={`lfs-open-${f.path}`}>
                    {canOpen ? <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={11} color={t.textMuted} /> : null}
                  </PressScale>
                  <Checkbox checked={n === f.count} mixed={n > 0} onChange={(v) => setFiles(filesOf(f), v)} testID={`lfs-folder-${f.path}`} />
                  <Icon name="folder" size={12} color={t.textMuted} />
                  <Txt size={FONT.sm} mono numberOfLines={1} style={{ flex: 1, marginLeft: 6 }}>
                    {f.name}
                  </Txt>
                  <Txt size={FONT.xs} faint mono>
                    {plural(f.count, 'file')} · {fmtBytes(f.bytes)}
                  </Txt>
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}
    </Modal>
  );
}
