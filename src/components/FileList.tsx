import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { FileChange, FileStatus } from '../git/types';
import { Area, discardFile, setFileView, showContextMenu, stageFile, toast, toggleGroup, unstageFile, useRepo } from '../state/store';
import * as live from '../state/live';
import { FONT, Theme, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Chevron, IconButton, Input, Row, Segmented, Txt } from '../ui/primitives';
import { rowTop, useVirtualWindow } from '../ui/virtual';
import { buildTree, flatten, TreeNode as Node } from './fileTree';
import { FileIcon, FolderIcon } from '../ui/FileIcon';

export function statusColor(s: FileStatus, t: Theme) {
  switch (s) {
    case 'A':
    case '?':
      return t.add;
    case 'D':
      return t.del;
    case 'R':
    case 'C':
      return t.info;
    case 'U':
      return t.warn;
    default:
      return t.warn;
  }
}


export function FileList({ files, area, selected, onSelect, showToggle = false, filterable = true, compact }: {
  files: FileChange[];
  area: Area;
  selected: string | null;
  onSelect: (path: string) => void;
  showToggle?: boolean;
  filterable?: boolean;
  compact?: boolean;
}) {
  const t = useTheme();
  const repo = useRepo();
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => (filter ? files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())) : files), [files, filter]);
  const tree = useMemo(() => (repo.fileView === 'tree' ? buildTree(filtered) : null), [filtered, repo.fileView]);
  // the tree as rows (open folders expanded), so only the rows on screen are rendered
  const rows = useMemo(() => (tree ? flatten(tree, area, repo.collapsedGroups) : null), [tree, area, repo.collapsedGroups]);
  const count = rows ? rows.length : filtered.length;
  const win = useVirtualWindow(count, 22, { overscan: 20 });
  return (
    <View style={{ flex: 1 }}>
      {(showToggle || filterable) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 5, borderBottomWidth: 1, borderColor: t.border }}>
          {filterable && <Input value={filter} onChange={setFilter} placeholder="Filter files" icon="search" small style={{ flex: 1 }} />}
          {showToggle && (
            <View style={{ marginLeft: 8 }}>
              <Segmented value={repo.fileView} onChange={setFileView} options={[{ value: 'list', icon: 'list' }, { value: 'tree', icon: 'tree' }]} />
            </View>
          )}
        </View>
      )}
      <ScrollView style={{ flex: 1 }} onScroll={win.onScroll} onLayout={win.onLayout} scrollEventThrottle={16}>
        <View style={{ height: count * 22 }}>
          {rows
            ? rows.slice(win.first, win.last).map((r, k) => (
                <View key={r.node.path + (r.node.file ? '' : '/')} style={rowTop(win.first + k, 22)}>
                  {r.node.file ? (
                    <FileRow file={r.node.file} area={area} selected={selected === r.node.file.path} onSelect={() => onSelect(r.node.file!.path)} indent={r.depth * 14} nameOnly />
                  ) : (
                    <FolderRow node={r.node} depth={r.depth} open={r.open} area={area} />
                  )}
                </View>
              ))
            : filtered.slice(win.first, win.last).map((f, k) => (
                <View key={f.path} style={rowTop(win.first + k, 22)}>
                  <FileRow file={f} area={area} selected={selected === f.path} onSelect={() => onSelect(f.path)} compact={compact} />
                </View>
              ))}
        </View>
        {filtered.length === 0 && (
          <Txt faint size={FONT.sm} style={{ padding: 12 }}>
            {files.length === 0 ? 'No files' : 'No matches'}
          </Txt>
        )}
      </ScrollView>
    </View>
  );
}

function FolderRow({ node, depth, open, area }: { node: Node; depth: number; open: boolean; area: Area }) {
  const t = useTheme();
  return (
    <Row height={22} indent={depth * 14} onPress={() => toggleGroup(`tree:${area}:${node.path}`)}>
      <Chevron open={open} color={t.textMuted} />
      <FolderIcon name={node.name} open={open} />
      <Txt size={FONT.sm} muted style={{ marginLeft: 5 }} numberOfLines={1}>
        {node.name}
      </Txt>
    </Row>
  );
}

export function FileRow({ file, area, selected, onSelect, indent = 0, nameOnly, compact }: { file: FileChange; area: Area; selected: boolean; onSelect: () => void; indent?: number; nameOnly?: boolean; compact?: boolean }) {
  const t = useTheme();
  const color = statusColor(file.status, t);
  const editable = area === 'unstaged' || area === 'staged';
  const isLive = live.isLiveActive();
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
  const name = file.path.slice(dir.length);
  const sub = file.kind === 'submodule' ? file.submodule ?? { before: '', after: '' } : null;
  const goToSubmodule = () => (isLive ? void live.openSubmoduleAt(file.path, sub?.after || undefined) : toast(`Opened ${file.path} (mock)`, 'info'));
  return (
    <Row
      height={22}
      indent={indent}
      selected={selected}
      selectMode="soft"
      onPress={onSelect}
      testID={`file-${area}-${file.path}`}
      onDoublePress={() => (area === 'unstaged' ? stageFile(file.path) : area === 'staged' ? unstageFile(file.path) : sub ? goToSubmodule() : undefined)}
      onContextMenu={(x, y) =>
        showContextMenu(x, y, [
          // a submodule change: straight to the commit it points at, in the submodule's own tab
          ...(sub ? [{ label: sub.after ? `Open submodule at ${sub.after.slice(0, 7)}` : 'Open submodule', onPress: goToSubmodule }, { separator: true }] : []),
          ...(area === 'unstaged' ? [{ label: 'Stage', onPress: () => stageFile(file.path) }, { label: 'Discard changes…', danger: true, onPress: () => discardFile(file.path) }, { label: 'Add to .gitignore', onPress: () => (isLive ? live.addToGitignore(file.path) : toast(`Added ${file.path} to .gitignore (mock)`, 'success')) }] : []),
          ...(area === 'staged' ? [{ label: 'Unstage', onPress: () => unstageFile(file.path) }] : []),
          { separator: true },
          { label: 'File history', onPress: () => (isLive ? void live.showFileHistory(file.path) : toast(`History of ${file.path} (mock)`, 'info')) },
          { label: 'Blame', disabled: file.status === 'D' || file.status === '?', onPress: () => (isLive ? void live.showBlame(file.path) : toast(`Blame ${file.path} (mock)`, 'info')) },
          { separator: true },
          { label: 'Open in editor', onPress: () => (isLive ? live.openInEditor(live.absPath(file.path)) : toast('Opened in editor (mock)', 'info')) },
          { label: 'Reveal in Finder', onPress: () => (isLive ? live.revealPath(live.absPath(file.path)) : toast('Revealed (mock)', 'info')) },
          { label: 'Copy path', onPress: () => live.copyText(file.path) },
        ])
      }
    >
      {({ hovered }) => (
        <>
          <Txt size={FONT.xs} mono weight="700" color={color} style={{ width: 14 }}>
            {file.status}
          </Txt>
          {file.kind === 'submodule' ? <Icon name="layers" size={13} color={t.info} /> : <FileIcon name={file.path} />}
          {nameOnly ? (
            <Txt size={FONT.sm} style={{ marginLeft: 6, flex: 1 }} numberOfLines={1}>
              {name}
            </Txt>
          ) : (
            <View style={{ flexDirection: 'row', flex: 1, marginLeft: 6, overflow: 'hidden', alignItems: 'center' }}>
              {!compact && dir ? (
                <Txt size={FONT.sm} muted numberOfLines={1} style={{ flexShrink: 1 }}>
                  {dir}
                </Txt>
              ) : null}
              <Txt size={FONT.sm} numberOfLines={1}>
                {name}
              </Txt>
              {compact && dir ? (
                <Txt size={FONT.xs} faint numberOfLines={1} style={{ marginLeft: 6, flexShrink: 1 }}>
                  {dir.replace(/\/$/, '')}
                </Txt>
              ) : null}
            </View>
          )}
          {sub ? (
            <IconButton icon="arrowRight" size={13} title={sub.after ? `Go to ${sub.after.slice(0, 7)} in the submodule` : 'Open the submodule'} onPress={goToSubmodule} testID={`open-submodule-${file.path}`} />
          ) : null}
          {/* a file listed without its diff has no counts yet: show none rather than "+0 −0" */}
          {file.kind === 'text' && !file.lazy && !hovered ? (
            <Txt size={FONT.xs} mono faint>
              <Txt size={FONT.xs} mono color={t.add}>
                +{file.additions}
              </Txt>{' '}
              <Txt size={FONT.xs} mono color={t.del}>
                −{file.deletions}
              </Txt>
            </Txt>
          ) : null}
          {hovered && editable && (
            <View style={{ flexDirection: 'row' }}>
              {area === 'unstaged' && <IconButton icon="undo" size={12} title="Discard" onPress={() => discardFile(file.path)} />}
              <IconButton icon={area === 'unstaged' ? 'plus' : 'minus'} size={13} title={area === 'unstaged' ? 'Stage' : 'Unstage'} onPress={() => (area === 'unstaged' ? stageFile(file.path) : unstageFile(file.path))} />
            </View>
          )}
        </>
      )}
    </Row>
  );
}
