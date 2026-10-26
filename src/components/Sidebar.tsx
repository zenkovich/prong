import React, { createContext, memo, useContext, useMemo, useState } from 'react';
import { Animated, ScrollView, StyleSheet, View } from 'react-native';
import { Ref } from '../git/types';
import type { Submodule } from '../git/GitClient';
import { FolderIcon } from '../ui/FileIcon';
import { countLeaves, PathNode, pathTree } from './pathTree';
import {
  applyStash,
  checkout,
  clearBranchFilter,
  clearRefSelection,
  clickRefSelection,
  deleteBranch,
  deleteTag,
  dropStash,
  fetch,
  filterToSelection,
  followAllBranches,
  getState,
  MenuItem,
  openDialog,
  push,
  pushBranchesBatch,
  revealCommit,
  selectStash,
  setSection,
  setSubmoduleView,
  showContextMenu,
  showOnlyRef,
  toast,
  toggleBranchFilter,
  toggleGroup,
  unshallow,
  updateRepo,
  useRepo,
  useRepoValue,
  useStore,
} from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { Badge, Button, Chevron, Collapsible, IconButton, Input, PressScale, Row, Segmented, Txt, useKeyboard, usePulse } from '../ui/primitives';
import { inFilter } from './branchFilter';
import { VersionGroup, versionGroups } from './versions';
import * as live from '../state/live';

/** how many versions the list shows before the “older versions” arrow */
const VERSIONS_SHOWN = 5;

interface TreeNode {
  name: string;
  full: string;
  children: TreeNode[];
  ref?: Ref;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function buildTree(refs: Ref[], strip = 0): TreeNode[] {
  const root: TreeNode[] = [];
  // a lookup per folder (a remote can have thousands of branches in one folder)
  const index = new Map<TreeNode[], Map<string, TreeNode>>();
  for (const r of refs) {
    const parts = r.name.split('/').slice(strip);
    let level = root;
    let full = '';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const leaf = i === parts.length - 1;
      full = full ? `${full}/${p}` : p;
      let byName = index.get(level);
      if (!byName) index.set(level, (byName = new Map()));
      const k = (leaf ? 'r:' : 'd:') + p;
      let node = byName.get(k);
      if (!node) {
        node = { name: p, full, children: [] };
        level.push(node);
        byName.set(k, node);
      }
      if (leaf) node.ref = r;
      level = node.children;
    }
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.ref ? 1 : 0) - (b.ref ? 1 : 0) || collator.compare(a.name, b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root);
  return root;
}

export function Sidebar() {
  const t = useTheme();
  const repo = useRepo();
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const changes = repo.unstaged.length + repo.staged.length;
  // the filter narrows branches, remotes, tags and submodules; while it is set every group and folder is open
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const refs = useMemo(() => (q ? repo.refs.filter((r) => r.name.toLowerCase().includes(q)) : repo.refs), [repo.refs, q]);
  const branches = useMemo(() => buildTree(refs.filter((r) => r.kind === 'branch')), [refs]);
  const remotes = useMemo(
    () => repo.remotes.map((rm) => ({ remote: rm, tree: buildTree(refs.filter((r) => r.kind === 'remote' && r.name.startsWith(rm.name + '/') && r.name !== `${rm.name}/HEAD`), 1) })).filter((x) => !q || x.tree.length > 0),
    [refs, repo.remotes, q],
  );
  const remoteCount = useMemo(() => repo.refs.filter((r) => r.kind === 'remote').length, [repo.refs]);
  const localCount = useMemo(() => repo.refs.filter((r) => r.kind === 'branch').length, [repo.refs]);
  const tags = useMemo(() => refs.filter((r) => r.kind === 'tag'), [refs]);
  // ver/XXX branches (XXX starts with three digits), local and remote, grouped per version — newest first
  const versions = useMemo(() => versionGroups(refs), [refs]);
  const submodules = useMemo(() => (q ? repo.submodules?.filter((s) => s.path.toLowerCase().includes(q)) : repo.submodules), [repo.submodules, q]);
  const submoduleView = useStore((s) => s.submoduleView);
  const pulse = usePulse(changes);
  // the order rows are shown in, for Shift runs of the multi-selection
  const order = useMemo(() => ({ branch: leafNames(branches), remote: remotes.flatMap((x) => leafNames(x.tree)) }), [branches, remotes]);
  const picked = repo.refSelection;
  useKeyboard((e) => {
    const s = getState();
    if (e.key === 'Escape' && !s.dialog && !s.contextMenu && !s.repoPicker && s.errorOpen == null) clearRefSelection();
  });
  if (collapsed) return null;
  const filtering = !!q;
  const inCommits = repo.section === 'commits' && repo.selectedArea === 'commit';

  return (
    <RefOrder.Provider value={order}>
    <View style={[styles.sidebar, { backgroundColor: t.panel, borderColor: t.border }]}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
        <View style={{ height: 6 }} />
        <Row selected={repo.section === 'changes'} selectMode="soft" onPress={() => setSection('changes')} height={24}>
          <Txt size={FONT.md} color={repo.section === 'changes' ? t.accent : 'transparent'} weight="700" style={{ width: 12 }}>
            ▸
          </Txt>
          <Icon name="edit" size={13} color={repo.section === 'changes' ? t.accent : t.textMuted} />
          <Txt style={{ marginLeft: 7, flex: 1 }} color={repo.section === 'changes' ? t.accent : undefined} weight={repo.section === 'changes' ? '600' : '400'}>
            Changes
          </Txt>
          {changes > 0 && (
            <Animated.View style={{ transform: [{ scale: pulse }] }}>
              <Badge bg={t.accent} color={t.accentText}>
                {changes}
              </Badge>
            </Animated.View>
          )}
        </Row>
        <Row selected={inCommits} selectMode="soft" onPress={() => setSection('commits')} height={24}>
          <Txt size={FONT.md} color={inCommits ? t.accent : 'transparent'} weight="700" style={{ width: 12 }}>
            ▸
          </Txt>
          <Icon name="commit" size={13} color={inCommits ? t.accent : t.textMuted} />
          <Txt style={{ marginLeft: 7, flex: 1 }} color={inCommits ? t.accent : undefined} weight={inCommits ? '600' : '400'}>
            All Commits
          </Txt>
        </Row>
        <View style={{ height: 1, backgroundColor: t.border, marginTop: 6, marginHorizontal: 8 }} testID="sidebar-separator" />
        <View style={{ paddingHorizontal: 8, paddingTop: 8 }}>
          <Input value={filter} onChange={setFilter} placeholder="filter branches" icon="search" small />
        </View>
        {filtering && branches.length === 0 && remotes.length === 0 && tags.length === 0 && !submodules?.length && (
          <Txt size={FONT.sm} faint style={{ paddingHorizontal: 12, paddingTop: 8 }}>
            Nothing matches “{filter.trim()}”
          </Txt>
        )}

        <Group title="Versions" icon="tag" groupKey="versions" count={versions.length} forceOpen={filtering} hidden={versions.length === 0}>
          {(filtering ? versions : versions.slice(0, VERSIONS_SHOWN)).map((g) => (
            <VersionNode key={g.version} group={g} forceOpen={filtering} />
          ))}
          {!filtering && versions.length > VERSIONS_SHOWN && <OlderVersions versions={versions.slice(VERSIONS_SHOWN)} />}
        </Group>

        <Group title="Branches" icon="branch" groupKey="branches" forceOpen={filtering} hidden={filtering && branches.length === 0} count={filtering ? refs.filter((r) => r.kind === 'branch').length : undefined} right={<IconButton icon="plus" size={13} title="New branch" onPress={() => openDialog({ type: 'branch' })} />}>
          {branches.map((n) => (
            <BranchNode key={n.full} node={n} depth={0} kind="branch" defaultOpen={localCount < 300} forceOpen={filtering} />
          ))}
        </Group>

        <Group title="Remotes" icon="cloud" groupKey="remotes" forceOpen={filtering} hidden={filtering && remotes.length === 0} right={<><IconButton icon="key" size={13} title="Connection: SSH key or account" onPress={() => openDialog({ type: 'connection' })} /><IconButton icon="plus" size={13} title="Add remote" onPress={() => openDialog({ type: 'remote' })} /><IconButton icon="refresh" size={13} title="Fetch all" onPress={() => fetch()} /></>}>
          {remotes.map(({ remote, tree }) => (
            <View key={remote.name}>
              <Row
                height={24}
                indent={14}
                onPress={() => toggleGroup('remote:' + remote.name)}
                onContextMenu={(x, y) =>
                  showContextMenu(x, y, [
                    { label: `Fetch ${remote.name}`, onPress: () => fetch({ remote: remote.name }) },
                    { label: 'Prune', onPress: () => (repo.live ? live.pruneRemote(remote.name) : toast(`Pruned ${remote.name} (mock)`, 'success')) },
                    // a narrow clone follows only some branches: fetching never brings the rest until the fetch list is widened
                    { label: remote.narrow ? 'Fetch every branch of this remote' : 'Fetch every branch — already followed', disabled: !remote.narrow, onPress: () => followAllBranches(remote.name) },
                    { label: repo.shallow ? 'Fetch the full history (unshallow)' : 'Fetch the full history — the history is already complete', disabled: !repo.shallow, onPress: () => unshallow({ remote: remote.name }) },
                    { separator: true },
                    { label: 'Edit remote…', onPress: () => openDialog({ type: 'remote', name: remote.name, url: remote.url }) },
                    { label: 'Connection (SSH key / account)…', onPress: () => openDialog({ type: 'connection' }) },
                    { label: 'Copy URL', onPress: () => live.copyText(remote.url) },
                    { label: 'Remove remote', danger: true, onPress: () => (repo.live ? live.removeRemote(remote.name) : toast('Remote kept (mock)', 'info')) },
                  ])
                }
              >
                <Chevron open={!repo.collapsedGroups['remote:' + remote.name]} color={t.textMuted} />
                <Icon name="cloud" size={12} color={t.textFaint} />
                <Txt size={FONT.md} style={{ marginLeft: 5, flex: 1 }} numberOfLines={1}>
                  {remote.name}
                </Txt>
                {remote.narrow && (
                  <Badge color={t.warn} style={{ marginRight: 5 }}>
                    narrow
                  </Badge>
                )}
                <Txt size={FONT.xs} faint numberOfLines={1} style={{ maxWidth: 90 }}>
                  {remote.url.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1')}
                </Txt>
              </Row>
              {/* a --single-branch clone keeps asking for one branch only: say why the others are missing, and get them */}
              {remote.narrow && (
                <View style={{ paddingLeft: 32, paddingRight: 8, paddingBottom: 6 }}>
                  <Txt size={FONT.xs} faint>
                    This clone follows only some branches, so the rest of {remote.name} never arrives.
                  </Txt>
                  <Button small label="Fetch every branch" icon="fetch" style={{ marginTop: 4, alignSelf: 'flex-start' }} onPress={() => followAllBranches(remote.name)} testID={`follow-all-${remote.name}`} />
                </View>
              )}
              <Collapsible open={filtering || !repo.collapsedGroups['remote:' + remote.name]}>
                {tree.slice(0, 200).map((n) => (
                  <BranchNode key={n.full} node={n} depth={1} kind="remote" defaultOpen={remoteCount < 300} forceOpen={filtering} />
                ))}
                {tree.length > 200 && (
                  <Txt size={FONT.xs} faint style={{ paddingLeft: 40, paddingVertical: 3 }}>
                    … {tree.length - 200} more
                  </Txt>
                )}
              </Collapsible>
            </View>
          ))}
        </Group>

        <Group title="Tags" icon="tag" groupKey="tags" count={tags.length} forceOpen={filtering} hidden={filtering && tags.length === 0} right={<IconButton icon="plus" size={13} title="New tag" onPress={() => openDialog({ type: 'tag', sha: repo.head })} />}>
          {tags.map((tag) => (
            <TagRow key={tag.name} tag={tag} />
          ))}
        </Group>

        {repo.live && (
          <Group
            title="Submodules"
            icon="layers"
            groupKey="submodules"
            count={submodules?.length ?? 0}
            forceOpen={filtering}
            hidden={filtering && !submodules?.length}
            right={
              <>
                {(repo.submodules?.length ?? 0) > 0 && <Segmented value={submoduleView} onChange={setSubmoduleView} options={[{ value: 'list', icon: 'list' }, { value: 'tree', icon: 'tree' }]} />}
                <IconButton icon="refresh" size={13} title="Update all (init + checkout to index)" onPress={() => live.updateSubmodules(undefined, false)} />
                <IconButton icon="link" size={13} title="Sync URLs from .gitmodules" onPress={() => live.syncSubmodules()} />
              </>
            }
          >
            {!submodules && (
              <Txt size={FONT.sm} faint style={{ paddingLeft: 24, paddingVertical: 4 }}>
                loading…
              </Txt>
            )}
            {submodules?.length === 0 && (
              <Txt size={FONT.sm} faint style={{ paddingLeft: 24, paddingVertical: 4 }}>
                No submodules
              </Txt>
            )}
            {submodules && submoduleView === 'tree' && pathTree(submodules).map((n) => <SubmoduleNode key={n.full} node={n} depth={0} forceOpen={filtering} />)}
            {submodules && submoduleView === 'list' && submodules.map((sm) => <SubmoduleRow key={sm.path} sm={sm} label={sm.path} indent={14} />)}
          </Group>
        )}
        <Group title="Stashes" icon="stash" groupKey="stashes" count={repo.stashes.length} right={<IconButton icon="plus" size={13} title="Stash changes" onPress={() => openDialog({ type: 'stash' })} />}>
          {repo.stashes.length === 0 && (
            <Txt size={FONT.sm} faint style={{ paddingLeft: 24, paddingVertical: 4 }}>
              No stashes
            </Txt>
          )}
          {repo.stashes.map((st) => (
            <Row
              key={st.sha}
              selectMode="soft"
              height={24}
              indent={14}
              selected={repo.selectedArea === 'stash' && repo.selectedStash === st.index}
              onPress={() => selectStash(st.index)}
              onContextMenu={(x, y) =>
                showContextMenu(x, y, [
                  { label: 'Apply', onPress: () => applyStash(st.index, false) },
                  { label: 'Pop', onPress: () => applyStash(st.index, true) },
                  { separator: true },
                  { label: 'Drop', danger: true, onPress: () => dropStash(st.index) },
                ])
              }
            >
              <Icon name="stash" size={12} />
              <Txt size={FONT.md} style={{ marginLeft: 6, flex: 1 }} numberOfLines={1}>
                {st.message}
              </Txt>
              <Txt size={FONT.xs} faint mono>
                {`{${st.index}}`}
              </Txt>
            </Row>
          ))}
        </Group>
      </ScrollView>
      {picked.length > 0 && <BatchBar names={picked} />}
    </View>
    </RefOrder.Provider>
  );
}

function Group({ title, icon, groupKey, children, right, count, forceOpen, hidden }: { title: string; icon: IconName; groupKey: string; children: React.ReactNode; right?: React.ReactNode; count?: number; forceOpen?: boolean; hidden?: boolean }) {
  const t = useTheme();
  const repo = useRepo();
  if (hidden) return null;
  const open = forceOpen || !repo.collapsedGroups[groupKey];
  return (
    <View style={{ marginTop: 8 }} testID={`group-${groupKey}`}>
      <Row height={24} onPress={() => toggleGroup(groupKey)} style={{ paddingLeft: 8 }}>
        {({ hovered }) => (
          <>
            <Chevron open={open} />
            <Icon name={icon} size={12} color={t.textFaint} />
            <Txt label faint numberOfLines={1} style={{ marginLeft: 6, flex: 1, minWidth: 60 }}>
              {title}
            </Txt>
            {count !== undefined ? (
              <Txt size={FONT.xs} faint style={{ marginRight: right ? 4 : 0 }}>
                {count}
              </Txt>
            ) : null}
            {/* always in place (a button that appears only while its row is hovered vanishes the moment the
                pointer moves onto it); faint until the row is hovered */}
            {right ? <View style={{ flexDirection: 'row', alignItems: 'center', opacity: hovered ? 1 : 0.45 }}>{right}</View> : null}
          </>
        )}
      </Row>
      <Collapsible open={open}>{children}</Collapsible>
    </View>
  );
}

function SubmoduleNode({ node, depth, forceOpen }: { node: PathNode; depth: number; forceOpen?: boolean }) {
  const t = useTheme();
  const repo = useRepo();
  const key = `sub:${node.full}`;
  const open = forceOpen || !repo.collapsedGroups[key];
  const indent = 14 + depth * 12;
  if (node.sub) return <SubmoduleRow sm={node.sub} label={node.name} indent={indent} />;
  return (
    <View>
      <Row height={22} indent={indent} onPress={() => toggleGroup(key)}>
        <Chevron open={open} color={t.textMuted} />
        <FolderIcon name={node.name} open={open} size={12} />
        <Txt size={FONT.md} muted style={{ marginLeft: 5 }} numberOfLines={1}>
          {node.name}
        </Txt>
        <Txt size={FONT.xs} faint style={{ marginLeft: 6 }}>
          {countLeaves(node)}
        </Txt>
      </Row>
      <Collapsible open={open}>
        {node.children.map((c) => (
          <SubmoduleNode key={c.full} node={c} depth={depth + 1} forceOpen={forceOpen} />
        ))}
      </Collapsible>
    </View>
  );
}

function SubmoduleRow({ sm, label, indent }: { sm: Submodule; label: string; indent: number }) {
  const t = useTheme();
  const color = sm.state === 'ok' ? t.add : sm.state === 'uninitialized' ? t.textFaint : sm.state === 'conflict' ? t.del : t.warn;
  return (
    <Row
      height={24}
      indent={indent}
      selectMode="soft"
      onPress={() => live.openSubmodule(sm)}
      onContextMenu={(x, y) =>
        showContextMenu(x, y, [
          { label: 'Open as repository', onPress: () => live.openSubmodule(sm) },
          { label: sm.state === 'uninitialized' ? 'Initialize & update' : 'Update to index commit', onPress: () => live.updateSubmodules([sm.path], false) },
          { label: 'Update recursively', onPress: () => live.updateSubmodules([sm.path], true) },
          { separator: true },
          { label: 'Reveal in Finder', onPress: () => live.revealPath(live.absPath(sm.path)) },
          { label: 'Copy URL', onPress: () => live.copyText(sm.url) },
        ])
      }
    >
      <View style={{ width: 7, height: 7, backgroundColor: color }} />
      <Txt size={FONT.md} style={{ marginLeft: 6, flex: 1 }} numberOfLines={1} testID={`submodule-${sm.path}`}>
        {label}
      </Txt>
      <Txt size={FONT.xs} faint numberOfLines={1} style={{ maxWidth: 90 }}>
        {sm.state === 'uninitialized' ? 'not init' : sm.describe ?? sm.sha.slice(0, 7)}
      </Txt>
    </Row>
  );
}

/**
 * Fork's branch filter button. Always laid out (a button that exists only while its row is hovered vanishes the
 * moment the pointer moves onto it): shown while the row or the button is hovered, and stays lit while the
 * branch is part of the filter.
 */
function FunnelButton({ name, active, rowHovered }: { name: string; active: boolean; rowHovered: boolean }) {
  const t = useTheme();
  return (
    <PressScale onPress={() => toggleBranchFilter(name)} scaleTo={0.85} style={{ width: 18, height: 18, alignItems: 'center', justifyContent: 'center', marginLeft: 4 }} label={active ? `Remove ${name} from the filter` : `Filter the history to ${name}`} testID={`funnel-${name}`}>
      {({ hovered }) => (
        <View style={{ opacity: active || rowHovered || hovered ? 1 : 0 }}>
          <Icon name="filter" size={11} color={active ? t.accent : hovered ? t.text : t.textMuted} />
        </View>
      )}
    </PressScale>
  );
}

const TagRow = memo(function TagRow({ tag }: { tag: Ref }) {
  const t = useTheme();
  const selected = useRepoValue((r) => r.section === 'commits' && r.selectedArea === 'commit' && r.selectedCommit === tag.sha);
  const active = useRepoValue((r) => inFilter(r.graphFilter, tag.name));
  return (
    <Row
      selectMode="soft"
      height={24}
      indent={14}
      selected={selected}
      onPress={() => revealCommit(tag.sha)}
      onContextMenu={(x, y) => {
        const isLive = live.isLiveActive();
        showContextMenu(x, y, [
          { label: `Checkout ${tag.name}`, onPress: () => (isLive ? live.checkoutDetached(tag.sha) : toast(`Detached HEAD at ${tag.name} (mock)`, 'info')) },
          { label: 'Push tag', onPress: () => (isLive ? live.pushTag(tag.name) : toast(`Pushed tag ${tag.name} (mock)`, 'success')) },
          { label: 'Copy name', onPress: () => live.copyText(tag.name) },
          { separator: true },
          { label: 'Delete tag', danger: true, onPress: () => deleteTag(tag.name) },
        ]);
      }}
    >
      {({ hovered }) => (
        <>
          <Icon name="tag" size={12} color={t.tag} />
          <Txt size={FONT.md} style={{ marginLeft: 6, flex: 1 }} numberOfLines={1}>
            {tag.name}
          </Txt>
          <FunnelButton name={tag.name} active={active} rowHovered={hovered} />
        </>
      )}
    </Row>
  );
});

/**
 * one version (ver/XXX) with its branches under it. A version whose branch is in the local repository starts
 * open; a version that only exists on a remote starts collapsed.
 */
const VersionNode = memo(function VersionNode({ group, forceOpen }: { group: VersionGroup; forceOpen?: boolean }) {
  const t = useTheme();
  const key = `version:${group.version}`;
  const stored = useRepoValue((r) => r.collapsedGroups[key]);
  const open = forceOpen || (stored === undefined ? group.local : !stored);
  const toggle = () => updateRepo((r) => ({ collapsedGroups: { ...r.collapsedGroups, [key]: open } }));
  const primary = group.refs[0];
  return (
    <View testID={`version-${group.version}`}>
      <Row
        height={22}
        indent={14}
        onPress={toggle}
        onDoublePress={() => !group.current && primary && checkout(primary.name)}
        onContextMenu={(x, y) =>
          showContextMenu(x, y, [
            { label: group.current ? 'Already checked out' : `Checkout ${primary?.name ?? group.version}`, disabled: group.current || !primary, onPress: () => primary && checkout(primary.name) },
            { label: 'Show only this version', disabled: !primary, onPress: () => primary && showOnlyRef(primary.name) },
            { separator: true },
            { label: 'Copy version', onPress: () => live.copyText(group.version) },
          ])
        }
      >
        <Chevron open={open} color={t.textMuted} />
        {group.current ? <View style={{ width: 7, height: 7, backgroundColor: t.accent, marginRight: 1 }} /> : <Icon name="tag" size={12} color={group.local ? t.tag : t.textFaint} />}
        <Txt size={FONT.md} style={{ marginLeft: 6, flex: 1 }} color={group.current ? t.accent : group.local ? undefined : t.textMuted} weight={group.current ? '600' : '400'} numberOfLines={1} testID={`version-name-${group.version}`}>
          {group.version}
        </Txt>
        {!group.local && (
          <Txt size={FONT.xs} faint style={{ marginRight: 4 }}>
            remote
          </Txt>
        )}
        <Txt size={FONT.xs} faint>
          {group.refs.length}
        </Txt>
      </Row>
      <Collapsible open={open}>
        {group.refs.map((r) => (
          <BranchLeaf key={r.name} r={r} label={r.name} kind={r.kind === 'branch' ? 'branch' : 'remote'} indent={26} />
        ))}
      </Collapsible>
    </View>
  );
});

/** the versions past the first five, behind one arrow (collapsed by default) */
function OlderVersions({ versions }: { versions: VersionGroup[] }) {
  const t = useTheme();
  const key = 'versions:older';
  const stored = useRepoValue((r) => r.collapsedGroups[key]);
  const open = stored === undefined ? false : !stored;
  const toggle = () => updateRepo((r) => ({ collapsedGroups: { ...r.collapsedGroups, [key]: open } }));
  return (
    <View testID="versions-older">
      <Row height={22} indent={14} onPress={toggle}>
        <Chevron open={open} color={t.textMuted} />
        <Txt size={FONT.sm} faint style={{ marginLeft: 6, flex: 1 }} numberOfLines={1}>
          {versions.length} older version{versions.length === 1 ? '' : 's'}
        </Txt>
      </Row>
      <Collapsible open={open}>
        {versions.map((g) => (
          <VersionNode key={g.version} group={g} />
        ))}
      </Collapsible>
    </View>
  );
}

const BranchNode = memo(function BranchNode({ node, depth, kind, defaultOpen = true, forceOpen }: { node: TreeNode; depth: number; kind: 'branch' | 'remote'; defaultOpen?: boolean; forceOpen?: boolean }) {
  const t = useTheme();
  const key = `${kind}:${node.full}`;
  const stored = useRepoValue((r) => r.collapsedGroups[key]);
  // huge trees (thousands of remote branches) start collapsed so the sidebar paints instantly
  const open = forceOpen || (stored === undefined ? defaultOpen : !stored);
  const toggle = () => updateRepo((r) => ({ collapsedGroups: { ...r.collapsedGroups, [key]: open } }));
  const indent = 14 + depth * 12;
  if (node.ref) return <BranchLeaf r={node.ref} label={node.name} kind={kind} indent={indent} />;
  return (
    <View>
      <Row height={22} indent={indent} onPress={toggle}>
        <Chevron open={open} color={t.textMuted} />
        <Icon name="folder" size={12} color={t.textFaint} />
        <Txt size={FONT.md} muted style={{ marginLeft: 5 }} numberOfLines={1}>
          {node.name}
        </Txt>
      </Row>
      <Collapsible open={open}>
        {node.children.slice(0, 200).map((c) => (
          <BranchNode key={c.full} node={c} depth={depth + 1} kind={kind} defaultOpen={defaultOpen} forceOpen={forceOpen} />
        ))}
        {node.children.length > 200 && (
          <Txt size={FONT.xs} faint style={{ paddingLeft: indent + 30, paddingVertical: 3 }}>
            … {node.children.length - 200} more (use the branch filter above the graph)
          </Txt>
        )}
      </Collapsible>
    </View>
  );
});

/** one branch: subscribes to the few values it shows, so selecting a commit does not re-render thousands of these */
const BranchLeaf = memo(function BranchLeaf({ r, label, kind, indent }: { r: Ref; label: string; kind: 'branch' | 'remote'; indent: number }) {
  const t = useTheme();
  const order = useContext(RefOrder);
  const isPicked = useRepoValue((x) => x.refSelection.includes(r.name));
  const pickedCount = useRepoValue((x) => x.refSelection.length);
  const selected = useRepoValue((x) => x.section === 'commits' && x.selectedArea === 'commit' && x.selectedCommit === r.sha && !r.current);
  const visible = useRepoValue((x) => {
    const f = x.graphFilter;
    if (f.mode === 'all') return !(f.hideRemotes && r.kind === 'remote');
    if (f.mode === 'current') return !!r.current;
    return f.refs.includes(r.name);
  });
  const filtered = useRepoValue((x) => inFilter(x.graphFilter, r.name));
  const items = () => {
    // read at the moment the menu opens, not on every render of every row
    const repo = getState().repoStates[getState().activeTab ?? ''];
    const current = repo?.refs.find((x) => x.kind === 'branch' && x.current);
    const mode = repo?.graphFilter.mode ?? 'all';
    const graphItems = [
      { separator: true },
      { label: 'Show only this branch', onPress: () => showOnlyRef(r.name) },
      ...(mode === 'selected' ? [{ label: filtered ? 'Remove from the filter' : 'Add to the filter', onPress: () => toggleBranchFilter(r.name) }] : []),
      ...(mode !== 'all' ? [{ label: 'Clear the branch filter', onPress: clearBranchFilter }] : []),
    ];
    if (kind === 'branch')
      return [
        { label: r.current ? 'Already checked out' : `Checkout ${r.name}`, disabled: !!r.current, onPress: () => checkout(r.name) },
        { label: `Merge ${r.name} into ${current?.name ?? 'HEAD'}`, disabled: !!r.current, onPress: () => openDialog({ type: 'merge', source: r.name }) },
        { label: `Rebase ${current?.name ?? 'HEAD'} onto ${r.name}`, disabled: !!r.current, onPress: () => openDialog({ type: 'rebase', onto: r.name }) },
        { separator: true },
        { label: r.upstream ? `Push to ${r.upstream}` : 'Push…', onPress: () => (r.upstream ? push({ branch: r.name }) : openDialog({ type: 'push', branch: r.name })) },
        { label: r.current ? 'Pull…' : 'Pull (check it out first)', disabled: !r.current, onPress: () => openDialog({ type: 'pull' }) },
        { label: 'Set upstream…', onPress: () => openDialog({ type: 'upstream', branch: r.name }) },
        { separator: true },
        { label: 'Rename…', onPress: () => openDialog({ type: 'renameBranch', name: r.name }) },
        { label: 'Copy branch name', onPress: () => live.copyText(r.name) },
        { separator: true },
        { label: 'Delete', danger: true, disabled: !!r.current, onPress: () => deleteBranch(r.name) },
        { label: 'Delete (local + remote)', danger: true, disabled: !!r.current, onPress: () => deleteBranch(r.name, true) },
        ...graphItems,
      ];
    return [
      { label: `Checkout ${r.name.replace(/^[^/]+\//, '')}`, onPress: () => checkout(r.name) },
      { label: `Merge into ${current?.name ?? 'HEAD'}`, onPress: () => openDialog({ type: 'merge', source: r.name }) },
      { label: `Rebase ${current?.name ?? 'HEAD'} onto ${r.name}`, onPress: () => openDialog({ type: 'rebase', onto: r.name }) },
      { separator: true },
      { label: 'Copy branch name', onPress: () => live.copyText(r.name) },
      { label: 'Delete remote branch', danger: true, onPress: () => deleteBranch(r.name) },
      ...graphItems,
    ];
  };
  return (
    <Row
      height={22}
      indent={indent + 4}
      selected={selected}
      selectMode="soft"
      testID={isPicked ? `picked-${r.name}` : undefined}
      onPress={() => {
        clearRefSelection();
        void revealCommit(r.sha);
      }}
      // ⌘ / Shift: pick branches for a batch action instead of jumping to the commit
      onPressMods={(m) => {
        clickRefSelection(r.name, m, order[kind]);
        return true;
      }}
      onDoublePress={() => !r.current && checkout(r.name)}
      onContextMenu={(x, y) => showContextMenu(x, y, isPicked && pickedCount > 1 ? batchMenu(getState().repoStates[getState().activeTab ?? '']?.refSelection ?? []) : items())}
      style={[!visible ? { opacity: 0.45 } : undefined, isPicked ? { backgroundColor: t.accentSoft } : undefined]}
    >
      {({ hovered }) => (
        <>
          {isPicked ? (
            <Icon name="check" size={11} color={t.accent} />
          ) : r.current ? (
            <View style={{ width: 7, height: 7, backgroundColor: t.accent, marginRight: 1 }} />
          ) : (
            <Icon name={kind === 'remote' ? 'cloud' : 'branch'} size={11} color={t.textFaint} />
          )}
          <Txt size={FONT.md} color={r.current ? t.accent : undefined} weight={r.current ? '600' : '400'} style={{ marginLeft: 6, flex: 1 }} numberOfLines={1} testID={`branch-${r.name}`}>
            {label}
          </Txt>
          {kind === 'branch' && r.upstream && !r.gone ? (
            <View style={{ marginRight: 4 }} testID={`branch-cloud-${r.name}`}>
              <Icon name="cloud" size={11} strokeWidth={2.2} color={t.info} />
            </View>
          ) : null}
          {kind === 'branch' && (r.ahead || r.behind) ? (
            <Txt size={FONT.xs} muted>
              {r.ahead ? `↑${r.ahead} ` : ''}
              {r.behind ? `↓${r.behind}` : ''}
            </Txt>
          ) : null}
          <FunnelButton name={r.name} active={filtered} rowHovered={hovered} />
        </>
      )}
    </Row>
  );
});

/** the order branch rows are shown in, per kind (Shift selects a run of it) */
const RefOrder = createContext<{ branch: string[]; remote: string[] }>({ branch: [], remote: [] });
function leafNames(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.ref) out.push(n.ref.name);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** what can be done with several branches at once */
function batchMenu(names: string[]): MenuItem[] {
  const repo = getState().repoStates[getState().activeTab ?? ''];
  const kinds = new Map((repo?.refs ?? []).map((x) => [x.name, x]));
  const locals = names.filter((n) => kinds.get(n)?.kind === 'branch');
  const filtering = repo?.graphFilter.mode === 'selected';
  return [
    { label: `Show only these ${names.length} in the history`, onPress: () => filterToSelection(false) },
    { label: 'Add them to the branch filter', disabled: !filtering, onPress: () => filterToSelection(true) },
    { separator: true },
    { label: locals.length ? `Push ${locals.length} branch${locals.length === 1 ? '' : 'es'}` : 'Push (no local branches picked)', disabled: !locals.length, onPress: () => pushBranchesBatch(locals) },
    { label: `Delete ${names.length} branches…`, danger: true, onPress: () => openDialog({ type: 'deleteBranches', names }) },
    { separator: true },
    { label: 'Copy names', onPress: () => live.copyText(names.join('\n')) },
    { label: 'Clear the selection', shortcut: 'Esc', onPress: clearRefSelection },
  ];
}

/** under the branch list while branches are picked: how many, and the batch actions */
function BatchBar({ names }: { names: string[] }) {
  const t = useTheme();
  const repo = useRepo();
  const locals = names.filter((n) => repo.refs.some((x) => x.name === n && x.kind === 'branch'));
  return (
    <View style={[styles.batch, { borderColor: t.border, backgroundColor: t.panelAlt }]} testID="batch-bar">
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Icon name="check" size={12} color={t.accent} />
        <Txt size={FONT.sm} weight="600" style={{ marginLeft: 6, flex: 1 }} testID="batch-count">
          {names.length} selected
        </Txt>
        <IconButton icon="x" size={12} title="Clear the selection (Esc)" onPress={clearRefSelection} testID="batch-clear" />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 }}>
        <Button small label="Show only" icon="filter" onPress={() => filterToSelection(false)} testID="batch-filter" />
        <Button small label={`Push ${locals.length || ''}`.trim()} icon="push" disabled={!locals.length} style={{ marginLeft: 6 }} onPress={() => pushBranchesBatch(locals)} testID="batch-push" />
        <Button small label="Delete…" icon="trash" danger style={{ marginLeft: 6 }} onPress={() => openDialog({ type: 'deleteBranches', names })} testID="batch-delete" />
      </View>
      <Txt size={FONT.xs} faint style={{ marginTop: 4 }}>
        ⌘-click adds or removes · Shift-click selects a run
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  batch: { borderTopWidth: 1, padding: 8 },
  sidebar: { flex: 1, minHeight: 0, borderRightWidth: 1 },
});
