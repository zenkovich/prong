import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { FileChange, FileStatus } from '../git/types';
import { Area, clearFileSelection, discardFile, discardFiles, getState, setFileView, showContextMenu, stageFile, stageFiles, toast, toggleGroup, unstageFile, unstageFiles, useRepo } from '../state/store';
import * as live from '../state/live';
import { FONT, Theme, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Button, Chevron, HoverReveal, IconButton, Input, Row, Segmented, Txt, webCursor } from '../ui/primitives';
import { rowTop, useVirtualWindow } from '../ui/virtual';
import { buildTree, flatten, rowKey, TreeNode as Node } from './fileTree';
import { FileIcon, FolderIcon } from '../ui/FileIcon';
import { ignorePattern } from '../git/gitignore';

/** the menu of several picked Changes files; `untracked`: those of them git does not track (only they can be ignored) */
function groupMenu(area: Area, paths: string[], untracked: string[] = []) {
  const n = paths.length;
  const u = untracked.length;
  return [
    ...(area === 'unstaged'
      ? [
          { label: `Stage ${n} files`, onPress: () => stageFiles(paths) },
          { label: `Discard ${n} files…`, danger: true, onPress: () => discardFiles(paths) },
          // ignoring a tracked file changes nothing: only the new ones are offered
          ...(u ? [{ label: u === n ? `Add ${n} files to .gitignore` : `Add the ${u} new file${u === 1 ? '' : 's'} to .gitignore`, onPress: () => (live.isLiveActive() ? live.ignoreFiles(untracked.map(ignorePattern)) : toast('Added to .gitignore (mock)', 'success')) }] : []),
        ]
      : [{ label: `Unstage ${n} files`, onPress: () => unstageFiles(paths) }]),
    { separator: true },
    { label: `Copy ${n} paths`, onPress: () => live.copyText(paths.join('\n')) },
    { label: 'Clear the selection', shortcut: 'Esc', onPress: clearFileSelection },
  ];
}

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


export function FileList({ files, area, selected, onSelect, showToggle = false, filterable = true, compact, picked = NONE, onPick, onPickFolder }: {
  files: FileChange[];
  area: Area;
  selected: string | null;
  onSelect: (path: string) => void;
  showToggle?: boolean;
  filterable?: boolean;
  compact?: boolean;
  /** files picked together (two or more; Changes) */
  picked?: string[];
  /** ⌘ / Shift on a file: with the order the list shows (Shift runs) */
  onPick?: (path: string, mods: { meta: boolean; shift: boolean }, order: string[]) => void;
  /** a click on a folder (Changes): `inside` is its files in the order shown; absent, a click opens or closes it */
  onPickFolder?: (inside: string[], mods: { meta: boolean; shift: boolean }, order: string[]) => void;
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
  // the files under each folder and all of them in the order shown; a closed folder's files are in that order too:
  // a Shift run over a closed folder takes it whole, as in Finder
  const { under, all } = useMemo(() => {
    const m = new Map<string, string[]>();
    const walk = (n: Node): string[] => {
      if (n.file) return [n.file.path];
      const inside = n.children.flatMap(walk);
      m.set(n.path, inside);
      return inside;
    };
    return { under: m, all: tree ? tree.flatMap(walk) : filtered.map((f) => f.path) };
  }, [tree, filtered]);
  const order = all;
  const multi = picked.length > 1;
  const pickedSet = useMemo(() => new Set(multi ? picked : []), [picked, multi]);
  // the folders all of whose files are picked: drawn selected, their menu and buttons act on the whole pick
  const pickedFolders = useMemo(() => {
    const s = new Set<string>();
    if (pickedSet.size) for (const [f, inside] of under) if (inside.length && inside.every((p) => pickedSet.has(p))) s.add(f);
    return s;
  }, [under, pickedSet]);
  // the files git does not track: only they can be added to .gitignore
  const untracked = useMemo(() => new Set(files.filter((f) => f.status === '?').map((f) => f.path)), [files]);
  const untrackedOf = (paths?: string[]) => (paths ? paths.filter((p) => untracked.has(p)) : undefined);
  const pick = onPick ? (path: string, m: { meta: boolean; shift: boolean }) => onPick(path, m, order) : undefined;
  const pickFolder = onPickFolder ? (folder: string, m: { meta: boolean; shift: boolean }) => onPickFolder(under.get(folder) ?? [], m, order) : undefined;
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
                <View key={rowKey(r)} style={rowTop(win.first + k, 22)}>
                  {r.node.file ? (
                    <FileRow file={r.node.file} area={area} selected={selected === r.node.file.path || pickedSet.has(r.node.file.path)} onSelect={() => onSelect(r.node.file!.path)} indent={r.depth * 14} nameOnly onPick={pick} group={pickedSet.has(r.node.file.path) ? picked : undefined} groupUntracked={pickedSet.has(r.node.file.path) ? untrackedOf(picked) : undefined} />
                  ) : (
                    <FolderRow
                      node={r.node}
                      depth={r.depth}
                      open={r.open}
                      area={area}
                      inside={under.get(r.node.path) ?? NONE}
                      picked={pickedFolders.has(r.node.path)}
                      // picked with files beyond it: its menu and buttons act on the whole pick
                      group={pickedFolders.has(r.node.path) && picked.length > (under.get(r.node.path)?.length ?? 0) ? picked : undefined}
                      untracked={untracked}
                      onPick={pickFolder}
                    />
                  )}
                </View>
              ))
            : filtered.slice(win.first, win.last).map((f, k) => (
                <View key={f.path} style={rowTop(win.first + k, 22)}>
                  <FileRow file={f} area={area} selected={selected === f.path || pickedSet.has(f.path)} onSelect={() => onSelect(f.path)} compact={compact} onPick={pick} group={pickedSet.has(f.path) ? picked : undefined} groupUntracked={pickedSet.has(f.path) ? untrackedOf(picked) : undefined} />
                </View>
              ))}
        </View>
        {filtered.length === 0 && (
          <Txt faint size={FONT.sm} style={{ padding: 12 }}>
            {files.length === 0 ? 'No files' : 'No matches'}
          </Txt>
        )}
      </ScrollView>
      {multi && (area === 'unstaged' || area === 'staged') && <PickedBar area={area} paths={picked} />}
    </View>
  );
}

const NONE: string[] = [];

/** what can be done with the picked files of a Changes list, at its bottom (as the branches' batch bar) */
function PickedBar({ area, paths }: { area: 'unstaged' | 'staged'; paths: string[] }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderTopWidth: 1, borderColor: t.border, backgroundColor: t.accentSoft, gap: 6 } as any} testID={`picked-bar-${area}`}>
      <Txt size={FONT.xs} color={t.accent} weight="600" style={{ flex: 1 }} numberOfLines={1}>
        {paths.length} selected
      </Txt>
      {area === 'unstaged' ? (
        <>
          <Button small label={`Stage ${paths.length}`} primary onPress={() => stageFiles(paths)} testID="picked-stage" />
          <Button small label="Discard…" danger onPress={() => discardFiles(paths)} testID="picked-discard" />
        </>
      ) : (
        <Button small label={`Unstage ${paths.length}`} primary onPress={() => unstageFiles(paths)} testID="picked-unstage" />
      )}
      <IconButton icon="copy" size={12} title="Copy the paths" onPress={() => live.copyText(paths.join('\n'))} />
      <IconButton icon="x" size={12} title="Clear the selection (Esc)" onPress={clearFileSelection} testID="picked-clear" />
    </View>
  );
}

/** "all 12 files inside", "the file inside" */
const insideLabel = (n: number) => (n === 1 ? 'the file inside' : `all ${n} files inside`);
/** a submodule's changes in its own files, on its row: "2 changed · 1 new" */
export const insideText = (c: { modified: number; untracked: number }) => [c.modified ? `${c.modified} changed` : '', c.untracked ? `${c.untracked} new` : ''].filter(Boolean).join(' · ');

/**
 * A folder of a file tree. In Changes it is picked as a file is (a click, ⌘, Shift: `onPick`) and does what a file
 * does, to everything inside: the menu, the hover buttons, a double click (stage / unstage), Space. Its arrow opens
 * and closes it. Elsewhere (a commit's files) a click opens and closes it.
 */
/**
 * A folder's arrow: opens and closes it, and only that. On the web it is a plain view taking the click (a pressable
 * inside the row would end the row's hover, and hide its buttons, whenever the pointer is on the arrow).
 */
function FolderArrow({ open, onPress, testID }: { open: boolean; onPress: () => void; testID: string }) {
  const t = useTheme();
  const arrow = <Chevron open={open} color={t.textMuted} />;
  if (Platform.OS !== 'web')
    return (
      <Pressable onPress={onPress} hitSlop={6} testID={testID}>
        {arrow}
      </Pressable>
    );
  const click = {
    onClick: (e: any) => {
      // the row does not see it: no pick, no double click
      e.stopPropagation();
      onPress();
    },
  };
  return (
    <View {...(click as any)} testID={testID} accessibilityLabel={open ? 'Collapse' : 'Expand'} style={[{ alignSelf: 'stretch', justifyContent: 'center', paddingHorizontal: 3, marginHorizontal: -3 }, webCursor('pointer')]}>
      {arrow}
    </View>
  );
}

function FolderRow({ node, depth, open, area, inside, picked, group, untracked, onPick }: {
  node: Node;
  depth: number;
  open: boolean;
  area: Area;
  /** the files under it that the list shows */
  inside: string[];
  /** all of them are picked */
  picked: boolean;
  /** the whole pick, when it reaches beyond this folder: the menu and buttons act on it */
  group?: string[];
  /** the list's untracked files (a folder of tracked files only is not worth ignoring: git keeps tracking them) */
  untracked?: Set<string>;
  onPick?: (folder: string, mods: { meta: boolean; shift: boolean }) => void;
}) {
  const isLive = live.isLiveActive();
  const editable = (area === 'unstaged' || area === 'staged') && !!onPick;
  const toggle = () => toggleGroup(`tree:${area}:${node.path}`);
  const what = `${node.path}/`;
  // the folder's files, or the whole pick it is part of
  const targets = group ?? inside;
  const name = group ? undefined : what;
  const move = () => (area === 'unstaged' ? stageFiles(targets, name) : unstageFiles(targets, name));
  const discard = () => discardFiles(targets, name);
  const menu = (x: number, y: number) =>
    showContextMenu(
      x,
      y,
      group
        ? groupMenu(area, group, group.filter((p) => untracked?.has(p)))
        : [
            ...(editable && area === 'unstaged'
              ? [
                  { label: `Stage ${insideLabel(inside.length)}`, onPress: move },
                  { label: `Discard ${insideLabel(inside.length)}…`, danger: true, onPress: discard },
                  ...(inside.some((p) => untracked?.has(p)) ? [{ label: `Add /${what} to .gitignore`, onPress: () => (isLive ? live.addToGitignore(ignorePattern(what)) : toast(`Added ${what} to .gitignore (mock)`, 'success')) }] : []),
                  { separator: true },
                ]
              : []),
            ...(editable && area === 'staged' ? [{ label: `Unstage ${insideLabel(inside.length)}`, onPress: move }, { separator: true }] : []),
            ...(editable ? [{ label: 'Select everything inside', onPress: () => onPick!(node.path, { meta: false, shift: false }) }] : []),
            { label: open ? 'Collapse' : 'Expand', onPress: toggle },
            { separator: true },
            ...(editable
              ? [
                  { label: 'Open in editor', onPress: () => (isLive ? live.openInEditor(live.absPath(node.path)) : toast('Opened in editor (mock)', 'info')) },
                  { label: 'Reveal in Finder', onPress: () => (isLive ? live.revealPath(live.absPath(node.path)) : toast('Revealed (mock)', 'info')) },
                ]
              : []),
            { label: 'Copy path', onPress: () => live.copyText(node.path) },
          ],
    );
  return (
    <Row
      height={22}
      indent={depth * 14}
      selected={picked}
      selectMode="soft"
      onPress={onPick ? () => onPick(node.path, { meta: false, shift: false }) : toggle}
      onPressMods={onPick ? (m) => (onPick(node.path, m), true) : undefined}
      // as on a file: a double click moves it (everything inside) to the other list
      onDoublePress={editable ? move : undefined}
      onContextMenu={menu}
      testID={`folder-${area}-${node.path}`}
    >
      {({ hovered }) => (
        <>
          {/* the arrow opens and closes it (the row itself picks it, in Changes) */}
          <FolderArrow open={open} onPress={toggle} testID={`folder-toggle-${area}-${node.path}`} />
          <FolderIcon name={node.name} open={open} />
          <Txt size={FONT.sm} muted={!picked} style={{ marginLeft: 5, flex: 1 }} numberOfLines={1}>
            {node.name}
          </Txt>
          {editable ? (
            <HoverReveal
              rowHovered={hovered}
              rest={
                <Txt size={FONT.xs} mono faint testID={`folder-count-${area}-${node.path}`}>
                  {inside.length}
                </Txt>
              }
            >
              {area === 'unstaged' && <IconButton icon="undo" size={12} title={group ? `Discard ${group.length} files` : `Discard ${insideLabel(inside.length)}`} onPress={discard} testID={`folder-discard-${node.path}`} />}
              <IconButton
                icon={area === 'unstaged' ? 'plus' : 'minus'}
                size={13}
                title={`${area === 'unstaged' ? 'Stage' : 'Unstage'} ${group ? `${group.length} files` : insideLabel(inside.length)}`}
                onPress={move}
                testID={`folder-${area === 'unstaged' ? 'stage' : 'unstage'}-${node.path}`}
              />
            </HoverReveal>
          ) : null}
        </>
      )}
    </Row>
  );
}

export function FileRow({ file, area, selected, onSelect, indent = 0, nameOnly, compact, onPick, group, groupUntracked }: {
  file: FileChange;
  area: Area;
  selected: boolean;
  onSelect: () => void;
  indent?: number;
  nameOnly?: boolean;
  compact?: boolean;
  /** ⌘ / Shift on it (a Changes list) */
  onPick?: (path: string, mods: { meta: boolean; shift: boolean }) => void;
  /** the picked files it belongs to: its menu and buttons act on all of them */
  group?: string[];
  /** the untracked ones among them */
  groupUntracked?: string[];
}) {
  const t = useTheme();
  const color = statusColor(file.status, t);
  const editable = area === 'unstaged' || area === 'staged';
  const isLive = live.isLiveActive();
  // an untracked folder comes as "sdk/AiHelp/": named "AiHelp/" under "sdk/"
  const folder = file.path.endsWith('/');
  const bare = folder ? file.path.replace(/\/+$/, '') : file.path;
  const dir = bare.includes('/') ? bare.slice(0, bare.lastIndexOf('/') + 1) : '';
  const name = bare.slice(dir.length) + (folder ? '/' : '');
  const sub = file.kind === 'submodule' ? file.submodule ?? { before: '', after: '' } : null;
  // a submodule at its recorded commit, listed for the changes in its own files: they are staged and committed in
  // the submodule, so its row opens it (on Changes) instead of staging or discarding here
  const insideOnly = area === 'unstaged' && !!file.inside?.only;
  const goToSubmodule = () =>
    !isLive ? toast(`Opened ${file.path} (mock)`, 'info') : insideOnly ? void live.openSubmoduleChanges(file.path) : void live.openSubmoduleAt(file.path, sub?.after || undefined);
  // deleted in the working copy: nothing on disk to open or show
  const gone = file.status === 'D' && area === 'unstaged';
  // the commit (or stash) a commit-area row belongs to, read when its menu opens
  const committed = area === 'commit' || area === 'stash';
  const committedRev = () => {
    const s = getState();
    const r = s.repoStates[s.activeTab ?? ''];
    return area === 'stash' ? `stash@{${r?.selectedStash ?? 0}}` : r?.selectedCommit ?? 'HEAD';
  };
  // a file listed without its diff has no counts yet: none rather than "+0 −0"; a conflict's counts mean nothing; a
  // large diff keeps its counts (they went once it was selected)
  const counts = file.inside ? (
    <Txt size={FONT.xs} faint numberOfLines={1} testID={`inside-${area}-${file.path}`}>
      {insideText(file.inside)}
    </Txt>
  ) :
    (file.kind === 'text' || (file.kind === 'large' && file.additions + file.deletions > 0)) && !file.lazy && !folder && file.status !== 'U' ? (
      <Txt size={FONT.xs} mono faint>
        <Txt size={FONT.xs} mono color={t.add}>
          +{file.additions}
        </Txt>{' '}
        <Txt size={FONT.xs} mono color={t.del}>
          −{file.deletions}
        </Txt>
      </Txt>
    ) : null;
  return (
    <Row
      height={22}
      indent={indent}
      selected={selected}
      selectMode="soft"
      onPress={onSelect}
      onPressMods={onPick ? (m) => (onPick(file.path, m), true) : undefined}
      testID={`file-${area}-${file.path}`}
      onDoublePress={() => (insideOnly ? goToSubmodule() : area === 'unstaged' ? stageFile(file.path) : area === 'staged' ? unstageFile(file.path) : sub ? goToSubmodule() : undefined)}
      onContextMenu={(x, y) =>
        showContextMenu(x, y, group ? groupMenu(area, group, groupUntracked) : [
          // a submodule change: straight to the commit it points at, in the submodule's own tab
          ...(sub ? [{ label: sub.after && !insideOnly ? `Open submodule at ${sub.after.slice(0, 7)}` : 'Open submodule', onPress: goToSubmodule }, { separator: true }] : []),
          ...(area === 'unstaged' && !insideOnly
            ? [
                { label: 'Stage', onPress: () => stageFile(file.path) },
                { label: 'Discard changes…', danger: true, onPress: () => discardFile(file.path) },
                // only a file git does not track can be ignored (a tracked one stays tracked); the line names just it
                ...(file.status === '?' ? [{ label: 'Add to .gitignore', onPress: () => (isLive ? live.addToGitignore(ignorePattern(file.path)) : toast(`Added ${file.path} to .gitignore (mock)`, 'success')) }] : []),
              ]
            : []),
          ...(area === 'staged' ? [{ label: 'Unstage', onPress: () => unstageFile(file.path) }] : []),
          { separator: true },
          { label: 'File history', onPress: () => (isLive ? void live.showFileHistory(file.path) : toast(`History of ${file.path} (mock)`, 'info')) },
          // blame reads text lines: not of a picture or another binary (it printed their bytes as "lines")
          { label: 'Blame', disabled: file.status === 'D' || file.status === '?' || (file.kind !== 'text' && file.kind !== 'large'), onPress: () => (isLive ? void live.showBlame(file.path) : toast(`Blame ${file.path} (mock)`, 'info')) },
          { separator: true },
          // a commit's (or stash's) file as it is there — the working copy may not have it any more
          ...(committed ? [{ label: `Open this version (${committedRev().replace(/^([0-9a-f]{7})[0-9a-f]+$/, '$1')})`, disabled: file.status === 'D', onPress: () => (isLive ? live.openFileAt(committedRev(), file.path) : toast('Opened (mock)', 'info')) }] : []),
          // a file deleted from disk cannot be opened or shown
          { label: 'Open in editor', disabled: gone, onPress: () => (isLive ? live.openInEditor(live.absPath(file.path)) : toast('Opened in editor (mock)', 'info')) },
          { label: 'Reveal in Finder', disabled: gone, onPress: () => (isLive ? live.revealPath(live.absPath(file.path)) : toast('Revealed (mock)', 'info')) },
          { label: 'Copy path', onPress: () => live.copyText(file.path) },
        ])
      }
    >
      {({ hovered }) => (
        <>
          <Txt size={FONT.xs} mono weight="700" color={color} style={{ width: 14 }}>
            {file.status}
          </Txt>
          {file.kind === 'submodule' ? <Icon name="layers" size={13} color={t.info} /> : folder ? <FolderIcon name={name.replace(/\/$/, '')} open={false} /> : <FileIcon name={file.path} />}
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
          {editable && !insideOnly ? (
            <HoverReveal rowHovered={hovered} rest={counts}>
              {/* on a picked file the buttons act on all the picked ones */}
              {area === 'unstaged' && <IconButton icon="undo" size={12} title={group ? `Discard ${group.length} files` : 'Discard'} onPress={() => (group ? discardFiles(group) : discardFile(file.path))} testID={`file-discard-${file.path}`} />}
              <IconButton
                icon={area === 'unstaged' ? 'plus' : 'minus'}
                size={13}
                title={`${area === 'unstaged' ? 'Stage' : 'Unstage'}${group ? ` ${group.length} files` : ''}`}
                onPress={() => (area === 'unstaged' ? stageFiles(group ?? [file.path]) : unstageFiles(group ?? [file.path]))}
                testID={`file-${area === 'unstaged' ? 'stage' : 'unstage'}-${file.path}`}
              />
            </HoverReveal>
          ) : (
            counts
          )}
          {/* last, at the row's right end: the hover buttons appear to its left and never move it (it sat left of
              them, jumped as they appeared, and a click aimed at it hit Stage or Discard) */}
          {sub ? (
            <IconButton icon="arrowRight" size={13} title={insideOnly ? 'Open the submodule: its changes are committed there' : sub.after ? `Go to ${sub.after.slice(0, 7)} in the submodule` : 'Open the submodule'} onPress={goToSubmodule} testID={`open-submodule-${file.path}`} />
          ) : null}
        </>
      )}
    </Row>
  );
}
