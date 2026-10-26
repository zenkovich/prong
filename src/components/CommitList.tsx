import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Line, Path, Polygon, Rect } from 'react-native-svg';
import { Commit, Ref, Sha } from '../git/types';
import {
  checkout,
  cherryPick,
  clearBranchFilter,
  collapseAllMerges,
  commitsToRebase,
  expandAllMerges,
  getState,
  openDialog,
  relTime,
  revert,
  selectCommit,
  setGraphFilter,
  setSearch,
  setSection,
  shortSha,
  showContextMenu,
  toast,
  toggleBranchFilter,
  toggleGraphRef,
  toggleMerge,
  unshallow,
  useMods,
  useRepo,
} from '../state/store';
import { FONT, ROW, useSelected, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Avatar, Button, Checkbox, Glass, IconButton, Input, PressScale, ResizeGrip, Row, Segmented, Txt, useViewport, webCursor } from '../ui/primitives';
import { applyCollapse, filterByRefs, GraphLayout, GraphRow, layoutGraph, reachableFrom } from './graphLayout';
import { RefLabel, refLabels } from './commitRefs';
import * as live from '../state/live';
import { rowTop, useVirtualWindow } from '../ui/virtual';

/*
 * Results kept per commit list (the list object from the store), so opening the history again (another section,
 * another tab and back) does not lay out tens of thousands of commits anew.
 */
const collapseCache = new WeakMap<Commit[], { key: Record<Sha, boolean>; res: ReturnType<typeof applyCollapse> }>();
function cachedCollapse(list: Commit[], collapsedMerges: Record<Sha, boolean>) {
  const hit = collapseCache.get(list);
  if (hit && hit.key === collapsedMerges) return hit.res;
  const res = applyCollapse(list, new Set(Object.keys(collapsedMerges)));
  collapseCache.set(list, { key: collapsedMerges, res });
  return res;
}
const layoutCache = new WeakMap<Commit[], { key: string; res: GraphLayout }>();
/** `list` is `visible`, or `visible` with the working-copy row on top */
function cachedLayout(visible: Commit[], list: Commit[]) {
  const key = list === visible ? '' : `wip:${list[0].parents.join(',')}`;
  const hit = layoutCache.get(visible);
  if (hit && hit.key === key) return hit.res;
  const res = layoutGraph(list, MAX_LANES);
  layoutCache.set(visible, { key, res });
  return res;
}
const reachCache = new WeakMap<Commit[], { key: Sha; res: Set<Sha> }>();
function cachedReach(list: Commit[], head: Sha) {
  const hit = reachCache.get(list);
  if (hit && hit.key === head) return hit.res;
  const res = reachableFrom(list, head);
  reachCache.set(list, { key: head, res });
  return res;
}

const LANE_W = 14;
const WIP = '__wip__';
const MAX_LANES = 12;

export function CommitList() {
  const t = useTheme();
  const repo = useRepo();
  const { commits, refs, head, search, graphFilter, collapsedMerges, selectedCommit, unstaged, staged } = repo;
  const changes = unstaged.length + staged.length;
  const [filterOpen, setFilterOpen] = useState(false);
  const mods = useMods();

  // 1. branch filter → 2. merge collapsing → 3. text search
  const history = useMemo(() => (repo.historyPath ? repo.historyCommits ?? [] : null), [repo.historyPath, repo.historyCommits]);
  const engineFiltered = repo.live ? repo.filteredCommits ?? null : null;
  const filtered = useMemo(() => (history ? history : engineFiltered ? engineFiltered : filterByRefs(commits, refs, head, graphFilter)), [commits, refs, head, graphFilter, history, engineFiltered]);
  const collapsed = useMemo(() => cachedCollapse(filtered, collapsedMerges), [filtered, collapsedMerges]);
  const q = search.trim().toLowerCase();
  const showGraph = !q && !history;
  const visible = useMemo(() => {
    if (!q) return collapsed.commits;
    return collapsed.commits.filter((c) => c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.sha.startsWith(q) || c.body.toLowerCase().includes(q));
  }, [collapsed, q]);

  const headVisible = visible.some((c) => c.sha === head);
  const [openedAt] = useState(() => Date.now());
  const list = useMemo(() => {
    if (!showGraph || changes === 0) return visible;
    // the working-copy row attaches to HEAD when it is on this page, otherwise it stands alone
    const wip: Commit = { sha: WIP, parents: headVisible ? [head] : [], subject: '', body: '', author: '', email: '', date: openedAt };
    return [wip, ...visible];
  }, [visible, showGraph, changes, head, headVisible, openedAt]);

  const layout = useMemo(() => (showGraph ? cachedLayout(visible, list) : null), [visible, list, showGraph]);
  // Fork-style: commits that are not in the current branch are drawn grey (only when HEAD is on this page)
  const onBranch = useMemo(() => (head && headVisible ? cachedReach(visible, head) : null), [visible, head, headVisible]);
  const graphW = layout ? Math.min(layout.maxLanes, MAX_LANES) * LANE_W + 8 : 8;
  const selectedIndex = useMemo(() => (repo.selectedArea === 'commit' && selectedCommit ? list.findIndex((c) => c.sha === selectedCommit) : -1), [list, selectedCommit, repo.selectedArea]);

  const refsBySha = useMemo(() => {
    const m = new Map<Sha, Ref[]>();
    for (const r of refs) {
      if (r.name === 'origin/HEAD') continue;
      const arr = m.get(r.sha) ?? [];
      arr.push(r);
      m.set(r.sha, arr);
    }
    return m;
  }, [refs]);

  // a click on a branch in the sidebar: scroll so its commit sits in the upper third of the list
  const scrollRef = useRef<any>(null);
  // only the rows on screen (plus a margin) are rendered: a deep history has tens of thousands
  const win = useVirtualWindow(list.length, ROW);
  const viewH = win.viewH;
  const revealed = useRef(0);
  const scrollY = useRef(0);
  const reveal = repo.reveal;
  useEffect(() => {
    if (!reveal || revealed.current === reveal.nonce) return;
    const idx = list.findIndex((c) => c.sha === reveal.sha);
    if (idx < 0) {
      // hidden inside a collapsed merge: open the merges, the list re-renders and this runs again
      if (collapsed.hidden.has(reveal.sha)) expandAllMerges();
      return;
    }
    revealed.current = reveal.nonce;
    // a short move glides, a jump across the history is instant (like Fork)
    const y = Math.max(0, idx * ROW - viewH / 3);
    scrollRef.current?.scrollTo({ y, animated: Math.abs(y - scrollY.current) < viewH * 2 });
  }, [reveal, list, collapsed.hidden, viewH]);

  const mergeCount = useMemo(() => commits.filter((c) => c.parents.length > 1).length, [commits]);
  const collapsedCount = Object.keys(collapsedMerges).length;
  const filterLabel = graphFilter.mode === 'all' ? (graphFilter.hideRemotes ? 'Local branches' : 'All branches') : graphFilter.mode === 'current' ? 'Current branch' : `${graphFilter.refs.length} selected`;

  return (
    <View style={{ flex: 1, backgroundColor: t.panel }}>
      <View style={[styles.filterBar, { borderColor: t.border, backgroundColor: t.panelAlt }]}>
        <Input value={search} onChange={setSearch} placeholder="search commits: message, author, sha" slash small style={{ flex: 1, maxWidth: 380 }} />
        <View style={{ width: 10 }} />
        <Button small icon="branch" label={filterLabel} iconRight="chevronDown" active={graphFilter.mode !== 'all' || graphFilter.hideRemotes} onPress={() => setFilterOpen((v) => !v)} />
        <View style={{ width: 8 }} />
        <IconButton icon="minus" size={13} title="Collapse all merges" onPress={collapseAllMerges} disabled={mergeCount === 0 || collapsedCount === mergeCount} />
        <IconButton icon="plus" size={13} title="Expand all merges" onPress={expandAllMerges} disabled={collapsedCount === 0} />
        <View style={{ flex: 1 }} />
        <Txt size={FONT.xs} faint>
          {visible.length} of {commits.length} commits{collapsed.hidden.size ? ` · ${collapsed.hidden.size} collapsed` : ''}
        </Txt>
      </View>
      {graphFilter.mode !== 'all' && !history && (
        <View style={[styles.historyBar, { borderColor: t.border, backgroundColor: t.accentSoft }]} testID="branch-filter-bar">
          <Icon name="filter" size={12} color={t.accent} />
          <Txt size={FONT.sm} color={t.accent} style={{ marginLeft: 6, marginRight: 6 }}>
            {graphFilter.mode === 'current' ? 'Current branch only' : 'Showing only'}
          </Txt>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center' }}>
            {graphFilter.mode === 'selected' &&
              graphFilter.refs.map((name) => (
                <View key={name} style={[styles.filterChip, { borderColor: t.accent }]} testID={`filter-chip-${name}`}>
                  <Icon name={repo.refs.find((r) => r.name === name)?.kind === 'remote' ? 'cloud' : repo.refs.find((r) => r.name === name)?.kind === 'tag' ? 'tag' : 'branch'} size={10} color={t.accent} />
                  <Txt size={FONT.xs} color={t.text} style={{ marginLeft: 4 }}>
                    {name}
                  </Txt>
                  <PressScale onPress={() => toggleBranchFilter(name)} scaleTo={0.85} style={{ marginLeft: 4, padding: 1 }} label={`Remove ${name} from the filter`}>
                    <Icon name="x" size={10} color={t.textMuted} />
                  </PressScale>
                </View>
              ))}
          </ScrollView>
          <Button small label="Clear filter" icon="x" onPress={clearBranchFilter} testID="clear-branch-filter" />
        </View>
      )}
      {history && (
        <View style={[styles.historyBar, { borderColor: t.border, backgroundColor: t.accentSoft }]}>
          <Icon name="history" size={12} color={t.accent} />
          <Txt size={FONT.sm} color={t.accent} style={{ marginLeft: 6, flex: 1 }} numberOfLines={1}>
            History of {repo.historyPath} · {history.length} commits
          </Txt>
          <Button small label="Close" icon="x" onPress={live.clearFileHistory} />
        </View>
      )}
      <View style={[styles.header, { borderColor: t.border }]}>
        <View style={{ width: graphW }} />
        <Txt label faint size={10} style={{ flex: 1 }}>
          Description
        </Txt>
        {!mods.hideAuthor && (
          <Txt label faint size={10} style={colStyles.author}>
            Author
          </Txt>
        )}
        <Txt label faint size={10} style={colStyles.date}>
          Date
        </Txt>
        <Txt label faint size={10} style={colStyles.sha}>
          SHA
        </Txt>
      </View>
      <ScrollView
        ref={scrollRef}
        testID="commit-scroll"
        style={{ flex: 1 }}
        onLayout={win.onLayout}
        scrollEventThrottle={16}
        onScroll={(e) => {
          win.onScroll(e);
          scrollY.current = e.nativeEvent.contentOffset.y;
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          if (repo.live && contentOffset.y + layoutMeasurement.height > contentSize.height - 600) void live.loadMoreCommits();
        }}
      >
        <View style={{ height: list.length * ROW }}>
          {list.slice(win.first, win.last).map((c, k) => {
            const i = win.first + k;
            return (
            <View key={c.sha} style={rowTop(i, ROW)}>
            <CommitRow
              key={c.sha}
              commit={c}
              row={layout?.rows[i]}
              graphW={graphW}
              refs={refsBySha.get(c.sha)}
              selected={c.sha === selectedCommit && repo.selectedArea === 'commit'}
              isHead={c.sha === head}
              offBranch={!!onBranch && c.sha !== WIP && !onBranch.has(c.sha)}
              changes={changes}
              hiddenCount={collapsed.hiddenBy.get(c.sha) ?? 0}
              isCollapsed={!!collapsedMerges[c.sha]}
              hideAuthor={mods.hideAuthor}
              absDates={mods.absoluteDates}
            />
            </View>
            );
          })}
          {/* above the rows (clicks pass through): the selected row's highlight must not hide its node */}
          {layout && <GraphSvg layout={layout} first={win.first} last={win.last} width={graphW} head={head} wipIndex={list[0]?.sha === WIP ? 0 : -1} selectedIndex={selectedIndex} collapsed={collapsedMerges} gw={mods.graphWidth} />}
        </View>
        <View>
          {list.length === 0 && (
            <Txt faint style={{ padding: 16 }}>
              No commits match the current filter.
            </Txt>
          )}
          {repo.loadingMore && (
            <Txt faint size={FONT.xs} style={{ padding: 8 }}>
              loading more…
            </Txt>
          )}
          {/* a shallow clone ends at a grafted commit: say so where the history stops, and offer the rest */}
          {repo.shallow && !repo.loadingMore && (repo.filteredCommits ? repo.filterExhausted : repo.logExhausted) && list.length > 0 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8 }} testID="shallow-end">
              <Icon name="history" size={11} color={t.warn} />
              <Txt size={FONT.xs} color={t.warn} style={{ marginLeft: 6 }}>
                shallow clone — the history ends here
              </Txt>
              <Button small label="Fetch full history" style={{ marginLeft: 8 }} onPress={() => unshallow()} testID="shallow-end-fetch" />
            </View>
          )}
        </View>
      </ScrollView>
      {filterOpen && <FilterPopover onClose={() => setFilterOpen(false)} />}
    </View>
  );
}

// ---------- graph (one SVG for the whole list, so lines never break between rows) ----------

/** draws rows `first`..`last` only: the SVG sits at the first row's offset and has their height */
const GraphSvg = memo(function GraphSvg({ layout, first, last, width, head, wipIndex, selectedIndex, collapsed, gw }: { layout: GraphLayout; first: number; last: number; width: number; head: Sha; wipIndex: number; selectedIndex: number; collapsed: Record<Sha, boolean>; gw: number }) {
  const t = useTheme();
  const x = (lane: number) => 4 + Math.min(lane, MAX_LANES - 1) * LANE_W + LANE_W / 2;
  const col = (i: number) => t.lanes[i % t.lanes.length];
  const h = ROW;
  const lines: React.ReactNode[] = [];
  const nodes: React.ReactNode[] = [];
  for (let i = first; i < Math.min(last, layout.rows.length); i++) {
    const row = layout.rows[i];
    const y0 = (i - first) * h;
    const cy = y0 + h / 2;
    const cx = x(row.lane);
    const isWip = i === wipIndex;
    const isHead = row.sha === head;
    const c = col(row.color);
    const GW = gw;
    // the selected row is filled with the selection colour: a dark outline keeps lines and the node visible on it,
    // even in the same colour
    const sel = i === selectedIndex;
    const halo = (el: React.ReactElement<any>, key: string) => (sel ? lines.push(React.cloneElement(el, { key: `h-${key}`, stroke: t.panel, strokeWidth: GW + 2.5, strokeDasharray: undefined })) : 0);
    const seg = (el: React.ReactElement<any>, key: string) => {
      halo(el, key);
      lines.push(React.cloneElement(el, { key }));
    };
    for (const p of row.passThrough) seg(<Line x1={x(p.lane)} y1={y0} x2={x(p.lane)} y2={y0 + h} stroke={col(p.color)} strokeWidth={GW} />, `p${i}-${p.lane}`);
    if (row.hasIncoming) seg(<Line x1={cx} y1={y0} x2={cx} y2={cy} stroke={c} strokeWidth={GW} />, `in${i}`);
    for (const m of row.mergeIn) seg(<Path d={`M ${x(m.lane)} ${y0} C ${x(m.lane)} ${y0 + h * 0.55}, ${cx} ${y0 + h * 0.2}, ${cx} ${cy}`} stroke={col(m.color)} strokeWidth={GW} fill="none" />, `m${i}-${m.lane}`);
    for (const o of row.out) {
      if (o.lane === row.lane) seg(<Line x1={cx} y1={cy} x2={cx} y2={y0 + h} stroke={col(o.color)} strokeWidth={GW} strokeDasharray={isWip ? '2 3' : undefined} />, `o${i}-${o.lane}`);
      else seg(<Path d={`M ${cx} ${cy} C ${cx} ${y0 + h * 0.85}, ${x(o.lane)} ${y0 + h * 0.45}, ${x(o.lane)} ${y0 + h}`} stroke={col(o.color)} strokeWidth={GW} fill="none" />, `o${i}-${o.lane}`);
    }
    // a dark ring under the node of the selected row
    if (sel) {
      if (row.isMerge || collapsed[row.sha]) nodes.push(<Rect key={`ring${i}`} x={cx - 7} y={cy - 7} width={14} height={14} fill={t.panel} />);
      else nodes.push(<Polygon key={`ring${i}`} points={`${cx},${cy - 7} ${cx + 7},${cy} ${cx},${cy + 7} ${cx - 7},${cy}`} fill={t.panel} />);
    }
    // nodes are diamonds (terminal system): filled = commit, hollow = HEAD, "+"/"−" square = merge
    const R = 3.6;
    const diamond = `${cx},${cy - R} ${cx + R},${cy} ${cx},${cy + R} ${cx - R},${cy}`;
    if (isWip) nodes.push(<Polygon key={`n${i}`} points={diamond} stroke={c} strokeWidth={1.2} fill={t.panel} strokeDasharray="2 2" />);
    else if (collapsed[row.sha]) {
      nodes.push(
        <React.Fragment key={`n${i}`}>
          <Path d={`M ${cx} ${cy} C ${cx + 6} ${cy + 2}, ${cx + 8} ${cy + 6}, ${cx + 9} ${cy + 11}`} stroke={c} strokeWidth={GW} fill="none" strokeDasharray="2 2" />
          <Rect x={cx - 5} y={cy - 5} width={10} height={10} fill={c} />
          <Line x1={cx - 3} y1={cy} x2={cx + 3} y2={cy} stroke={t.panel} strokeWidth={1.4} />
          <Line x1={cx} y1={cy - 3} x2={cx} y2={cy + 3} stroke={t.panel} strokeWidth={1.4} />
        </React.Fragment>,
      );
    } else if (row.isMerge) {
      nodes.push(
        <React.Fragment key={`n${i}`}>
          <Rect x={cx - 5} y={cy - 5} width={10} height={10} stroke={c} strokeWidth={1.5} fill={t.panel} />
          <Line x1={cx - 2.5} y1={cy} x2={cx + 2.5} y2={cy} stroke={c} strokeWidth={1.4} />
        </React.Fragment>,
      );
    } else if (isHead) {
      const R2 = 5;
      nodes.push(<Polygon key={`n${i}`} points={`${cx},${cy - R2} ${cx + R2},${cy} ${cx},${cy + R2} ${cx - R2},${cy}`} stroke={c} strokeWidth={1.6} fill={t.panel} />);
    } else nodes.push(<Polygon key={`n${i}`} points={diamond} fill={c} />);
  }
  return (
    <View style={{ position: 'absolute', left: 0, top: first * h }} pointerEvents="none">
      <Svg width={width} height={Math.max(0, Math.min(last, layout.rows.length) - first) * h}>
        {lines}
        {nodes}
      </Svg>
    </View>
  );
});

// ---------- rows ----------

const CommitRow = memo(function CommitRow({ commit, row, graphW, refs, selected, isHead, offBranch, changes, hiddenCount, isCollapsed, hideAuthor, absDates }: {
  commit: Commit;
  row?: GraphRow;
  graphW: number;
  refs?: Ref[];
  selected: boolean;
  isHead: boolean;
  /** not reachable from HEAD: drawn grey */
  offBranch?: boolean;
  changes: number;
  hiddenCount: number;
  isCollapsed: boolean;
  hideAuthor?: boolean;
  absDates?: boolean;
}) {
  const t = useTheme();
  const isWip = commit.sha === WIP;
  const isMerge = commit.parents.length > 1 || isCollapsed;
  const onContext = (x: number, y: number) => {
    if (isWip) return;
    const s = getState();
    const repo = s.repoStates[s.activeTab ?? ''];
    const current = repo.refs.find((b) => b.kind === 'branch' && b.current);
    showContextMenu(x, y, [
      ...(isMerge
        ? [
            { label: isCollapsed ? 'Expand merge' : 'Collapse merge', shortcut: isCollapsed ? '→' : '←', onPress: () => toggleMerge(commit.sha) },
            { label: 'Collapse all merges', onPress: collapseAllMerges },
            { label: 'Expand all merges', onPress: expandAllMerges },
            { separator: true },
          ]
        : []),
      { label: `Checkout ${shortSha(commit.sha)} (detached)`, onPress: () => (repo.live ? live.checkoutDetached(commit.sha) : toast(`Detached HEAD at ${shortSha(commit.sha)} (mock)`, 'info')) },
      { label: 'Create branch here…', onPress: () => openDialog({ type: 'branch', fromSha: commit.sha }) },
      { label: 'Create tag…', onPress: () => openDialog({ type: 'tag', sha: commit.sha }) },
      { separator: true },
      { label: 'Cherry-pick', onPress: () => cherryPick(commit.sha), disabled: isHead },
      { label: 'Revert', onPress: () => revert(commit.sha) },
      { label: `Reset ${current?.name ?? 'HEAD'} to here…`, onPress: () => openDialog({ type: 'reset', sha: commit.sha }), disabled: isHead },
      { separator: true },
      {
        label: `Rebase ${current?.name ?? ''} onto here`,
        onPress: () => {
          const ref = repo.refs.find((r) => r.sha === commit.sha && r.kind !== 'tag');
          if (ref) openDialog({ type: 'rebase', onto: ref.name });
          else if (repo.live) openDialog({ type: 'rebase', fromSha: commit.sha });
          else toast('Pick a commit with a branch label (mock limitation)', 'error');
        },
        disabled: isHead,
      },
      { label: 'Interactive rebase from here…', onPress: () => openDialog({ type: 'rebase', interactive: true, fromSha: commit.sha }), disabled: isHead || commitsToRebase(repo, commit.sha).length === 0 },
      { separator: true },
      { label: 'Copy SHA', shortcut: '⌘⇧C', onPress: () => copy(commit.sha) },
      { label: 'Copy message', onPress: () => copy(commit.subject) },
    ]);
  };
  const nodeX = row ? 4 + Math.min(row.lane, MAX_LANES - 1) * LANE_W + LANE_W / 2 : 0;
  return (
    <Row
      height={ROW}
      selected={selected}
      onPress={() => (isWip ? setSection('changes') : selectCommit(commit.sha))}
      // a double click switches to the commit's branch: one → at once, several → a menu where the pointer is,
      // only a remote one → its local branch (created to track it); a merge without branches folds
      onDoublePress={(at) => {
        if (isWip) return;
        const locals = (refs ?? []).filter((r) => r.kind === 'branch');
        const others = locals.filter((r) => !r.current);
        const remotes = (refs ?? []).filter((r) => r.kind === 'remote' && !r.name.endsWith('/HEAD') && !locals.some((l) => l.upstream === r.name || r.name.endsWith('/' + l.name)));
        const choices = [...others.map((r) => r.name), ...remotes.map((r) => r.name)];
        if (choices.length === 1) return checkout(choices[0]);
        if (choices.length > 1) return showContextMenu(at.x, at.y, choices.map((n) => ({ label: `Switch to ${n}`, onPress: () => checkout(n) })));
        if (!locals.length && isMerge) toggleMerge(commit.sha);
      }}
      onContextMenu={onContext}
      testID={selected ? 'selected-commit' : undefined}
      style={{ paddingLeft: graphW, paddingRight: 8, backgroundColor: selected ? t.selection : 'transparent' }}
    >
      {row && isMerge && !isWip && (
        <Pressable
          onPress={() => toggleMerge(commit.sha)}
          style={[{ position: 'absolute', left: nodeX - 9, top: ROW / 2 - 9, width: 18, height: 18, borderRadius: 0 }, webCursor('pointer')]}
          {...({ accessibilityLabel: isCollapsed ? 'Expand merge' : 'Collapse merge' } as any)}
        />
      )}
      <View style={{ flex: 2, minWidth: 120, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' }}>
        {refs && refLabels(refs).map((l) => <RefChip key={l.ref.name} r={l.ref} label={l} />)}
        {isWip ? (
          <Txt size={FONT.md} color={t.textMuted} style={{ fontStyle: 'italic' }} numberOfLines={1}>
            Uncommitted changes ({changes})
          </Txt>
        ) : (
          <Txt size={FONT.md} weight={isHead ? '700' : '400'} faint={offBranch} numberOfLines={1} style={{ flexShrink: 1 }} testID={isHead ? 'head-commit' : offBranch ? 'off-branch-commit' : undefined}>
            {commit.subject}
          </Txt>
        )}
        {hiddenCount > 0 && (
          <PressScale onPress={() => toggleMerge(commit.sha)} scaleTo={0.95} style={{ marginLeft: 6 }}>
            <Txt size={10.5} muted>
              {`(+${hiddenCount} hidden)`}
            </Txt>
          </PressScale>
        )}
      </View>
      {!isWip && (
        <>
          {!hideAuthor && (
            <View style={[colStyles.author, { flexDirection: 'row', alignItems: 'center', opacity: offBranch ? 0.55 : 1 }]}>
              <Avatar name={commit.author} email={commit.email} size={16} />
              <Txt size={FONT.sm} muted={!offBranch} faint={offBranch} weight={isHead ? '700' : '400'} numberOfLines={1} style={{ marginLeft: 6, flex: 1 }}>
                {commit.author}
              </Txt>
            </View>
          )}
          <Txt size={FONT.sm} muted={!offBranch} faint={offBranch} weight={isHead ? '700' : '400'} style={colStyles.date} numberOfLines={1}>
            {absDates ? shortDate(commit.date) : relTime(commit.date)}
          </Txt>
          <Txt size={FONT.sm} faint mono style={colStyles.sha}>
            {shortSha(commit.sha)}
          </Txt>
        </>
      )}
    </Row>
  );
});

// ---------- branch filter popover ----------

function FilterPopover({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const repo = useRepo();
  const vp = useViewport();
  const [q, setQ] = useState('');
  const [size, setSize] = useState({ w: 320, listH: 200 });
  const f = repo.graphFilter;
  const refs = repo.refs.filter((r) => r.kind !== 'stash' && r.name !== 'origin/HEAD' && r.name.toLowerCase().includes(q.toLowerCase()));
  const groups: { title: string; kind: Ref['kind'] }[] = [
    { title: 'Local branches', kind: 'branch' },
    { title: 'Remote branches', kind: 'remote' },
    { title: 'Tags', kind: 'tag' },
  ];
  const isOn = (name: string) => (f.mode === 'selected' ? f.refs.includes(name) : f.mode === 'all' ? !(f.hideRemotes && repo.refs.find((r) => r.name === name)?.kind === 'remote') : !!repo.refs.find((r) => r.name === name)?.current);
  return (
    <>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <Glass style={[styles.popover, { width: size.w }]}>
        <Segmented
          value={f.mode}
          onChange={(mode) => setGraphFilter({ mode, refs: mode === 'selected' && f.refs.length === 0 ? repo.refs.filter((r) => r.kind === 'branch').map((r) => r.name) : f.refs })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'current', label: 'Current' },
            { value: 'selected', label: 'Selected' },
          ]}
        />
        <View style={{ marginTop: 8 }}>
          <Checkbox checked={f.hideRemotes} onChange={(v) => setGraphFilter({ hideRemotes: v })} label="Hide remote branches" />
        </View>
        <View style={{ marginTop: 8 }}>
          <Input value={q} onChange={setQ} placeholder="filter refs" slash small autoFocus />
        </View>
        <ScrollView style={{ maxHeight: size.listH, marginTop: 6 }}>
          {groups.map((g) => {
            const items = refs.filter((r) => r.kind === g.kind);
            if (items.length === 0) return null;
            return (
              <View key={g.kind} style={{ marginTop: 4 }}>
                <Txt label faint style={{ paddingVertical: 4 }}>
                  {g.title}
                </Txt>
                {items.map((r) => (
                  <Row key={r.name} height={24} onPress={() => toggleGraphRef(r.name)} style={{ paddingLeft: 2, borderRadius: 0 }}>
                    <Checkbox checked={isOn(r.name)} onChange={() => toggleGraphRef(r.name)} />
                    <Icon name={g.kind === 'remote' ? 'cloud' : g.kind === 'tag' ? 'tag' : 'branch'} size={11} color={r.current ? t.accent : t.textFaint} />
                    <Txt size={FONT.sm} style={{ marginLeft: 6, flex: 1 }} numberOfLines={1} weight={r.current ? '600' : '400'}>
                      {r.name}
                    </Txt>
                  </Row>
                ))}
              </View>
            );
          })}
        </ScrollView>
        <View style={{ flexDirection: 'row', marginTop: 8 }}>
          <Button small label="Select all" onPress={() => setGraphFilter({ mode: 'selected', refs: repo.refs.filter((r) => r.kind !== 'stash' && r.name !== 'origin/HEAD').map((r) => r.name) })} />
          <Button small label="None" style={{ marginLeft: 6 }} onPress={() => setGraphFilter({ mode: 'selected', refs: [] })} />
          <View style={{ flex: 1 }} />
          <Button small primary label="Done" onPress={onClose} />
        </View>
        <ResizeGrip onDelta={(dx, dy) => setSize((s) => ({ w: Math.max(260, Math.min(vp.width - 420, s.w + dx)), listH: Math.max(80, Math.min(vp.height - 260, s.listH + dy)) }))} />
      </Glass>
    </>
  );
}

function shortDate(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function copy(text: string) {
  live.copyText(text);
}

export function RefChip({ r, onPress, compact, label }: { r: Ref; onPress?: () => void; compact?: boolean; label?: RefLabel }) {
  const t = useTheme();
  const inverted = useSelected();
  const isCurrent = !!r.current;
  const remote = label ? label.remote : r.kind === 'remote';
  const remoteOnly = label ? label.remoteOnly : r.kind === 'remote';
  // [name] in the ref's colour; the current branch is a filled block; a cloud marks a branch that is on the
  // remote too (Fork's origin icon). Inside an inverted row everything flips.
  const base = r.kind === 'tag' ? t.tag : remoteOnly ? t.textMuted : t.accent;
  const fg = inverted ? (isCurrent ? t.accent : t.selectionText) : base;
  const bg = isCurrent ? (inverted ? t.selectionText : t.accent) : 'transparent';
  const textColor = isCurrent ? (inverted ? t.accent : t.accentText) : fg;
  const open = r.kind === 'tag' ? '<' : '[';
  const closeB = r.kind === 'tag' ? '>' : ']';
  const name = label?.name ?? r.name;
  return (
    <PressScale onPress={onPress} scaleTo={0.96} style={[styles.chip, { backgroundColor: bg, borderColor: isCurrent ? bg : fg }]} testID={`ref-${name}`} label={remote ? (remoteOnly ? `${name} (remote)` : `${name} · also on ${r.upstream ?? 'origin'}`) : name}>
      {!isCurrent && (
        <Txt size={10.5} color={fg} style={{ opacity: 0.55 }}>
          {open}
        </Txt>
      )}
      {remote && (
        // bright on its own: in the info colour on a plain label, the label's text colour where it is filled
        <View style={{ marginRight: 4 }} testID={`ref-cloud-${name}`}>
          <Icon name="cloud" size={11} strokeWidth={2.4} color={isCurrent || inverted ? textColor : t.info} />
        </View>
      )}
      <Txt size={10.5} color={textColor} weight="600" numberOfLines={1}>
        {compact ? name.split('/').pop() : name}
      </Txt>
      {!compact && isCurrent && (r.ahead || r.behind) ? (
        <Txt size={10} color={textColor} style={{ marginLeft: 4, opacity: 0.85 }}>
          {r.ahead ? `↑${r.ahead}` : ''}
          {r.behind ? `↓${r.behind}` : ''}
        </Txt>
      ) : null}
      {!isCurrent && (
        <Txt size={10.5} color={fg} style={{ opacity: 0.55 }}>
          {closeB}
        </Txt>
      )}
    </PressScale>
  );
}

// subject takes the rest; the three metadata columns shrink on narrow windows
const colStyles = StyleSheet.create({
  author: { flexBasis: 150, flexShrink: 1, minWidth: 64, maxWidth: 150 },
  date: { width: 76 },
  sha: { width: 60 },
});

const styles = StyleSheet.create({
  filterChip: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, paddingHorizontal: 6, height: 20, marginRight: 6 },
  filterBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, height: 32, borderBottomWidth: 1 },
  historyBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, height: 28, borderBottomWidth: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 22, borderBottomWidth: 1, paddingRight: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, height: 16, marginRight: 5, borderWidth: 1 },
  popover: { position: 'absolute', top: 32, left: 396, padding: 10, paddingBottom: 16, zIndex: 20 },
});
