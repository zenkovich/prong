import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { closeRepoPicker, goWelcome, openDialog, openRepo, sortRepos, useStore, useWorkspaceRepos } from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Badge, Button, Glass, Input, PressScale, Txt, useKeyboard, useViewport } from '../ui/primitives';

const W = 540;

/**
 * The start page's repository list as a popup under the + of the tab bar (and ⌘T): type to narrow it, arrows and
 * Enter or a click open one in a tab; repositories already open in a tab are marked.
 */
export function RepoPickerHost() {
  const at = useStore((s) => s.repoPicker);
  if (!at) return null;
  return <RepoPicker x={at.x} y={at.y} />;
}

function RepoPicker({ x, y }: { x: number; y: number }) {
  const t = useTheme();
  const vp = useViewport();
  const repos = useWorkspaceRepos();
  const tabs = useStore((s) => s.tabs);
  const wsName = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspace)?.name ?? s.activeWorkspace);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const list = sortRepos(repos, q);
  const cur = Math.min(sel, Math.max(0, list.length - 1));
  const open = (id: string) => {
    closeRepoPicker();
    openRepo(id);
  };
  useKeyboard((e) => {
    if (e.key === 'Escape') closeRepoPicker();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(list.length - 1, cur + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(0, cur - 1));
    } else if (e.key === 'Enter' && list[cur]) {
      e.preventDefault();
      open(list[cur].id);
    }
  });
  const left = Math.max(8, Math.min(x, vp.width - W - 8));
  const top = Math.max(8, Math.min(y, vp.height - 200));
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 110 }]} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={closeRepoPicker} testID="repo-picker-backdrop" />
      <View style={{ position: 'absolute', left, top, width: W }} testID="repo-picker">
        <Glass style={{ maxHeight: Math.max(220, vp.height - top - 16) }}>
          <View style={{ padding: 8, borderBottomWidth: 1, borderColor: t.glassBorder }}>
            <Input
              value={q}
              onChange={(v) => {
                setQ(v);
                setSel(0);
              }}
              placeholder={`open a repository in @${wsName}`}
              slash
              small
              autoFocus
            />
          </View>
          <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled">
            {list.map((r, i) => {
              const active = i === cur;
              const inTab = tabs.includes(r.id);
              return (
                <PressScale
                  key={r.id}
                  onPress={() => open(r.id)}
                  onHover={(h) => h && setSel(i)}
                  scaleTo={1}
                  style={[styles.row, active && { backgroundColor: t.softSelection }]}
                  label={`Open ${r.name}`}
                  testID={`picker-repo-${r.name}`}
                >
                  <Icon name="folder" size={14} color={active ? t.accent : t.textMuted} />
                  <View style={{ flex: 1, marginLeft: 10, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Txt weight="600" numberOfLines={1} style={{ flexShrink: 1 }} color={active ? t.accent : undefined}>
                        {r.name}
                      </Txt>
                      {r.pinned && (
                        <View style={{ marginLeft: 6 }}>
                          <Icon name="pin" size={10} color={t.textFaint} />
                        </View>
                      )}
                      {inTab && (
                        <Txt size={FONT.xs} faint style={{ marginLeft: 8 }}>
                          open
                        </Txt>
                      )}
                    </View>
                    <Txt size={FONT.xs} faint mono numberOfLines={1}>
                      {r.path}
                    </Txt>
                  </View>
                  {r.currentBranch ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8, maxWidth: 160 }}>
                      <Icon name="branch" size={11} />
                      <Txt size={FONT.xs} muted numberOfLines={1} style={{ marginLeft: 4, flexShrink: 1 }}>
                        {r.currentBranch}
                      </Txt>
                    </View>
                  ) : null}
                  {r.changes > 0 ? (
                    <View style={{ marginLeft: 8 }}>
                      <Badge bg={t.warn + '33'} color={t.warn}>
                        {r.changes}
                      </Badge>
                    </View>
                  ) : null}
                </PressScale>
              );
            })}
            {list.length === 0 && (
              <Txt faint size={FONT.sm} style={{ padding: 12 }}>
                {repos.length === 0 ? `No repositories in @${wsName} yet.` : `Nothing matches “${q.trim()}”.`}
              </Txt>
            )}
          </ScrollView>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, borderTopWidth: 1, borderColor: t.glassBorder }}>
            <Button
              small
              label="Open folder…"
              icon="folder"
              onPress={() => {
                closeRepoPicker();
                openDialog({ type: 'open' });
              }}
            />
            <Button
              small
              label="Clone…"
              icon="clone"
              style={{ marginLeft: 6 }}
              onPress={() => {
                closeRepoPicker();
                openDialog({ type: 'clone' });
              }}
            />
            <View style={{ flex: 1 }} />
            <PressScale
              onPress={() => {
                closeRepoPicker();
                goWelcome();
              }}
              scaleTo={0.97}
              label="Start page"
            >
              <Txt size={FONT.xs} faint>
                @{wsName} · {repos.length} · start page ›
              </Txt>
            </PressScale>
          </View>
        </Glass>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, minHeight: 38 },
});
