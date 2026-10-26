import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Ref } from '../git/types';
import {
  checkout,
  closeDialog,
  commitsToRebase,
  createBranch,
  createTag,
  createWorkspace,
  Dialog,
  fetch,
  findCommit,
  goWelcome,
  merge,
  openDialog,
  openRepoPickerCentered,
  pull,
  push,
  rebase,
  RebaseTodo,
  relTime,
  renameBranch,
  renameWorkspace,
  reset,
  setSection,
  setSyncPrefs,
  showPicker,
  setTheme,
  shortSha,
  stash,
  stepUiScale,
  switchWorkspace,
  toast,
  toggleAgent,
  toggleAgentBar,
  toggleTheme,
  unshallow,
  followAllBranches,
  useRepo,
  useStore,
} from '../state/store';
import { FONT, SCHEMES, useTheme } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { ConfirmDialog, Modal, ShortcutsDialog } from '../ui/overlays';
import { Avatar, Button, Checkbox, Input, Kbd, PressScale, Radio, Row, Txt, useKeyboard } from '../ui/primitives';
import { RefChip } from './CommitList';
import { AccountsDialog, CloneDialog, Field, InitDialog, OpenDialog } from './accountsDialogs';
import { Select } from './Select';
import { ConnectionDialog } from './ConnectionDialog';
import { DeleteBranchesDialog } from './BranchBatchDialog';
import * as live from '../state/live';
import { desktop, pickFolder } from '../desktop';

export function DialogHost() {
  const d = useStore((s) => s.dialog);
  if (!d) return null;
  switch (d.type) {
    case 'clone':
      return <CloneDialog initialUrl={d.url} />;
    case 'open':
      return <OpenDialog />;
    case 'init':
      return <InitDialog />;
    case 'accounts':
      return <AccountsDialog tab={d.tab} />;
    case 'confirm':
      return <ConfirmDialog title={d.title} message={d.message} confirmLabel={d.confirmLabel} danger={d.danger} onConfirm={d.onConfirm} />;
    case 'rebase':
      return <RebaseDialog d={d} />;
    case 'push':
      return <PushDialog branch={d.branch} />;
    case 'pull':
      return <PullDialog />;
    case 'fetch':
      return <FetchDialog />;
    case 'branch':
      return <BranchDialog fromSha={d.fromSha} />;
    case 'merge':
      return <MergeDialog source={d.source} />;
    case 'tag':
      return <TagDialog sha={d.sha} />;
    case 'reset':
      return <ResetDialog sha={d.sha} />;
    case 'stash':
      return <StashDialog />;
    case 'palette':
      return <PaletteDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'workspace':
      return <WorkspaceDialog id={d.id} />;
    case 'renameBranch':
      return <RenameBranchDialog name={d.name} />;
    case 'upstream':
      return <UpstreamDialog branch={d.branch} />;
    case 'remote':
      return <RemoteDialog name={d.name} url={d.url} />;
    case 'connection':
      return <ConnectionDialog />;
    case 'deleteBranches':
      return <DeleteBranchesDialog names={d.names} />;
  }
}

function WorkspaceDialog({ id }: { id?: string }) {
  const t = useTheme();
  const workspaces = useStore((s) => s.workspaces);
  const engine = useStore((s) => s.engine);
  const scanning = useStore((s) => s.scanning);
  const existing = workspaces.find((w) => w.id === id);
  const [name, setName] = useState(existing?.name ?? '');
  const [root, setRoot] = useState(existing?.rootPath ?? '');
  const [depth, setDepth] = useState(String(existing?.scanDepth ?? 3));
  const valid = name.trim().length > 0 && !workspaces.some((w) => w.name === name.trim() && w.id !== id);
  const submit = async () => {
    if (!valid) return;
    let wsId = existing?.id;
    if (existing) renameWorkspace(existing.id, name);
    else wsId = createWorkspace(name) ?? undefined;
    if (wsId) await live.setWorkspaceRoot(wsId, root.trim() || undefined, Math.max(1, Math.min(6, parseInt(depth, 10) || 3)));
  };
  return (
    <Modal
      title={existing ? 'Edit workspace' : 'New workspace'}
      width={520}
      icon={<Icon name="layers" size={16} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label={existing ? 'Save' : 'Create & switch'} primary style={{ marginLeft: 8 }} disabled={!valid} onPress={() => void submit()} />
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={setName} placeholder="work, home, client-x…" autoFocus onSubmit={() => void submit()} />
      </Field>
      <Field label="Root folder (scanned for repositories, optional)" style={{ marginTop: 10 }}>
        <View style={{ flexDirection: 'row' }}>
          <Input value={root} onChange={setRoot} mono placeholder="~/work" style={{ flex: 1 }} />
          <Button label="Browse…" icon="folder" style={{ marginLeft: 6 }} onPress={async () => (desktop() ? setRoot((await pickFolder('Choose the workspace root folder')) ?? root) : toast('Folder picker is available in the macOS app; type the path', 'info'))} />
        </View>
      </Field>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 10 }}>
        <Field label="Scan depth" style={{ width: 90 }}>
          <Input value={depth} onChange={setDepth} mono />
        </Field>
        {existing?.rootPath && (
          <Button small label={scanning === existing.id ? 'Scanning…' : 'Scan now'} icon="refresh" style={{ marginLeft: 10, marginBottom: 1 }} disabled={!engine.online || scanning === existing.id} onPress={() => void live.scanWorkspace(existing.id, true)} />
        )}
      </View>
      <Txt size={FONT.sm} muted style={{ marginTop: 10 }}>
        Repositories found under the root folder are added to this workspace automatically (on start and on Scan now). Nested checkouts such as submodules are skipped; node_modules, build and similar folders are not entered.
      </Txt>
      {!engine.online && (
        <Txt size={FONT.xs} color={t.warn} style={{ marginTop: 6 }}>
          Scanning needs the git engine (npm run server).
        </Txt>
      )}
    </Modal>
  );
}

function RenameBranchDialog({ name }: { name: string }) {
  const t = useTheme();
  const repo = useRepo();
  const [next, setNext] = useState(name);
  const valid = /^[\w./-]+$/.test(next) && next !== name && !repo.refs.some((r) => r.kind === 'branch' && r.name === next);
  const submit = () => valid && (repo.live ? live.renameBranchTo(name, next) : (renameBranch(name, next), closeDialog()));
  return (
    <Modal
      title="Rename branch"
      width={420}
      icon={<Icon name="branch" size={16} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Rename" primary style={{ marginLeft: 8 }} disabled={!valid} onPress={submit} />
        </>
      }
    >
      <Field label={`New name for ${name}`}>
        <Input value={next} onChange={setNext} mono autoFocus onSubmit={submit} />
      </Field>
    </Modal>
  );
}

function UpstreamDialog({ branch }: { branch: string }) {
  const t = useTheme();
  const repo = useRepo();
  const current = repo.refs.find((r) => r.name === branch);
  const [upstream, setUpstream] = useState(current?.upstream ?? `origin/${branch}`);
  return (
    <Modal
      title={`Upstream for ${branch}`}
      width={480}
      icon={<Icon name="cloud" size={16} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Set upstream" primary style={{ marginLeft: 8 }} disabled={!upstream} onPress={() => (repo.live ? live.setUpstream(branch, upstream) : (toast(`Upstream of ${branch} → ${upstream} (mock)`, 'info'), closeDialog()))} />
        </>
      }
    >
      <BranchPicker value={upstream} onChange={setUpstream} kinds={['remote']} />
    </Modal>
  );
}

function RemoteDialog({ name, url }: { name?: string; url?: string }) {
  const t = useTheme();
  const repo = useRepo();
  const [n, setN] = useState(name ?? 'origin');
  const [u, setU] = useState(url ?? '');
  const editing = !!name;
  const valid = /^[\w.-]+$/.test(n) && u.trim().length > 0;
  const submit = () => {
    if (!valid) return;
    if (!repo.live) return (toast(`${editing ? 'Updated' : 'Added'} remote ${n} (mock)`, 'success'), closeDialog());
    if (editing) live.setRemoteUrl(name!, u.trim());
    else live.addRemote(n, u.trim());
  };
  return (
    <Modal
      title={editing ? `Edit remote ${name}` : 'Add remote'}
      width={520}
      icon={<Icon name="cloud" size={16} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label={editing ? 'Save' : 'Add'} primary style={{ marginLeft: 8 }} disabled={!valid} onPress={submit} />
        </>
      }
    >
      <Field label="Name">
        <Input value={n} onChange={setN} mono autoFocus={!editing} />
      </Field>
      <Field label="URL" style={{ marginTop: 10 }}>
        <Input value={u} onChange={setU} mono placeholder="git@github.com:user/repo.git" autoFocus={editing} onSubmit={submit} />
      </Field>
    </Modal>
  );
}

// ---------- branch picker ----------

function BranchPicker({ value, onChange, exclude, kinds = ['branch', 'remote'] }: { value: string; onChange: (v: string) => void; exclude?: string; kinds?: Ref['kind'][] }) {
  const t = useTheme();
  const repo = useRepo();
  const [q, setQ] = useState('');
  const list = repo.refs.filter((r) => kinds.includes(r.kind) && r.name !== exclude && r.name !== 'origin/HEAD' && r.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <View>
      <Input value={q} onChange={setQ} placeholder="search branches" slash small autoFocus />
      <ScrollView style={[styles.pickerList, { borderColor: t.border, backgroundColor: t.bg }]}>
        {list.map((r) => (
          <Row key={r.name} height={26} selected={value === r.name} onPress={() => onChange(r.name)}>
            <Icon name={r.kind === 'remote' ? 'cloud' : r.kind === 'tag' ? 'tag' : 'branch'} size={12} color={r.current ? t.accent : t.textFaint} />
            <Txt size={FONT.sm} style={{ marginLeft: 8, flex: 1 }} weight={r.current ? '600' : '400'}>
              {r.name}
            </Txt>
            <Txt size={FONT.xs} faint mono>
              {shortSha(r.sha)}
            </Txt>
          </Row>
        ))}
      </ScrollView>
    </View>
  );
}

// ---------- rebase ----------

function RebaseDialog({ d }: { d: Extract<Dialog, { type: 'rebase' }> }) {
  const t = useTheme();
  const repo = useRepo();
  const current = repo.refs.find((r) => r.kind === 'branch' && r.current);
  const defaultOnto = d.onto ?? (d.fromSha ? repo.refs.find((r) => r.sha === d.fromSha && r.kind !== 'tag')?.name : undefined) ?? repo.refs.find((r) => r.name === 'origin/main')?.name ?? '';
  const [onto, setOnto] = useState(defaultOnto);
  const [interactive, setInteractive] = useState(!!d.interactive);
  const ontoRef = repo.refs.find((r) => r.name === onto);
  const ontoSha = d.fromSha ?? ontoRef?.sha;
  const commits = useMemo(() => (ontoSha ? commitsToRebase(repo, ontoSha) : []), [repo, ontoSha]);
  const [todo, setTodo] = useState<RebaseTodo[] | null>(null);
  const list = todo ?? commits.map((c) => ({ sha: c.sha, action: 'pick' as const, message: c.subject }));
  const [editing, setEditing] = useState<string | null>(null);

  const setAction = (sha: string, action: RebaseTodo['action']) => setTodo(list.map((x) => (x.sha === sha ? { ...x, action } : x)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setTodo(next);
  };
  const actions: { a: RebaseTodo['action']; color: string; hint: string }[] = [
    { a: 'pick', color: t.textMuted, hint: 'use commit' },
    { a: 'reword', color: t.info, hint: 'edit message' },
    { a: 'edit', color: t.warn, hint: 'stop to amend' },
    { a: 'squash', color: t.add, hint: 'meld into previous, keep message' },
    { a: 'fixup', color: t.add, hint: 'meld into previous, discard message' },
    { a: 'drop', color: t.del, hint: 'remove commit' },
  ];
  const target = d.fromSha && !ontoRef ? `${shortSha(d.fromSha)}` : onto;

  return (
    <Modal
      title={interactive ? 'Interactive rebase' : 'Rebase'}
      width={interactive ? 760 : 520}
      icon={<Icon name="rebase" size={18} color={t.accent} />}
      footer={
        <>
          <Txt size={FONT.xs} faint style={{ flex: 1 }}>
            {list.length} commit{list.length === 1 ? '' : 's'} will be replayed on top of {target || '…'}
          </Txt>
          <Button label="Cancel" onPress={closeDialog} />
          <Button
            label={interactive ? 'Start rebase' : 'Rebase'}
            primary
            style={{ marginLeft: 8 }}
            disabled={list.length === 0 || (!ontoRef && !d.fromSha)}
            onPress={() => {
              if (d.fromSha && !ontoRef) {
                // rebase onto a bare commit: use a temporary ref name for the mock
                const name = `__tmp_${shortSha(d.fromSha)}`;
                createBranch(name, d.fromSha, false);
                rebase(name, interactive ? list : undefined);
                return;
              }
              rebase(onto, interactive ? list : undefined);
            }}
          />
        </>
      }
    >
      <View style={{ flexDirection: 'row' }}>
        <View style={{ width: interactive ? 240 : undefined, flex: interactive ? undefined : 1 }}>
          <Txt size={FONT.sm} muted>
            Rebase <Txt size={FONT.sm} weight="600">{current?.name}</Txt> onto
          </Txt>
          {d.fromSha && !ontoRef ? (
            <Txt mono size={FONT.sm} style={{ marginTop: 6 }}>
              {shortSha(d.fromSha)} (commit)
            </Txt>
          ) : (
            <View style={{ marginTop: 6 }}>
              <BranchPicker value={onto} onChange={(v) => (setOnto(v), setTodo(null))} exclude={current?.name} />
            </View>
          )}
          <View style={{ marginTop: 10 }}>
            <Checkbox checked={interactive} onChange={setInteractive} label="Interactive (edit, squash, reorder)" />
          </View>
          <View style={{ marginTop: 4 }}>
            <Checkbox checked={true} onChange={() => {}} label="Preserve merges (--rebase-merges)" />
          </View>
          <View style={{ marginTop: 4 }}>
            <Checkbox checked={false} onChange={() => toast('Autostash is on by default in the real client', 'info')} label="Autostash local changes" />
          </View>
        </View>
        {interactive && (
          <View style={{ flex: 1, marginLeft: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
              <Txt size={FONT.xs} muted weight="600" style={{ flex: 1 }}>
                TODO (oldest first) — click an action, use arrows to reorder
              </Txt>
              <Button small label="Squash all" onPress={() => setTodo(list.map((x, i) => ({ ...x, action: i === 0 ? 'pick' : 'squash' })))} />
              <Button small label="Reset" style={{ marginLeft: 6 }} onPress={() => setTodo(null)} />
            </View>
            <ScrollView style={[styles.todoList, { borderColor: t.border, backgroundColor: t.bg }]}>
              {list.map((it, i) => {
                const act = actions.find((a) => a.a === it.action)!;
                return (
                  <View key={it.sha} style={[styles.todoRow, { borderColor: t.border, opacity: it.action === 'drop' ? 0.5 : 1 }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Icon name="grip" size={12} color={t.textFaint} />
                      <PressScale
                        onPress={() => {
                          const idx = actions.findIndex((a) => a.a === it.action);
                          setAction(it.sha, actions[(idx + 1) % actions.length].a);
                        }}
                        style={[styles.actionChip, { backgroundColor: act.color + '22', borderColor: act.color + '66' }]}
                      >
                        <Txt size={FONT.xs} weight="700" color={act.color} mono>
                          {it.action}
                        </Txt>
                      </PressScale>
                      <Txt size={FONT.xs} mono faint style={{ marginLeft: 8, width: 64 }}>
                        {shortSha(it.sha)}
                      </Txt>
                      <View style={{ flex: 1, minWidth: 0, marginRight: 6 }}>
                        {editing === it.sha ? (
                          <Input value={it.message} onChange={(v) => setTodo(list.map((x) => (x.sha === it.sha ? { ...x, message: v } : x)))} small autoFocus onSubmit={() => setEditing(null)} />
                        ) : (
                          <PressScale onPress={() => (setAction(it.sha, 'reword'), setEditing(it.sha))} scaleTo={1}>
                            <Txt size={FONT.sm} numberOfLines={1} style={it.action === 'drop' ? { textDecorationLine: 'line-through' } : undefined}>
                              {it.message}
                            </Txt>
                          </PressScale>
                        )}
                      </View>
                      <PressScale onPress={() => move(i, -1)} disabled={i === 0} style={{ padding: 3 }}>
                        <Icon name="arrowUp" size={12} />
                      </PressScale>
                      <PressScale onPress={() => move(i, 1)} disabled={i === list.length - 1} style={{ padding: 3 }}>
                        <Icon name="arrowDown" size={12} />
                      </PressScale>
                    </View>
                  </View>
                );
              })}
              {list.length === 0 && (
                <Txt faint size={FONT.sm} style={{ padding: 10 }}>
                  Nothing to rebase: {current?.name} is already based on {onto || 'the target'}.
                </Txt>
              )}
            </ScrollView>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }}>
              {actions.map((a) => (
                <View key={a.a} style={{ flexDirection: 'row', alignItems: 'center', marginRight: 12, marginBottom: 2 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 0, backgroundColor: a.color }} />
                  <Txt size={FONT.xs} faint style={{ marginLeft: 4 }}>
                    {a.a}: {a.hint}
                  </Txt>
                </View>
              ))}
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ---------- push / pull / fetch ----------

/** a dialog row as in Fork's windows: the label on the left, the control on the right */
function Line({ label, children, top }: { label: string; children: React.ReactNode; top?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: top ? 'flex-start' : 'center', marginTop: 8 }}>
      <Txt size={FONT.sm} muted style={{ width: 84, textAlign: 'right', marginRight: 10, paddingTop: top ? 2 : 0 }}>
        {label}
      </Txt>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}
/** a quiet line under a row: what the choice will do */
function Note({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <Txt size={FONT.xs} color={color} faint={!color} style={{ marginTop: 4, marginLeft: 94 }} testID="sync-note">
      {children}
    </Txt>
  );
}
/** Enter runs the dialog's action (an open dropdown takes its own Enter) */
function useEnter(run: () => void, enabled = true) {
  useKeyboard((e) => {
    if (e.key === 'Enter' && !e.meta && !e.shift && !e.consumed && enabled) {
      e.preventDefault();
      run();
    }
  });
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
/** the names of a remote's branches (without the remote, without its HEAD) */
const branchesOn = (refs: Ref[], remote: string) => refs.filter((r) => r.kind === 'remote' && r.name.startsWith(remote + '/') && !r.name.endsWith('/HEAD')).map((r) => r.name.slice(remote.length + 1));

/**
 * Fork's Fetch: one remote or all of them, prune the remote branches deleted on the server, all tags. The choices
 * stay for next time.
 */
function FetchDialog() {
  const t = useTheme();
  const repo = useRepo();
  const prefs = useStore((s) => s.syncPrefs);
  const [remote, setRemote] = useState(repo.remotes.some((r) => r.name === prefs.fetchRemote) ? prefs.fetchRemote : '');
  const [prune, setPrune] = useState(prefs.fetchPrune);
  const [tags, setTags] = useState(prefs.fetchTags);
  const [allBranches, setAllBranches] = useState(true);
  const narrow = repo.remotes.filter((r) => r.narrow);
  const chosen = repo.remotes.find((r) => r.name === remote);
  const go = () => {
    if (!repo.remotes.length) return;
    setSyncPrefs({ fetchRemote: remote, fetchPrune: prune, fetchTags: tags });
    fetch({ remote: remote || undefined, prune, tags });
  };
  useEnter(go);
  return (
    <Modal
      title="Fetch"
      width={500}
      icon={<Icon name="fetch" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          {repo.shallow && <Button label="Fetch full history" style={{ marginLeft: 8 }} onPress={() => unshallow({ allBranches })} testID="unshallow-button" />}
          <Button label="Fetch" primary style={{ marginLeft: 8 }} disabled={!repo.remotes.length} onPress={go} testID="fetch-go" />
        </>
      }
    >
      <View testID="fetch-dialog">
        {repo.remotes.length ? (
          <>
            <Line label="Remote">
              <Select
                value={remote}
                options={[{ value: '', label: 'All remotes', hint: plural(repo.remotes.length, 'remote') }, ...repo.remotes.map((r) => ({ value: r.name, label: r.name, hint: r.url }))]}
                onChange={setRemote}
                icon="cloud"
                testID="fetch-remote"
              />
            </Line>
            <Note>{chosen ? chosen.url : repo.remotes.map((r) => r.name).join(', ')}</Note>
            <Line label="Options" top>
              <Checkbox checked={prune} onChange={setPrune} label="Prune: remove remote branches deleted on the server" testID="fetch-prune" />
              <Checkbox checked={tags} onChange={setTags} label="Fetch all tags" testID="fetch-tags" />
            </Line>
          </>
        ) : (
          <Txt size={FONT.sm} muted>
            This repository has no remotes. Add one under Remotes in the sidebar.
          </Txt>
        )}
        {/* a narrow clone asks git for part of the remote only, so fetching cannot reveal the branches that are missing */}
        {narrow.length > 0 && (
          <View style={{ marginTop: 12, paddingTop: 8, borderTopWidth: 1, borderColor: t.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Icon name="cloud" size={12} color={t.warn} />
              <Txt size={FONT.sm} color={t.warn} weight="600" style={{ marginLeft: 6 }}>
                {narrow.map((r) => r.name).join(', ')} follows only some branches
              </Txt>
            </View>
            <Txt size={FONT.xs} faint style={{ marginTop: 4 }}>
              This clone was made with --single-branch (or --depth), so git asks for the branches on its fetch list and no fetch brings the others. “Fetch every branch” puts the wildcard refspec back ({"git remote set-branches '*'"}) and fetches them.
            </Txt>
            {narrow.map((r) => (
              <Button key={r.name} small label={`Fetch every branch of ${r.name}`} icon="fetch" style={{ marginTop: 6, alignSelf: 'flex-start' }} onPress={() => followAllBranches(r.name)} testID={`follow-all-${r.name}`} />
            ))}
          </View>
        )}
        {repo.shallow && (
          <View style={{ marginTop: 12, paddingTop: 8, borderTopWidth: 1, borderColor: t.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Icon name="history" size={12} color={t.warn} />
              <Txt size={FONT.sm} color={t.warn} weight="600" style={{ marginLeft: 6 }}>
                Shallow clone: the history is cut off
              </Txt>
            </View>
            <Txt size={FONT.xs} faint style={{ marginTop: 4 }}>
              Older commits are missing, so blame, file history and rebases onto them stay incomplete. “Fetch full history” gets them all (git fetch --unshallow) — on a large repository that takes a while.
            </Txt>
            <Checkbox checked={allBranches} onChange={setAllBranches} label="Also follow every branch of the remote" />
          </View>
        )}
      </View>
    </Modal>
  );
}

/**
 * Fork's Pull: which branch of which remote goes into the current branch (its upstream by default), merge, rebase
 * or fast-forward only, and whether local changes are stashed around it. What the pull brings is said before.
 */
function PullDialog() {
  const t = useTheme();
  const repo = useRepo();
  const prefs = useStore((s) => s.syncPrefs);
  const pullMode = useStore((s) => s.serverSettings?.pullMode ?? 'merge');
  const cur = repo.refs.find((r) => r.kind === 'branch' && r.current);
  const upRemote = live.upstreamRemote(repo, cur?.upstream);
  const defaultBranch = (rm: string) => {
    const list = branchesOn(repo.refs, rm);
    if (cur?.upstream && upRemote === rm) return cur.upstream.slice(rm.length + 1);
    if (cur && list.includes(cur.name)) return cur.name;
    return list.find((b) => b === 'main' || b === 'master') ?? list[0] ?? '';
  };
  const [remote, setRemote] = useState(upRemote ?? repo.remotes[0]?.name ?? '');
  const [branch, setBranch] = useState(() => defaultBranch(remote));
  const [strategy, setStrategy] = useState<'merge' | 'rebase' | 'ff'>(pullMode);
  const [autostash, setAutostash] = useState(prefs.pullAutostash);
  const changes = repo.unstaged.length + repo.staged.length;
  const from = `${remote}/${branch}`;
  const fromUpstream = !!cur?.upstream && cur.upstream === from;
  const upShort = cur?.upstream && upRemote === remote ? cur.upstream.slice(remote.length + 1) : undefined;
  const names = branchesOn(repo.refs, remote);
  const branchOptions = [...(upShort && names.includes(upShort) ? [upShort] : []), ...names.filter((b) => b !== upShort)].map((b) => ({ value: b, label: b, hint: b === upShort ? 'upstream' : undefined }));
  const ready = !!cur && !!remote && !!branch;
  const go = () => {
    if (!ready) return;
    setSyncPrefs({ pullAutostash: autostash });
    // the mode is the Preferences' pull mode: what the toolbar's quick pull uses next time
    if (strategy !== pullMode && live.isLiveActive()) void live.saveSettings({ pullMode: strategy });
    pull({ strategy, remote, branch, autostash });
  };
  useEnter(go, ready);
  return (
    <Modal
      title="Pull"
      width={520}
      icon={<Icon name="pull" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Pull" primary style={{ marginLeft: 8 }} disabled={!ready} onPress={go} testID="pull-go" />
        </>
      }
    >
      <View testID="pull-dialog">
        {!cur ? (
          <Txt size={FONT.sm} color={t.warn}>
            HEAD is detached: check out the branch to pull into first.
          </Txt>
        ) : !repo.remotes.length ? (
          <Txt size={FONT.sm} muted>
            This repository has no remotes to pull from.
          </Txt>
        ) : (
          <>
            <Line label="Remote">
              <Select value={remote} options={repo.remotes.map((r) => ({ value: r.name, label: r.name, hint: r.url }))} onChange={(rm) => { setRemote(rm); setBranch(defaultBranch(rm)); }} icon="cloud" testID="pull-remote" />
            </Line>
            <Line label="Branch">
              <Select value={branch} options={branchOptions} onChange={setBranch} icon="branch" placeholder="no branches on this remote: fetch first" testID="pull-branch" />
            </Line>
            <Line label="Into">
              <View style={{ flexDirection: 'row', alignItems: 'center', height: 26 }}>
                <View style={{ width: 7, height: 7, backgroundColor: t.accent, marginRight: 6 }} />
                <Txt size={FONT.md} weight="600" numberOfLines={1}>
                  {cur.name}
                </Txt>
              </View>
            </Line>
            <Note color={fromUpstream && cur.behind ? t.info : undefined}>
              {fromUpstream
                ? `${cur.behind ? `${plural(cur.behind, 'new commit')} from ${from}` : `up to date with ${from} (as of the last fetch)`}${cur.ahead ? ` · ${plural(cur.ahead, 'local commit')} not pushed yet` : ''}`
                : `${from} is not what ${cur.name} tracks${cur.upstream ? ` (${cur.upstream})` : ''}: it is pulled in this once, the upstream stays`}
            </Note>
            <Line label="Mode" top>
              <Radio checked={strategy === 'merge'} onPress={() => setStrategy('merge')} label="Merge" hint="a merge commit when the branches have diverged" />
              <Radio checked={strategy === 'rebase'} onPress={() => setStrategy('rebase')} label="Rebase" hint="your local commits replayed on top of the pulled ones" />
              <Radio checked={strategy === 'ff'} onPress={() => setStrategy('ff')} label="Fast-forward only" hint="stop if the branches have diverged" />
            </Line>
            <Line label="Options" top>
              <Checkbox checked={autostash} onChange={setAutostash} label="Stash and reapply local changes" testID="pull-autostash" />
            </Line>
            {changes > 0 && (
              <Note color={autostash ? undefined : t.warn}>
                {autostash ? `${plural(changes, 'local change')} go to the stash and come back after the pull` : `${plural(changes, 'local change')}: git stops if the pulled commits touch the same files`}
              </Note>
            )}
          </>
        )}
      </View>
    </Modal>
  );
}

/**
 * Fork's Push: which local branch (the current one by default) goes to which branch of which remote — the one it
 * tracks, else the same name (a new branch there) — and whether it tracks it after, all tags, force. What happens
 * on the remote is said before.
 */
function PushDialog({ branch: initial }: { branch?: string }) {
  const t = useTheme();
  const repo = useRepo();
  const prefs = useStore((s) => s.syncPrefs);
  const locals = repo.refs.filter((r) => r.kind === 'branch');
  const cur = locals.find((r) => r.current);
  const remoteFor = (l?: Ref) => live.upstreamRemote(repo, l?.upstream) ?? repo.remotes[0]?.name ?? '';
  const nameOn = (l: Ref | undefined, rm: string) => (l?.upstream && live.upstreamRemote(repo, l.upstream) === rm ? l.upstream.slice(rm.length + 1) : l?.name ?? '');
  const [branch, setBranch] = useState(initial ?? cur?.name ?? locals[0]?.name ?? '');
  const local = locals.find((r) => r.name === branch);
  const [remote, setRemote] = useState(() => remoteFor(local));
  const [remoteBranch, setRemoteBranch] = useState(() => nameOn(local, remote));
  const [track, setTrack] = useState(!local?.upstream);
  const [tags, setTags] = useState(prefs.pushTags);
  const [force, setForce] = useState(false);
  const pickBranch = (b: string) => {
    const l = locals.find((r) => r.name === b);
    const rm = remoteFor(l);
    setBranch(b);
    setRemote(rm);
    setRemoteBranch(nameOn(l, rm));
    setTrack(!l?.upstream);
  };
  const pickRemote = (rm: string) => {
    setRemote(rm);
    setRemoteBranch(nameOn(local, rm));
  };
  const target = `${remote}/${remoteBranch}`;
  const exists = repo.refs.some((r) => r.kind === 'remote' && r.name === target);
  const tracks = local?.upstream === target;
  const valid = /^[\w./-]+$/.test(remoteBranch) && !remoteBranch.includes('..') && !remoteBranch.startsWith('-') && !remoteBranch.startsWith('/') && !remoteBranch.endsWith('/') && !remoteBranch.endsWith('.lock');
  const ready = !!local && !!remote && valid;
  const go = () => {
    if (!ready) return;
    setSyncPrefs({ pushTags: tags });
    push({ remote, branch, remoteBranch, force, tags, setUpstream: track && !tracks });
  };
  useEnter(go, ready);
  const existing = branchesOn(repo.refs, remote);
  const status = !local
    ? ''
    : tracks
      ? `${local.ahead ? `${plural(local.ahead, 'commit')} to push` : 'nothing new to push'}${local.behind ? ` · ${plural(local.behind, 'commit')} on ${target} are not here: pull first, or force push` : ''}`
      : exists
        ? `updates ${target}, which ${branch} does not track`
        : `creates ${remoteBranch || '…'} on ${remote}`;
  return (
    <Modal
      title="Push"
      width={540}
      icon={<Icon name="push" size={18} color={force ? t.del : t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label={force ? 'Force push' : 'Push'} primary={!force} danger={force} style={{ marginLeft: 8 }} disabled={!ready} onPress={go} testID="push-go" />
        </>
      }
    >
      <View testID="push-dialog">
        {!locals.length || !repo.remotes.length ? (
          <Txt size={FONT.sm} muted>
            {!locals.length ? 'There is no local branch to push.' : 'This repository has no remotes. Add one under Remotes in the sidebar.'}
          </Txt>
        ) : (
          <>
            <Line label="Branch">
              <Select
                value={branch}
                options={[...(cur ? [cur] : []), ...locals.filter((r) => !r.current)].map((r) => ({ value: r.name, label: r.name, hint: r.current ? 'current' : r.upstream ? `${r.ahead ? `↑${r.ahead} ` : ''}${r.upstream}` : 'not published' }))}
                onChange={pickBranch}
                icon="branch"
                testID="push-branch"
              />
            </Line>
            <Line label="To">
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 150 }}>
                  <Select value={remote} options={repo.remotes.map((r) => ({ value: r.name, label: r.name, hint: r.url }))} onChange={pickRemote} icon="cloud" showHint={false} testID="push-remote" />
                </View>
                <Txt size={FONT.md} muted style={{ marginHorizontal: 6 }}>
                  /
                </Txt>
                <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Input value={remoteBranch} onChange={setRemoteBranch} mono small placeholder="branch on the remote" testID="push-remote-branch" />
                  </View>
                  {existing.length > 0 && (
                    <PressScale
                      scaleTo={0.94}
                      onPressAt={(a) => showPicker({ anchor: { ...a, x: a.x - 220, w: 240 }, options: existing.map((b) => ({ value: b, label: b })), value: remoteBranch, onPick: setRemoteBranch, filter: existing.length > 12, testID: 'push-remote-branch-list' })}
                      style={{ height: 26, width: 22, marginLeft: 2, alignItems: 'center', justifyContent: 'center', backgroundColor: t.raised }}
                      hoverStyle={{ backgroundColor: t.hover }}
                      label={`Branches on ${remote}`}
                      testID="push-remote-branch-pick"
                    >
                      <Txt size={FONT.xs} muted>
                        ▾
                      </Txt>
                    </PressScale>
                  )}
                </View>
              </View>
            </Line>
            <Note color={!valid && remoteBranch ? t.del : local?.behind && tracks ? t.warn : undefined}>{!valid && remoteBranch ? 'Not a valid branch name' : status}</Note>
            <Line label="Options" top>
              {tracks ? (
                <Checkbox checked disabled onChange={() => {}} label={`${branch} tracks ${target}`} testID="push-track" />
              ) : (
                <Checkbox checked={track} onChange={setTrack} label={`Track ${target} (create the tracking reference)`} testID="push-track" />
              )}
              <Checkbox checked={tags} onChange={setTags} label="Push all tags" testID="push-tags" />
              <Checkbox checked={force} onChange={setForce} label="Force push (--force-with-lease)" testID="push-force" />
            </Line>
            {force && <Note color={t.del}>{`${target} is overwritten with ${branch}: commits only it has are lost there (unless someone pushed meanwhile — then git refuses).`}</Note>}
          </>
        )}
      </View>
    </Modal>
  );
}

// ---------- branch / merge / tag / reset / stash ----------

function BranchDialog({ fromSha }: { fromSha?: string }) {
  const t = useTheme();
  const repo = useRepo();
  const [name, setName] = useState('');
  const [co, setCo] = useState(true);
  const base = fromSha ?? repo.head;
  const baseCommit = findCommit(repo, base);
  const baseRef = repo.refs.find((r) => r.sha === base && r.kind === 'branch');
  const valid = /^[\w./-]+$/.test(name) && !name.endsWith('/') && !name.includes('..');
  const stored = storedName(name, repo.refs);
  return (
    <Modal
      title="New branch"
      width={440}
      icon={<Icon name="branch" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Create" primary style={{ marginLeft: 8 }} disabled={!valid} onPress={() => createBranch(name, base, co)} />
        </>
      }
    >
      <Field label="Branch name">
        <Input value={name} onChange={setName} placeholder="feature/…" mono autoFocus onSubmit={() => valid && createBranch(name, base, co)} />
      </Field>
      {name && !valid ? (
        <Txt size={FONT.xs} color={t.del} style={{ marginTop: 4 }}>
          Invalid branch name
        </Txt>
      ) : null}
      {valid && stored !== name ? (
        <Txt size={FONT.xs} color={t.warn} style={{ marginTop: 4 }} testID="branch-case-note">
          {`${stored.split('/').slice(0, -1).join('/')}/ already exists: on this Mac names that differ only in case are one folder, so the branch is ${stored}`}
        </Txt>
      ) : null}
      <Txt size={FONT.sm} muted style={{ marginTop: 10 }}>
        From: <Txt size={FONT.sm} mono>{shortSha(base)}</Txt> {baseRef ? `(${baseRef.name})` : ''} — {baseCommit?.subject}
      </Txt>
      <View style={{ marginTop: 10 }}>
        <Checkbox checked={co} onChange={setCo} label="Checkout new branch" />
      </View>
    </Modal>
  );
}

function MergeDialog({ source: initial }: { source?: string }) {
  const t = useTheme();
  const repo = useRepo();
  const current = repo.refs.find((r) => r.kind === 'branch' && r.current);
  const [source, setSource] = useState(initial ?? '');
  const [noFf, setNoFf] = useState(false);
  const [squash, setSquash] = useState(false);
  return (
    <Modal
      title="Merge"
      width={480}
      icon={<Icon name="merge" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label={`Merge into ${current?.name ?? ''}`} primary style={{ marginLeft: 8 }} disabled={!source} onPress={() => merge(source, { noFf, squash })} />
        </>
      }
    >
      <Txt size={FONT.sm} muted style={{ marginBottom: 6 }}>
        Merge into <Txt size={FONT.sm} weight="600">{current?.name}</Txt>:
      </Txt>
      <BranchPicker value={source} onChange={setSource} exclude={current?.name} kinds={['branch', 'remote', 'tag']} />
      <View style={{ marginTop: 10 }}>
        <Checkbox checked={noFf} onChange={setNoFf} label="Always create a merge commit (--no-ff)" />
        <Checkbox checked={squash} onChange={setSquash} label="Squash commits (--squash)" />
      </View>
    </Modal>
  );
}

function TagDialog({ sha }: { sha: string }) {
  const t = useTheme();
  const repo = useRepo();
  const [name, setName] = useState('');
  const [annotated, setAnnotated] = useState(true);
  const [msg, setMsg] = useState('');
  const [pushIt, setPushIt] = useState(false);
  const c = findCommit(repo, sha);
  return (
    <Modal
      title="New tag"
      width={440}
      icon={<Icon name="tag" size={18} color={t.tag} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Create tag" primary style={{ marginLeft: 8 }} disabled={!name.trim()} onPress={() => createTag(name.trim(), sha, annotated, pushIt)} />
        </>
      }
    >
      <Field label="Tag name">
        <Input value={name} onChange={setName} placeholder="v1.1.0" mono autoFocus />
      </Field>
      <Txt size={FONT.sm} muted style={{ marginTop: 8 }}>
        At <Txt size={FONT.sm} mono>{shortSha(sha)}</Txt> — {c?.subject}
      </Txt>
      <View style={{ marginTop: 10 }}>
        <Checkbox checked={annotated} onChange={setAnnotated} label="Annotated tag" />
      </View>
      {annotated && (
        <Field label="Message" style={{ marginTop: 8 }}>
          <Input value={msg} onChange={setMsg} multiline />
        </Field>
      )}
      <View style={{ marginTop: 8 }}>
        <Checkbox checked={pushIt} onChange={setPushIt} label="Push tag to origin" />
      </View>
    </Modal>
  );
}

function ResetDialog({ sha }: { sha: string }) {
  const t = useTheme();
  const repo = useRepo();
  const [mode, setMode] = useState<'soft' | 'mixed' | 'hard'>('mixed');
  const current = repo.refs.find((r) => r.kind === 'branch' && r.current);
  const c = findCommit(repo, sha);
  return (
    <Modal
      title={`Reset ${current?.name ?? 'HEAD'}`}
      width={460}
      icon={<Icon name="undo" size={18} color={t.warn} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Reset" primary={mode !== 'hard'} danger={mode === 'hard'} style={{ marginLeft: 8 }} onPress={() => reset(sha, mode)} />
        </>
      }
    >
      <Txt size={FONT.sm} muted>
        Move <Txt size={FONT.sm} weight="600">{current?.name}</Txt> to <Txt size={FONT.sm} mono>{shortSha(sha)}</Txt> — {c?.subject}
      </Txt>
      <View style={{ marginTop: 10 }}>
        <Radio checked={mode === 'soft'} onPress={() => setMode('soft')} label="Soft" hint="Keep all changes staged" />
        <Radio checked={mode === 'mixed'} onPress={() => setMode('mixed')} label="Mixed" hint="Keep changes in the working copy, unstaged" />
        <Radio checked={mode === 'hard'} onPress={() => setMode('hard')} label="Hard" hint="Discard all changes. Cannot be undone." />
      </View>
    </Modal>
  );
}

function StashDialog() {
  const t = useTheme();
  const repo = useRepo();
  const [msg, setMsg] = useState('');
  const [keep, setKeep] = useState(false);
  const [untracked, setUntracked] = useState(true);
  const n = repo.unstaged.length + repo.staged.length;
  return (
    <Modal
      title="Stash changes"
      width={440}
      icon={<Icon name="stash" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Stash" primary style={{ marginLeft: 8 }} disabled={n === 0} onPress={() => stash(msg, keep, untracked)} />
        </>
      }
    >
      <Field label="Message (optional)">
        <Input value={msg} onChange={setMsg} placeholder="WIP on …" autoFocus onSubmit={() => n > 0 && stash(msg, keep, untracked)} />
      </Field>
      <Txt size={FONT.sm} muted style={{ marginTop: 8 }}>
        {n} changed file{n === 1 ? '' : 's'} will be stashed.
      </Txt>
      <View style={{ marginTop: 10 }}>
        <Checkbox checked={keep} onChange={setKeep} label="Keep staged changes (--keep-index)" />
        <Checkbox checked={untracked} onChange={setUntracked} label="Include untracked files (-u)" />
      </View>
    </Modal>
  );
}

/**
 * A new branch's name as a case-insensitive disk (macOS) will keep it: an existing folder (`tmp/`) keeps its
 * spelling, so `Tmp/x` becomes `tmp/x` — what the engine does too.
 */
function storedName(name: string, refs: Ref[]) {
  const names = refs.filter((r) => r.kind === 'branch').map((r) => r.name);
  const parts = name.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const prefix = parts.slice(0, i + 1).join('/').toLowerCase() + '/';
    const existing = names.find((n) => n.toLowerCase().startsWith(prefix));
    if (existing) parts.splice(0, i + 1, ...existing.split('/').slice(0, i + 1));
  }
  return parts.join('/');
}

// ---------- command palette ----------

function PaletteDialog() {
  const t = useTheme();
  const repo = useRepo();
  const undoTop = useStore((s) => (s.activeTab ? s.undo[s.activeTab]?.at(-1) : undefined));
  const workspaces = useStore((s) => s.workspaces);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const commands: { label: string; icon: IconName; shortcut?: string; run: () => void; group: string }[] = [
    ...(undoTop ? [{ label: `Undo ${undoTop.label}`, icon: 'undo' as IconName, shortcut: '⌘Z', run: () => live.undoLast(), group: 'Repository' }] : []),
    { label: 'Fetch…', icon: 'fetch', shortcut: '⌘⇧F', run: () => openDialog({ type: 'fetch' }), group: 'Remote' },
    { label: 'Fetch all remotes now', icon: 'fetch', run: () => fetch({}), group: 'Remote' },
    ...(repo.shallow ? [{ label: 'Fetch the full history (unshallow)', icon: 'history' as IconName, run: () => unshallow(), group: 'Remote' }] : []),
    ...repo.remotes.filter((r) => r.narrow).map((r) => ({ label: `Fetch every branch of ${r.name}`, icon: 'fetch' as IconName, run: () => followAllBranches(r.name), group: 'Remote' })),
    { label: 'Pull', icon: 'pull', shortcut: '⌘⇧L', run: () => openDialog({ type: 'pull' }), group: 'Remote' },
    { label: 'Push', icon: 'push', shortcut: '⌘⇧P', run: () => openDialog({ type: 'push' }), group: 'Remote' },
    { label: 'Show local changes', icon: 'edit', shortcut: '⌘1', run: () => (closeDialog(), setSection('changes')), group: 'View' },
    { label: 'Show all commits', icon: 'commit', shortcut: '⌘2', run: () => (closeDialog(), setSection('commits')), group: 'View' },
    { label: 'Next colour scheme', icon: 'sun', run: () => (closeDialog(), toggleTheme()), group: 'View' },
    ...SCHEMES.map((s) => ({ label: `Scheme: ${s.label}`, icon: 'sun' as IconName, run: () => (closeDialog(), setTheme(s.id)), group: 'View' })),
    { label: 'Zoom in', icon: 'plus', shortcut: '⌘+', run: () => (closeDialog(), stepUiScale(1)), group: 'View' },
    { label: 'Zoom out', icon: 'minus', shortcut: '⌘−', run: () => (closeDialog(), stepUiScale(-1)), group: 'View' },
    { label: 'Reset zoom', icon: 'undo', shortcut: '⌘0', run: () => (closeDialog(), stepUiScale(0)), group: 'View' },
    ...workspaces.map((w) => ({ label: `Workspace: @${w.name}`, icon: 'layers' as IconName, run: () => (closeDialog(), switchWorkspace(w.id)), group: 'Workspace' })),
    { label: 'New workspace…', icon: 'layers', run: () => openDialog({ type: 'workspace' }), group: 'Workspace' },
    { label: 'Ask the agent', icon: 'agent', shortcut: '⌘J', run: () => (closeDialog(), toggleAgentBar(true)), group: 'Agent' },
    { label: 'Agent chat window', icon: 'agent', shortcut: '⌘⇧J', run: () => (closeDialog(), toggleAgent(true)), group: 'Agent' },
    { label: 'New branch…', icon: 'branch', run: () => openDialog({ type: 'branch' }), group: 'Branch' },
    { label: 'Merge…', icon: 'merge', run: () => openDialog({ type: 'merge' }), group: 'Branch' },
    { label: 'Rebase…', icon: 'rebase', run: () => openDialog({ type: 'rebase' }), group: 'Branch' },
    { label: 'Interactive rebase onto origin/main…', icon: 'rebase', run: () => openDialog({ type: 'rebase', interactive: true, onto: 'origin/main' }), group: 'Branch' },
    { label: 'Stash changes…', icon: 'stash', run: () => openDialog({ type: 'stash' }), group: 'Changes' },
    { label: 'New tag…', icon: 'tag', run: () => openDialog({ type: 'tag', sha: repo.head }), group: 'Branch' },
    { label: 'Clone repository…', icon: 'clone', run: () => openDialog({ type: 'clone' }), group: 'Repository' },
    { label: 'Open a repository…', icon: 'folder', shortcut: '⌘T', run: () => (closeDialog(), openRepoPickerCentered()), group: 'Repository' },
    { label: 'Open a folder…', icon: 'folder', run: () => openDialog({ type: 'open' }), group: 'Repository' },
    { label: 'Welcome screen', icon: 'home', run: () => (closeDialog(), goWelcome()), group: 'Repository' },
    { label: 'Open in Terminal', icon: 'terminal', run: () => (closeDialog(), toast('Opened terminal', 'info')), group: 'Repository' },
    { label: 'Preferences', icon: 'settings', shortcut: '⌘,', run: () => openDialog({ type: 'accounts', tab: 'general' }), group: 'App' },
    { label: 'Accounts', icon: 'github', run: () => openDialog({ type: 'accounts', tab: 'github' }), group: 'App' },
    { label: 'SSH keys', icon: 'key', run: () => openDialog({ type: 'accounts', tab: 'ssh' }), group: 'App' },
    { label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: '⌘/', run: () => openDialog({ type: 'shortcuts' }), group: 'App' },
    ...repo.refs
      .filter((r) => r.kind === 'branch' && !r.current)
      .map((r) => ({ label: `Checkout ${r.name}`, icon: 'branch' as IconName, run: () => (closeDialog(), checkout(r.name)), group: 'Checkout' })),
  ];
  const list = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  const sel = Math.min(idx, list.length - 1);
  useKeyboard((e) => {
    if (e.key === 'ArrowDown') {
      setIdx((i) => Math.min(i + 1, list.length - 1));
      e.preventDefault();
    }
    if (e.key === 'ArrowUp') {
      setIdx((i) => Math.max(i - 1, 0));
      e.preventDefault();
    }
    if (e.key === 'Enter' && list[sel]) {
      e.preventDefault();
      list[sel].run();
    }
  });
  return (
    <Modal title="Command palette" width={560}>
      <Input value={q} onChange={(v) => (setQ(v), setIdx(0))} placeholder="type a command" slash autoFocus />
      <ScrollView style={{ maxHeight: 320, marginTop: 8 }}>
        {list.map((c, i) => (
          <Row key={c.label} height={30} selected={i === sel} onPress={c.run} style={{ borderRadius: 0 }}>
            <Icon name={c.icon} size={14} color={i === sel ? t.accent : t.textMuted} />
            <Txt style={{ marginLeft: 10, flex: 1 }}>{c.label}</Txt>
            <Txt size={FONT.xs} faint style={{ marginRight: 6 }}>
              {c.group}
            </Txt>
            {c.shortcut && <Kbd>{c.shortcut}</Kbd>}
          </Row>
        ))}
      </ScrollView>
    </Modal>
  );
}

export function RecentCommitsPreview() {
  const repo = useRepo();
  return (
    <View>
      {repo.commits.slice(0, 3).map((c) => (
        <View key={c.sha} style={{ flexDirection: 'row', alignItems: 'center', height: 22 }}>
          <Avatar name={c.author} email={c.email} size={14} />
          <Txt size={FONT.sm} style={{ marginLeft: 6, flex: 1 }} numberOfLines={1}>
            {c.subject}
          </Txt>
          <Txt size={FONT.xs} faint>
            {relTime(c.date)}
          </Txt>
        </View>
      ))}
      <View style={{ flexDirection: 'row', marginTop: 4 }}>
        {repo.refs
          .filter((r) => r.kind === 'branch')
          .slice(0, 3)
          .map((r) => (
            <RefChip key={r.name} r={r} compact />
          ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pickerList: { height: 160, borderWidth: 1, borderRadius: 0, marginTop: 6 },
  todoList: { maxHeight: 260, borderWidth: 1, borderRadius: 0 },
  todoRow: { paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 1 },
  actionChip: { width: 60, height: 20, borderRadius: 0, borderWidth: 1, justifyContent: 'center', alignItems: 'center', marginLeft: 6 },
});
