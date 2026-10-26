import React from 'react';
import { View } from 'react-native';
import { ChangesPanel } from '../components/ChangesPanel';
import { CommitDetails } from '../components/CommitDetails';
import { CommitList } from '../components/CommitList';
import { Sidebar } from '../components/Sidebar';
import { Toolbar } from '../components/Toolbar';
import { setLayout, useMods, useRepo, useStore } from '../state/store';
import { TABS_H, TOOLBAR_H, useTheme } from '../theme';
import { FadeIn, Splitter, useViewport } from '../ui/primitives';

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
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Toolbar />
      <View style={{ flex: 1, flexDirection: 'row' }}>
        {!collapsed && (
          <>
            <View style={{ width: mods.sidebarWidth ?? layout.sidebar }}>
              <Sidebar />
            </View>
            <Splitter orientation="vertical" onDelta={(d) => setLayout({ sidebar: Math.max(170, Math.min(420, layout.sidebar + d)) })} />
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
              <Splitter orientation="horizontal" onDelta={(d) => setLayout({ details: Math.max(0.2, Math.min(0.8, layout.details - d / mainH)) })} />
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
