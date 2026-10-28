import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AgentBar } from './AgentBar';
import { fitWidths, groupTabs, naturalTabWidth, TabOut } from './tabLayout';
import { activateTab, closeTab, fetch, followAllBranches, goWelcome, openDialog, openRepoPicker, pull, push, setState, showContextMenu, switchWorkspace, toast, toggleTabGroup, unshallow, useMods, useRepo, useStore } from '../state/store';
import { FONT, TABS_H, TOOLBAR_H, useTheme } from '../theme';
import { desktop, openInTerminal, revealInFinder } from '../desktop';
import * as live from '../state/live';
import { Icon } from '../ui/Icon';
import { Divider, Glass, HoverReveal, IconButton, PressScale, revealIn, Row, ToolButton, Txt, useKeyboard, useViewport } from '../ui/primitives';
import { StatusPanel } from './StatusPanel';

export function RepoTabs() {
  const t = useTheme();
  const screen = useStore((s) => s.screen);
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = useStore((s) => s.activeWorkspace);
  const wsName = workspaces.find((w) => w.id === activeWs)?.name ?? activeWs;
  const [wsOpen, setWsOpen] = useState(false);
  return (
    <View style={[styles.tabs, { backgroundColor: t.bg, borderColor: t.border, zIndex: 50 }]}>
      <PressScale onPress={() => setWsOpen((v) => !v)} scaleTo={0.97} style={[styles.ws, wsOpen && { backgroundColor: t.accentSoft }]} hoverStyle={{ backgroundColor: t.hover }} label="Workspace" testID="workspace-button">
        <Txt size={FONT.xs} color={t.accent} weight="700">
          @
        </Txt>
        <Txt label size={FONT.xs} style={{ marginLeft: 4 }}>
          {wsName}
        </Txt>
        <View style={{ marginLeft: 4 }}>
          <Icon name={wsOpen ? 'chevronDown' : 'chevronRight'} size={10} />
        </View>
      </PressScale>
      {wsOpen && <WorkspacePopover onClose={() => setWsOpen(false)} />}
      <PressScale onPress={goWelcome} testID="home-button" label="Repositories" scaleTo={0.9} style={[styles.homeBtn, screen === 'welcome' && { backgroundColor: t.accentSoft }]} hoverStyle={{ backgroundColor: t.hover }}>
        <Icon name="home" size={14} color={screen === 'welcome' ? t.accent : t.textMuted} />
      </PressScale>
      <TabStrip />
      <GlobalButtons />
    </View>
  );
}

const CHAR_W = FONT.sm * 0.6; // JetBrains Mono advance
const CHAR_W_NESTED = FONT.xs * 0.6;
const PLUS_W = 30;
/** frame borders, inner padding and the fold toggle of a tab group */
const GROUP_CHROME = 30;
const MAX_TAB = 240;
/** the gap after each tab (styles.tab marginRight): part of what the bar has to hold */
const TAB_GAP = 2;

/** the scrollable DOM node of a ScrollView (web) */
const scrollNode = (sv: any): HTMLElement | null => (Platform.OS === 'web' ? (sv?.getScrollableNode?.() ?? null) : null);

/**
 * Open repositories as tabs. Submodules (any open repository inside another open one) are grouped right after
 * their parent: the active group shows them as sub-tabs labelled by relative path, other groups fold them into
 * a "+N" badge with a menu. Widths fit the bar: natural size when there is room, the widest shrink first, then
 * the bar scrolls and keeps the active tab in view.
 */
function TabStrip() {
  const t = useTheme();
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.activeTab);
  const repos = useStore((s) => s.repos);
  const screen = useStore((s) => s.screen);
  const states = useStore((s) => s.repoStates);
  const folded = useStore((s) => s.collapsedTabGroups);
  const [avail, setAvail] = useState(0);
  const scroll = useRef<any>(null);
  const grouped = useMemo(() => groupTabs(tabs.map((id) => ({ id, path: repos.find((r) => r.id === id)?.path ?? '', name: repos.find((r) => r.id === id)?.name ?? id }))), [tabs, repos]);
  // like Chrome tab groups: a group stays open until the user folds it; the active tab always shows
  const visible = grouped.filter((g) => !g.parent || !folded[g.parent] || g.id === active);
  const isGroup = (g: TabOut) => !g.parent && g.children.length > 0;
  const natural = visible.map((g) => Math.min(MAX_TAB, naturalTabWidth(g.label, { charW: g.parent ? CHAR_W_NESTED : CHAR_W, nested: !!g.parent, active: g.id === active, badge: isGroup(g) && folded[g.id] ? g.children.filter((c) => c !== active).length : 0 })));
  // minimums keep ~7 characters readable; the active tab keeps its whole name up to 160 px
  const mins = visible.map((g, i) => (g.id === active ? Math.min(natural[i], 160) : g.parent ? 84 : 96));
  // the gaps after the tabs count too: without them the tabs overflowed the bar while it thought they fitted (and
  // did not scroll), cutting the active tab off
  const chrome = visible.filter(isGroup).length * GROUP_CHROME + visible.length * TAB_GAP;
  const { widths } = fitWidths(natural, Math.max(0, avail - PLUS_W - chrome), mins);
  // keep the active tab in view when the bar scrolls (measured: groups and gaps included)
  const shownWidths = widths.join(',');
  useEffect(() => {
    revealIn(scrollNode(scroll.current), 'activetab', 'x', 40);
  }, [active, shownWidths, avail, screen]);
  // a mouse wheel scrolls the bar sideways (a plain wheel could not reach the tabs scrolled away)
  useEffect(() => {
    const node = scrollNode(scroll.current);
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || node.scrollWidth <= node.clientWidth) return;
      node.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);
  const closeGroup = (id: string) => {
    for (const c of grouped.find((g) => g.id === id)?.children ?? []) closeTab(c);
    closeTab(id);
  };
  const menu = (g: TabOut, x: number, y: number) =>
    showContextMenu(x, y, [
      { label: 'Close', onPress: () => closeTab(g.id) },
      ...(g.children.length ? [{ label: `Close with submodules (${g.children.length + 1})`, onPress: () => closeGroup(g.id) }, { label: folded[g.id] ? 'Expand group' : 'Collapse group', onPress: () => toggleTabGroup(g.id) }] : []),
      { label: 'Close others', onPress: () => tabs.filter((x) => x !== g.id && x !== g.parent).forEach(closeTab) },
      { separator: true },
      { label: 'Reveal in Finder', onPress: () => live.revealPath(g.path) },
      { label: 'Copy path', onPress: () => live.copyText(g.path) },
    ]);
  // a group = the parent tab and its submodule tabs inside one frame
  const segments: { root: TabOut; kids: TabOut[]; at: number }[] = [];
  visible.forEach((g, i) => {
    if (!g.parent) segments.push({ root: g, kids: [], at: i });
    else segments[segments.length - 1]?.kids.push(g);
  });
  const tab = (g: TabOut) => {
    const i = visible.indexOf(g);
    const st = states[g.id];
    return <TabItem key={g.id} g={g} width={widths[i]} active={g.id === active && screen === 'repo'} changes={st ? st.unstaged.length + st.staged.length : 0} onMenu={(x, y) => menu(g, x, y)} />;
  };
  return (
    <View style={{ flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'flex-end' }} onLayout={(e) => setAvail(e.nativeEvent.layout.width)}>
      <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ alignItems: 'flex-end' }}>
        {segments.map(({ root, kids }) => {
          if (!isGroup(root)) return tab(root);
          const isFolded = !!folded[root.id];
          const hidden = root.children.length - kids.length;
          const inGroup = active === root.id || root.children.includes(active ?? '');
          const color = inGroup && screen === 'repo' ? t.accent : t.borderStrong;
          return (
            <View key={root.id} testID={`tab-group-${root.label}`} style={[styles.group, { borderColor: color }]}>
              {tab(root)}
              {kids.map(tab)}
              <PressScale
                testID={`tab-group-toggle-${root.label}`}
                onPress={() => toggleTabGroup(root.id)}
                scaleTo={0.9}
                style={styles.groupToggle}
                hoverStyle={{ backgroundColor: t.hover }}
                label={isFolded ? `Show ${hidden} submodule tab${hidden === 1 ? '' : 's'}` : 'Collapse the group'}
              >
                <Txt size={10} color={color} weight="700">
                  {isFolded ? `+${hidden} ›` : '‹'}
                </Txt>
              </PressScale>
            </View>
          );
        })}
      </ScrollView>
      {/* after the tabs, outside the scrolling part: with more tabs than fit it stays at hand (it used to scroll away) */}
      <PressScale onPressAt={(a) => openRepoPicker(a.x, a.y + a.h + 4)} scaleTo={0.9} style={styles.homeBtn} hoverStyle={{ backgroundColor: t.hover }} label="Open a repository (⌘T)" testID="new-tab">
        <Icon name="plus" size={14} />
      </PressScale>
    </View>
  );
}

/** one repository tab; a submodule tab points back at its parent with an arrow */
function TabItem({ g, width, active, changes, onMenu }: { g: TabOut; width: number; active: boolean; changes: number; onMenu: (x: number, y: number) => void }) {
  const t = useTheme();
  const nested = !!g.parent;
  return (
    <PressScale
      testID={`tab-${g.label}`}
      onPress={() => activateTab(g.id)}
      onContextMenu={onMenu}
      scaleTo={1}
      label={g.path}
      style={[styles.tab, { width, minWidth: 0, backgroundColor: active ? t.panel : nested ? t.panelAlt : 'transparent', borderColor: active ? t.border : 'transparent' }, nested && { height: TABS_H - 8, marginRight: 1 }]}
      hoverStyle={!active ? { backgroundColor: t.hover } : undefined}
    >
      {({ hovered }) => (
        <>
          {nested ? (
            <Txt size={FONT.sm} color={active ? t.accent : t.textMuted} weight="700" testID={`tab-arrow-${g.label}`}>
              ←
            </Txt>
          ) : (
            <Txt size={FONT.sm} color={active ? t.accent : 'transparent'} weight="700">
              ▸
            </Txt>
          )}
          <View style={{ flex: 1, minWidth: 0, marginLeft: 5 }}>
            <Txt size={nested ? FONT.xs : FONT.sm} weight={active ? '600' : '400'} muted={!active} numberOfLines={1} testID={active ? 'active-tab-label' : undefined}>
              {g.label}
            </Txt>
          </View>
          {changes > 0 && <View style={{ width: 6, height: 6, backgroundColor: t.warn, marginLeft: 6 }} />}
          {/* the active tab keeps room for its close button; the others show it over the label end on hover. It
              stays mounted (HoverReveal): one that existed only while the tab was hovered vanished as the pointer
              reached it, and it was drawn in a box of no size, so it never showed at all */}
          {active ? (
            <PressScale onPress={() => closeTab(g.id)} scaleTo={0.8} style={{ marginLeft: 6, padding: 2 }} hoverStyle={{ backgroundColor: t.hover }} label="Close" testID={`close-tab-${g.label}`}>
              <Icon name="x" size={11} />
            </PressScale>
          ) : (
            <View style={{ position: 'absolute', right: 3, top: 0, bottom: 0, justifyContent: 'center' }} pointerEvents="box-none">
              <HoverReveal rowHovered={hovered}>
                <PressScale onPress={() => closeTab(g.id)} scaleTo={0.8} style={{ paddingHorizontal: 3, paddingVertical: 2, backgroundColor: t.raised }} hoverStyle={{ backgroundColor: t.borderStrong }} label="Close" testID={`close-tab-${g.label}`}>
                  <Icon name="x" size={11} />
                </PressScale>
              </HoverReveal>
            </View>
          )}
          {active ? <View {...({ dataSet: { activetab: '1' } } as any)} style={StyleSheet.absoluteFill} pointerEvents="none" /> : null}
        </>
      )}
    </PressScale>
  );
}

/** Scheme / accounts / preferences: live in the tab bar so they are reachable from every screen. */
/** Agent, accounts and preferences: in the tab bar so they are reachable from every screen. The colour scheme
 * lives in Preferences → General and the command palette. */
function GlobalButtons() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3, marginLeft: 8 }}>
      <AgentBar />
      <View style={{ width: 6 }} />
      <IconButton icon="user" title="Accounts" onPress={() => openDialog({ type: 'accounts', tab: 'github' })} />
      <IconButton icon="settings" title="Preferences (⌘,)" onPress={() => openDialog({ type: 'accounts', tab: 'general' })} />
    </View>
  );
}

/** Anchored under the @workspace button: the workspaces to switch to, then new / settings. */
function WorkspacePopover({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const { width, height } = useViewport();
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = useStore((s) => s.activeWorkspace);
  const activeName = workspaces.find((w) => w.id === activeWs)?.name ?? activeWs;
  useKeyboard((e) => {
    if (e.key === 'Escape') onClose();
  });
  const act = (fn: () => void) => {
    onClose();
    fn();
  };
  return (
    <>
      <Pressable style={{ position: 'absolute', left: 0, top: 0, width, height }} onPress={onClose} />
      <Glass style={[styles.wsPop, { top: TABS_H - 2, left: 6, paddingVertical: 4 }]}>
        <ScrollView style={{ maxHeight: Math.max(120, height - 120) }} testID="workspace-menu">
          {workspaces.map((w) => {
            const active = w.id === activeWs;
            return (
              <Row key={w.id} height={26} onPress={() => act(() => switchWorkspace(w.id))} style={{ paddingLeft: 10 }}>
                <View style={{ width: 16 }}>{active && <Icon name="check" size={12} color={t.accent} />}</View>
                <Txt size={FONT.sm} color={active ? t.accent : undefined} weight={active ? '600' : '400'} numberOfLines={1}>
                  @{w.name}
                </Txt>
              </Row>
            );
          })}
        </ScrollView>
        <View style={{ height: 1, backgroundColor: t.border, marginVertical: 4 }} />
        <Row height={26} onPress={() => act(() => openDialog({ type: 'workspace' }))} style={{ paddingLeft: 10 }}>
          <View style={{ width: 16 }}>
            <Icon name="plus" size={12} />
          </View>
          <Txt size={FONT.sm}>New workspace…</Txt>
        </Row>
        <Row height={26} onPress={() => act(() => openDialog({ type: 'workspace', id: activeWs }))} style={{ paddingLeft: 10 }}>
          <View style={{ width: 16 }}>
            <Icon name="settings" size={12} />
          </View>
          <Txt size={FONT.sm} numberOfLines={1}>
            @{activeName} settings…
          </Txt>
        </Row>
      </Glass>
    </>
  );
}

export function Toolbar() {
  const t = useTheme();
  const repo = useRepo();
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const op = useStore((s) => s.operation);
  const vp = useViewport();
  const mods = useMods();
  const repoPath = useStore((s) => s.repos.find((r) => r.id === s.activeTab)?.path);
  const isLive = useStore((s) => !!s.repos.find((r) => r.id === s.activeTab)?.live);
  const pullMode = useStore((s) => s.serverSettings?.pullMode ?? 'merge');
  const undoTop = useStore((s) => (s.activeTab ? s.undo[s.activeTab]?.at(-1) : undefined));
  const show = (k: string) => !mods.hiddenToolbarButtons.includes(k);
  // a narrow window keeps the buttons as icons, so the status panel keeps its room
  const compact = mods.compactToolbar || vp.width < 1000;
  const current = repo.refs.find((r) => r.kind === 'branch' && r.current);
  // changed files: one staged and edited again is one (it used to count twice)
  const changes = useMemo(() => new Set([...repo.unstaged.map((f) => f.path), ...repo.staged.map((f) => f.path)]).size, [repo.unstaged, repo.staged]);
  const noRemote = repo.remotes.length === 0;
  // a quick pull needs an upstream the remote still has (a gone one only fails with "no such ref was fetched")
  const canPull = !!current?.upstream && !current.gone;
  // known once the submodules are read: none means nothing to update
  const noSubmodules = repo.submodules !== undefined && repo.submodules.length === 0;
  // the first remote that follows only some branches: what "Fetch every branch" would widen
  const narrowRemote = repo.remotes.find((r) => r.narrow)?.name;
  return (
    <View style={[styles.toolbar, { backgroundColor: t.panelAlt, borderColor: t.border }]}>
      <IconButton icon="sidebar" active={!sidebarCollapsed} title="Toggle sidebar (⌘B)" onPress={() => setState({ sidebarCollapsed: !sidebarCollapsed })} />
      <View style={{ width: 8 }} />
      {/* as in Fork: a click opens the dialog with its options; the arrow does it right away */}
      {show('fetch') && (
        <ToolButton
          icon="fetch"
          label="Fetch"
          compact={compact}
          onPress={() => openDialog({ type: 'fetch' })}
          disabled={!!op}
          testID="toolbar-fetch"
          menu={(a) =>
            showContextMenu(a.x, a.y + a.h + 2, [
              { label: noRemote ? 'Fetch now — no remotes' : 'Fetch all remotes now', disabled: noRemote, onPress: () => fetch({}) },
              ...repo.remotes.map((r) => ({ label: `Fetch ${r.name} now`, onPress: () => fetch({ remote: r.name }) })),
              { separator: true },
              { label: 'Fetch…', shortcut: '⌘⇧F', onPress: () => openDialog({ type: 'fetch' }) },
            ])
          }
        />
      )}
      {show('pull') && (
        <ToolButton
          icon="pull"
          label="Pull"
          compact={compact}
          badge={current?.behind || undefined}
          badgeColor={t.warn}
          onPress={() => openDialog({ type: 'pull' })}
          disabled={!!op}
          testID="toolbar-pull"
          menu={(a) =>
            showContextMenu(a.x, a.y + a.h + 2, [
              // without an upstream it says why (it used to read "Pull  now")
              { label: current?.upstream ? (current.gone ? `Pull now — ${current.upstream} is gone` : `Pull ${current.upstream} now (${pullMode === 'ff' ? 'fast-forward' : pullMode})`) : current ? `Pull now — ${current.name} tracks nothing` : 'Pull now — HEAD is detached', disabled: !canPull, onPress: () => pull({}) },
              { label: 'Pull with merge', disabled: !canPull, onPress: () => pull({ strategy: 'merge' }) },
              { label: 'Pull with rebase', disabled: !canPull, onPress: () => pull({ strategy: 'rebase' }) },
              { label: 'Fast-forward only', disabled: !canPull, onPress: () => pull({ strategy: 'ff' }) },
              { separator: true },
              { label: 'Pull…', shortcut: '⌘⇧L', onPress: () => openDialog({ type: 'pull' }) },
            ])
          }
        />
      )}
      {show('push') && (
        <ToolButton
          icon="push"
          label="Push"
          compact={compact}
          badge={current?.ahead || undefined}
          onPress={() => openDialog({ type: 'push' })}
          disabled={!!op}
          testID="toolbar-push"
          menu={(a) =>
            showContextMenu(a.x, a.y + a.h + 2, [
              { label: noRemote ? 'Push now — no remotes' : current ? `Push ${current.name} → ${current.upstream ?? `${repo.remotes[0].name}/${current.name}`} now` : 'Push now — HEAD is detached', disabled: !current || noRemote, onPress: () => push({}) },
              { label: 'Push with all tags', disabled: !current || noRemote, onPress: () => push({ tags: true }) },
              { separator: true },
              { label: 'Push…', shortcut: '⌘⇧P', onPress: () => openDialog({ type: 'push' }) },
            ])
          }
        />
      )}
      <View style={{ width: 6 }} />
      <Divider vertical />
      <View style={{ width: 6 }} />
      {show('stash') && <ToolButton icon="stash" label="Stash" compact={compact} badge={changes || undefined} badgeColor={t.textFaint} onPress={() => openDialog({ type: 'stash' })} testID="toolbar-stash" />}
      {show('branch') && <ToolButton icon="branch" label="Branch" compact={compact} onPress={() => openDialog({ type: 'branch' })} testID="toolbar-branch" />}
      {show('merge') && <ToolButton icon="merge" label="Merge" compact={compact} onPress={() => openDialog({ type: 'merge' })} testID="toolbar-merge" />}
      {show('rebase') && <ToolButton icon="rebase" label="Rebase" compact={compact} onPress={() => openDialog({ type: 'rebase' })} testID="toolbar-rebase" />}
      {mods.extraToolbarButtons.map((k) => (
        <ToolButton
          key={k}
          icon={k === 'terminal' ? 'terminal' : k === 'finder' ? 'folder' : k === 'editor' ? 'edit' : k === 'blame' ? 'user' : 'history'}
          label={k.charAt(0).toUpperCase() + k.slice(1)}
          compact={compact}
          onPress={() => toast(`${k.charAt(0).toUpperCase() + k.slice(1)}: added by the agent (mock action)`, 'info')}
        />
      ))}
      <View style={{ width: 6 }} />
      <Divider vertical />
      <View style={{ width: 6 }} />
      <ToolButton
        icon="more"
        label="More"
        compact={compact}
        testID="toolbar-more"
        onPressAt={(a) => {
          showContextMenu(a.x, a.y + a.h + 2, [
            { label: 'Open in Terminal', shortcut: '⌃⌥T', onPress: () => (repoPath && isLive ? live.openTerminalAt(repoPath) : desktop() && repoPath ? void openInTerminal(repoPath) : toast('Opened terminal at repository root (mock)', 'info')) },
            { label: 'Open in Finder', onPress: () => (repoPath && isLive ? live.revealPath(repoPath) : desktop() && repoPath ? void revealInFinder(repoPath) : toast('Revealed in Finder (mock)', 'info')) },
            { label: 'Open in editor', onPress: () => (repoPath && isLive ? live.openInEditor(repoPath) : toast('Opened in editor (mock)', 'info')) },
            { separator: true },
            // a narrow clone (--single-branch) asks for one branch only: the rest of the remote appears once its fetch list is widened
            // off, they say why in a few words (the long reasons were cut off at the menu's edge)
            { label: narrowRemote ? `Fetch every branch of ${narrowRemote}` : 'Fetch every branch — all followed', disabled: !narrowRemote, onPress: () => followAllBranches(narrowRemote) },
            { label: repo.shallow ? 'Fetch the full history (unshallow)…' : 'Fetch the full history — complete', disabled: !repo.shallow, onPress: () => openDialog({ type: 'fetch' }) },
            // the whole repository at once: every branch of every remote, no dialog
            { label: repo.shallow ? 'Unshallow the whole repository' : 'Unshallow — not a shallow clone', disabled: !repo.shallow, onPress: () => unshallow({ allBranches: true }) },
            { label: noSubmodules ? 'Submodules → Update — none here' : 'Submodules → Update all', disabled: noSubmodules, onPress: () => (isLive ? live.updateSubmodules(undefined, false) : toast('Submodules updated (mock)', 'success')) },
            { label: 'Submodules → Update recursively', disabled: noSubmodules, onPress: () => (isLive ? live.updateSubmodules(undefined, true) : toast('Submodules updated (mock)', 'success')) },
            // files left as pointers (cloned without LFS, or left out by .lfsconfig's fetchexclude)
            { label: 'Restore Git LFS files…', disabled: !isLive, onPress: () => openDialog({ type: 'lfs' }) },
            { label: 'Refresh', shortcut: '⌘R', onPress: () => (isLive ? void live.refreshNow() : toast('Refreshed (mock)', 'info')) },
            { label: undoTop ? `Undo ${undoTop.label}` : 'Undo — nothing to undo', shortcut: '⌘Z', disabled: !undoTop, onPress: () => live.undoLast() },
            { separator: true },
            { label: 'Connection (SSH key / account)…', disabled: !isLive, onPress: () => openDialog({ type: 'connection' }) },
            // what it opens: the app's preferences (it was called "Repository settings…")
            { label: 'Preferences…', shortcut: '⌘,', onPress: () => openDialog({ type: 'accounts', tab: 'general' }) },
            { label: 'Keyboard shortcuts', shortcut: '⌘/', onPress: () => openDialog({ type: 'shortcuts' }) },
          ]);
        }}
      />
      <View style={{ flex: 1 }} />
      {/* the status panel where the command palette field was (the palette is ⌘K): all status and progress */}
      <View style={{ width: Math.round(Math.max(240, Math.min(560, vp.width * 0.36))), flexShrink: 1, minWidth: 160 }}>
        <StatusPanel />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', alignItems: 'flex-end', height: TABS_H, paddingHorizontal: 6, borderBottomWidth: 1 },
  tab: { flexDirection: 'row', alignItems: 'center', height: TABS_H - 4, paddingHorizontal: 10, borderWidth: 1, borderBottomWidth: 0, marginRight: 2, overflow: 'hidden' },
  group: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderBottomWidth: 0, paddingTop: 2, paddingHorizontal: 2, marginRight: 4 },
  groupToggle: { height: TABS_H - 8, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', marginLeft: 1 },
  homeBtn: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 1, marginRight: 4 },
  ws: { flexDirection: 'row', alignItems: 'center', height: 24, paddingHorizontal: 8, marginBottom: 2, marginRight: 6 },
  wsPop: { position: 'absolute', width: 240, zIndex: 60 },
  agentBtn: { flexDirection: 'row', alignItems: 'center', height: 24, paddingHorizontal: 8, borderWidth: 1 },
  // above the repository view: the status panel's lists open downwards over it
  toolbar: { flexDirection: 'row', alignItems: 'center', height: TOOLBAR_H, paddingHorizontal: 6, borderBottomWidth: 1, zIndex: 30 },
});
