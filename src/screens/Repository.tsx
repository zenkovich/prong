import React from 'react';
import { View } from 'react-native';
import { ChangesPanel } from '../components/ChangesPanel';
import { CommitDetails } from '../components/CommitDetails';
import { CommitList } from '../components/CommitList';
import { Sidebar } from '../components/Sidebar';
import { Toolbar } from '../components/Toolbar';
import { closeTab, removeRepo, setLayout, useMods, useRepo, useStore } from '../state/store';
import * as live from '../state/live';
import { FONT, TABS_H, TOOLBAR_H, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Button, FadeIn, Splitter, Txt, useViewport } from '../ui/primitives';

export function Repository() {
  const t = useTheme();
  const repo = useRepo();
  const layout = useStore((s) => s.layout);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const { height } = useViewport();
  const mods = useMods();
  // no status bar at the bottom: status and progress are in the toolbar's status panel
  const mainH = height - TABS_H - TOOLBAR_H;
  const detailsH = Math.round(mainH * layout.details);
  if (repo.missing)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: t.bg }} testID="repo-missing">
        <Icon name="warning" size={22} color={t.warn} />
        <Txt weight="600" size={FONT.lg} style={{ marginTop: 10 }}>
          Not a git repository any more
        </Txt>
        <Txt muted mono size={FONT.sm} selectable style={{ marginTop: 6, textAlign: 'center' }}>
          {repo.missing}
        </Txt>
        <Txt faint size={FONT.sm} style={{ marginTop: 6, textAlign: 'center', maxWidth: 520 }}>
          The folder was deleted, moved or renamed. Open it from where it is now (Open…, ⌘O), or take it off the list.
        </Txt>
        <View style={{ flexDirection: 'row', marginTop: 14 }}>
          <Button label="Try again" icon="refresh" onPress={() => void live.openLive(repo.id)} testID="missing-retry" />
          <Button label="Close tab" style={{ marginLeft: 8 }} onPress={() => closeTab(repo.id)} testID="missing-close" />
          <Button label="Remove from list" danger style={{ marginLeft: 8 }} onPress={() => removeRepo(repo.id)} testID="missing-remove" />
        </View>
      </View>
    );
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Toolbar />
      <View style={{ flex: 1, flexDirection: 'row' }}>
        {!collapsed && (
          <>
            <View style={{ width: mods.sidebarWidth ?? layout.sidebar }} testID="sidebar-column">
              <Sidebar />
            </View>
            <Splitter orientation="vertical" onDelta={(d) => setLayout({ sidebar: Math.max(170, Math.min(420, layout.sidebar + d)) })} testID="sidebar-splitter" />
          </>
        )}
        <View style={{ flex: 1 }}>
          {repo.section === 'changes' ? (
            <FadeIn keyProp="changes" slide={6} style={{ flex: 1 }}>
              <ChangesPanel />
            </FadeIn>
          ) : (
            <FadeIn keyProp="commits" slide={6} style={{ flex: 1 }}>
              <View style={{ flex: 1 }}>
                <CommitList />
              </View>
              <Splitter orientation="horizontal" onDelta={(d) => setLayout({ details: Math.max(0.2, Math.min(0.8, layout.details - d / mainH)) })} testID="details-splitter" />
              <View style={{ height: detailsH, borderTopWidth: 1, borderColor: t.border }}>
                <CommitDetails />
              </View>
            </FadeIn>
          )}
        </View>
      </View>
    </View>
  );
}
