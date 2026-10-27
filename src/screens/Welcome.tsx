import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { deleteWorkspace, inWorkspace, moveRepoToWorkspace, openDialog, openRepo, relTime, removeRepo, showContextMenu, sortRepos, switchWorkspace, toast, togglePin, useStore, useWorkspaceRepos } from '../state/store';
import * as live from '../state/live';
import { FONT, useTheme } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { Badge, Button, FadeIn, Input, PressScale, Row, Txt } from '../ui/primitives';
import { StatusPanel } from '../components/StatusPanel';

/** an account's sign-in as last checked: ok, expired (sign in again), not reachable, checking */
export function AccountBadge({ id }: { id: string }) {
  const t = useTheme();
  const st = useStore((s) => s.accountStatus[id]);
  if (!st || st.state === 'checking') return <Badge>…</Badge>;
  if (st.state === 'ok')
    return (
      <Badge bg={t.addBg} color={t.add}>
        ok
      </Badge>
    );
  if (st.state === 'expired')
    return (
      <Badge bg={t.del + '22'} color={t.del}>
        sign in again
      </Badge>
    );
  return (
    <Badge bg={t.warn + '22'} color={t.warn}>
      not checked
    </Badge>
  );
}

export function Welcome() {
  const t = useTheme();
  const repos = useWorkspaceRepos();
  const allRepos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = useStore((s) => s.activeWorkspace);
  const wsName = workspaces.find((w) => w.id === activeWs)?.name ?? activeWs;
  const accounts = useStore((s) => s.accounts);
  const engine = useStore((s) => s.engine);
  const scanning = useStore((s) => s.scanning);
  const activeWsObj = workspaces.find((w) => w.id === activeWs);
  // a repository's changes are known once it has been read (opened) in this session
  const states = useStore((s) => s.repoStates);
  const [q, setQ] = useState('');
  const list = sortRepos(repos, q);
  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: t.bg }}>
      <View style={[styles.left, { backgroundColor: t.panel, borderColor: t.border }]}>
        <FadeIn>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 18 }}>
            <Logo />
            <View style={{ marginLeft: 10 }}>
              <Txt size={FONT.xl} weight="700">
                prong
              </Txt>
              <Txt size={FONT.xs} muted>
                git client · 01 terminal
              </Txt>
            </View>
          </View>
          <Action icon="folder" title="Open" hint="Open a local repository" shortcut="⌘O" onPress={() => openDialog({ type: 'open' })} testID="action-open" />
          <Action icon="clone" title="Clone" hint="From GitHub or any URL" shortcut="⌘⇧N" onPress={() => openDialog({ type: 'clone' })} testID="action-clone" />
          <Action icon="plus" title="Init" hint="Create a new repository" onPress={() => openDialog({ type: 'init' })} testID="action-init" />
          <View style={{ height: 18 }} />
          <Txt label faint style={{ marginBottom: 6 }}>
            ── workspaces
          </Txt>
          {workspaces.map((w) => {
            const n = allRepos.filter((r) => inWorkspace(r, w.id)).length;
            const active = w.id === activeWs;
            return (
              <Row
                key={w.id}
                height={26}
                selected={active}
                selectMode="soft"
                testID={`ws-${w.name}`}
                onPress={() => switchWorkspace(w.id, true)}
                style={{ paddingLeft: 6 }}
                onContextMenu={(x, y) =>
                  showContextMenu(x, y, [
                    { label: 'Switch', onPress: () => switchWorkspace(w.id, true) },
                    { label: 'Edit…', onPress: () => openDialog({ type: 'workspace', id: w.id }) },
                    { label: 'Rescan folder', disabled: !w.rootPath || !engine.online, onPress: () => void live.scanWorkspace(w.id, true) },
                    { label: 'Delete', danger: true, disabled: workspaces.length < 2, onPress: () => deleteWorkspace(w.id) },
                  ])
                }
              >
                <Txt size={FONT.md} color={active ? t.accent : 'transparent'} weight="700" style={{ width: 12 }}>
                  ▸
                </Txt>
                <Txt size={FONT.sm} color={active ? t.accent : undefined} weight={active ? '600' : '400'} style={{ flex: 1 }}>
                  @{w.name}
                </Txt>
                <Txt size={FONT.xs} faint>
                  {n}
                </Txt>
              </Row>
            );
          })}
          <Row height={26} onPress={() => openDialog({ type: 'workspace' })} style={{ paddingLeft: 6 }} testID="ws-new">
            <View style={{ width: 12 }} />
            <Icon name="plus" size={12} />
            <Txt size={FONT.sm} muted style={{ marginLeft: 6 }}>
              New workspace
            </Txt>
          </Row>
          <View style={{ height: 14 }} />
          <Txt label faint style={{ marginBottom: 6 }}>
            ── accounts
          </Txt>
          {accounts.map((a) => (
            <Row key={a.id} height={28} onPress={() => openDialog({ type: 'accounts', tab: 'github' })} style={{ borderRadius: 0, paddingLeft: 6 }} testID={`account-${a.login}`}>
              <Icon name="github" size={14} color={t.text} />
              <Txt size={FONT.sm} style={{ marginLeft: 8, flex: 1 }}>
                {a.login}
              </Txt>
              <AccountBadge id={a.id} />
            </Row>
          ))}
          <Row height={28} onPress={() => openDialog({ type: 'accounts', tab: 'github' })} style={{ borderRadius: 0, paddingLeft: 6 }} testID="accounts-add">
            <Icon name="plus" size={13} />
            <Txt size={FONT.sm} muted style={{ marginLeft: 8 }}>
              Add account
            </Txt>
          </Row>
          <Row height={28} onPress={() => openDialog({ type: 'accounts', tab: 'ssh' })} style={{ borderRadius: 0, paddingLeft: 6 }} testID="accounts-ssh">
            <Icon name="key" size={13} />
            <Txt size={FONT.sm} muted style={{ marginLeft: 8 }}>
              SSH keys
            </Txt>
          </Row>
        </FadeIn>
      </View>
      <View style={{ flex: 1, padding: 24 }}>
        {/* status and progress (a clone, a scan, errors) at the top, as in a repository's toolbar */}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: -12, marginBottom: 12, zIndex: 30 }}>
          <View style={{ width: 420, maxWidth: '100%' }}>
            <StatusPanel welcome />
          </View>
        </View>
        <FadeIn delay={60}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
            <Txt size={FONT.lg} weight="600">
              Repositories
            </Txt>
            <Txt size={FONT.sm} muted style={{ marginLeft: 8 }} numberOfLines={1}>
              @{wsName} · {repos.length}
            </Txt>
            {/* a long folder shrinks (cut at its end), so the buttons and the filter stay in a narrow window: they used to
                be pushed out of it */}
            {activeWsObj?.rootPath ? (
              <PressScale onPress={() => openDialog({ type: 'workspace', id: activeWs })} outerStyle={{ flexShrink: 1, minWidth: 40 }} style={{ marginLeft: 10, flexDirection: 'row', alignItems: 'center' }} scaleTo={0.98} testID="ws-root" label={activeWsObj.rootPath}>
                <Icon name="folder" size={11} color={t.textFaint} />
                <Txt size={FONT.xs} faint mono style={{ marginLeft: 4, flexShrink: 1 }} numberOfLines={1}>
                  {activeWsObj.rootPath}
                </Txt>
              </PressScale>
            ) : null}
            <View style={{ flex: 1, minWidth: 8 }} />
            <Button small label={activeWsObj?.rootPath ? 'Change folder…' : 'Choose folder to scan…'} icon="folder" primary={!activeWsObj?.rootPath && repos.length === 0} style={{ marginRight: 8 }} onPress={() => void live.chooseWorkspaceRoot(activeWs)} testID="ws-choose-folder" />
            {activeWsObj?.rootPath && <Button small label={scanning === activeWs ? 'Scanning…' : 'Rescan'} icon="refresh" style={{ marginRight: 8 }} disabled={!engine.online || scanning === activeWs} onPress={() => void live.scanWorkspace(activeWs, true)} testID="ws-rescan" />}
            <Input value={q} onChange={setQ} placeholder="filter repositories" slash small style={{ width: 220 }} testID="repo-filter" />
          </View>
        </FadeIn>
        <ScrollView>
          {list.map((r, i) => (
            <FadeIn key={r.id} delay={80 + i * 35} slide={10}>
              <PressScale
                onPress={() => openRepo(r.id)}
                scaleTo={0.99}
                testID={`repo-card-${r.name}`}
                style={[styles.card, { backgroundColor: t.panel, borderColor: t.border }]}
                hoverStyle={{ borderColor: t.accent }}
                onContextMenu={(x, y) =>
                  showContextMenu(x, y, [
                    { label: 'Open', onPress: () => openRepo(r.id) },
                    { label: r.pinned ? 'Unpin' : 'Pin', onPress: () => togglePin(r.id) },
                    { label: 'Reveal in Finder', onPress: () => (r.live && engine.online ? live.revealPath(r.path) : toast('Revealed (mock)', 'info')) },
                    { label: 'Open in Terminal', onPress: () => (r.live && engine.online ? live.openTerminalAt(r.path) : toast('Terminal (mock)', 'info')) },
                    { separator: true },
                    ...workspaces.filter((w) => w.id !== activeWs).map((w) => ({ label: `Move to @${w.name}`, onPress: () => moveRepoToWorkspace(r.id, w.id) })),
                    { separator: true },
                    { label: 'Remove from list', danger: true, onPress: () => removeRepo(r.id) },
                  ])
                }
              >
                {({ hovered }) => (
                  <>
                    <View style={[styles.cardIcon, { backgroundColor: t.accentSoft }]}>
                      <Icon name="folder" size={18} color={t.accent} />
                    </View>
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Txt weight="600">{r.name}</Txt>
                        {r.pinned && (
                          <View style={{ marginLeft: 6 }}>
                            <Icon name="pin" size={11} color={t.textFaint} />
                          </View>
                        )}
                      </View>
                      <Txt size={FONT.xs} faint mono numberOfLines={1}>
                        {r.path}
                      </Txt>
                    </View>
                    <View style={{ alignItems: 'flex-end', marginRight: 10 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Icon name="branch" size={11} />
                        <Txt size={FONT.sm} muted style={{ marginLeft: 4 }} testID={`repo-branch-${r.name}`}>
                          {r.currentBranch}
                        </Txt>
                      </View>
                      <Txt size={FONT.xs} faint testID={`repo-when-${r.name}`}>
                        {r.lastOpened ? relTime(r.lastOpened) : 'not opened yet'}
                      </Txt>
                    </View>
                    {r.live ? (
                      <Badge bg={t.addBg} color={t.add} style={{ marginRight: 6 }}>
                        live
                      </Badge>
                    ) : (
                      <Badge style={{ marginRight: 6 }}>mock</Badge>
                    )}
                    {/* known once read: an unread one used to show "…" that never filled */}
                    <View testID={`repo-changes-${r.name}`}>
                      {r.live && (!states[r.id] || states[r.id].loading) ? null : r.changes > 0 ? (
                        <Badge bg={t.warn + '33'} color={t.warn}>
                          {r.changes} change{r.changes === 1 ? '' : 's'}
                        </Badge>
                      ) : (
                        <Badge>clean</Badge>
                      )}
                    </View>
                    <View style={{ width: 16, marginLeft: 8, opacity: hovered ? 1 : 0 }}>
                      <Icon name="chevronRight" size={14} color={t.accent} />
                    </View>
                  </>
                )}
              </PressScale>
            </FadeIn>
          ))}
          {!engine.online && (
            <View style={[styles.hint, { borderColor: t.warn + '66', backgroundColor: t.warn + '14' }]} testID="engine-offline-hint">
              <Icon name="warning" size={13} color={t.warn} />
              <Txt size={FONT.sm} style={{ marginLeft: 8, flex: 1 }}>
                Git engine is offline: repositories cannot be opened. Start it with <Txt size={FONT.sm} mono>npm run server</Txt> in the prong folder, or use Prong.app which bundles it.
              </Txt>
            </View>
          )}
          {list.length === 0 && (
            <Txt muted style={{ paddingVertical: 12 }} testID="repo-list-empty">
              {q.trim() && repos.length
                ? `No repositories in @${wsName} match “${q.trim()}”.`
                : `No repositories in @${wsName} yet. Open or clone one, set a root folder for this workspace to discover repositories automatically, or move one here from another workspace.`}
            </Txt>
          )}
          <FadeIn delay={300}>
            {/* a drop is handled by the window (App: droppedPath); a click opens the Open dialog */}
            <PressScale onPress={() => openDialog({ type: 'open' })} scaleTo={0.99} style={[styles.drop, { borderColor: t.border }]} hoverStyle={{ borderColor: t.accent }} testID="drop-zone">
              <Icon name="folder" size={18} color={t.textFaint} />
              <Txt size={FONT.sm} faint style={{ marginLeft: 8 }}>
                Drop a repository’s path here, or click to open one (⌘O)
              </Txt>
            </PressScale>
          </FadeIn>
        </ScrollView>
      </View>
    </View>
  );
}

function Action({ icon, title, hint, shortcut, onPress, testID }: { icon: IconName; title: string; hint: string; shortcut?: string; onPress: () => void; testID?: string }) {
  const t = useTheme();
  return (
    <PressScale onPress={onPress} testID={testID} scaleTo={0.98} style={[styles.action, { borderColor: t.border }]} hoverStyle={{ backgroundColor: t.hover, borderColor: t.borderStrong }}>
      <View style={[styles.actionIcon, { backgroundColor: t.accentSoft }]}>
        <Icon name={icon} size={16} color={t.accent} />
      </View>
      <View style={{ marginLeft: 10, flex: 1 }}>
        <Txt weight="600">{title}</Txt>
        <Txt size={FONT.xs} muted>
          {hint}
        </Txt>
      </View>
      {shortcut && (
        <Txt size={FONT.xs} faint mono>
          {shortcut}
        </Txt>
      )}
    </PressScale>
  );
}

export function Logo({ size = 36 }: { size?: number }) {
  const t = useTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: 0 * 0.28, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="branch" size={size * 0.6} color="#fff" strokeWidth={2.2} />
    </View>
  );
}

const styles = StyleSheet.create({
  left: { width: 300, padding: 20, borderRightWidth: 1 },
  action: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 0, borderWidth: 1, marginBottom: 8 },
  actionIcon: { width: 32, height: 32, borderRadius: 0, alignItems: 'center', justifyContent: 'center' },
  card: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 0, borderWidth: 1, marginBottom: 8 },
  cardIcon: { width: 36, height: 36, borderRadius: 0, alignItems: 'center', justifyContent: 'center' },
  hint: { flexDirection: 'row', alignItems: 'center', padding: 10, borderWidth: 1, marginBottom: 8 },
  drop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 64, borderWidth: 1, borderStyle: 'dashed', borderRadius: 0, marginTop: 8 },
});
