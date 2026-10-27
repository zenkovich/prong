import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { addGitHubAccount, cloneRepo, closeDialog, deleteSshKey, generateSshKey, getState, openDialog, openLocalRepo, removeGitHubAccount, setFileView, setTheme, setUiScale, toast, updateSshKey, useStore } from '../state/store';
import * as live from '../state/live';
import type { GhAccess, GhRepo } from '../git/GitClient';
import type { RepoAuth } from '../git/types';
import { FONT, SCHEMES, THEMES, UI_SCALES, useTheme } from '../theme';
import { desktop, pickFolder } from '../desktop';
import { Icon } from '../ui/Icon';
import { Modal, useModalResized } from '../ui/overlays';
import { Avatar, Badge, Button, Checkbox, Input, PressScale, Radio, Row, Segmented, Spinner, Txt } from '../ui/primitives';
import { AccountBadge } from '../screens/Welcome';
import { Select } from './Select';

// ---------- clone / open / init ----------

/** a connection as the Clone dialog's choice, and back */
const choiceOfAuth = (a: RepoAuth): string => (a.kind === 'ssh' ? `ssh:${a.key}` : a.kind === 'account' ? `account:${a.account}` : 'default');
const authOfChoice = (c: string): RepoAuth => (c.startsWith('ssh:') ? { kind: 'ssh', key: c.slice(4) } : c.startsWith('account:') ? { kind: 'account', account: c.slice(8) } : { kind: 'default' });

/** a list with a sensible height when its dialog opens, and all the height the dialog is given once it is resized */
function GrowingList({ style, children }: { style: any; children: React.ReactNode }) {
  const resized = useModalResized();
  return <ScrollView style={[style, !resized && { maxHeight: 260 }]}>{children}</ScrollView>;
}

export function CloneDialog({ initialUrl }: { initialUrl?: string }) {
  const t = useTheme();
  const accounts = useStore((s) => s.accounts);
  const [source, setSource] = useState<'url' | 'github'>(initialUrl ? 'url' : 'github');
  const [url, setUrl] = useState(initialUrl ?? '');
  // the workspace's folder: a clone there is found by its scan
  const [dir, setDir] = useState(() => {
    const s = getState();
    return s.workspaces.find((w) => w.id === s.activeWorkspace)?.rootPath ?? '~/work';
  });
  const [recursive, setRecursive] = useState(true);
  const [partial, setPartial] = useState(false);
  const [filter, setFilter] = useState('');
  // the folder name follows the address until the user types one (it used to ignore typing)
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const autoName = url.trim().replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') || '';
  const name = nameEdit ?? autoName;
  const nameOk = !!name.trim() && !/[/\\]/.test(name) && name.trim() !== '.' && name.trim() !== '..';
  const go = (u = url.trim()) => u && nameOk && cloneRepo(u, dir, recursive, authOfChoice(conn), partial, name.trim());
  const engine = useStore((s) => s.engine);
  const [ghRepos, setGhRepos] = useState<GhRepo[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const accountId = picked ?? accounts[0]?.id;
  const account = accounts.find((a) => a.id === accountId);
  const signIn = useStore((s) => (accountId ? s.accountStatus[accountId] : undefined));
  const expired = signIn?.state === 'expired';
  const [access, setAccess] = useState<GhAccess | null>(null);
  useEffect(() => {
    // an expired sign-in would only fail: it is said here, with the way out
    if (!engine.online || !accountId || expired) return;
    void live.githubRepos(accountId).then(setGhRepos);
    void live.githubAccess(accountId).then(setAccess);
  }, [engine.online, accountId, expired]);
  const appOnly = access?.kind === 'app';
  const installedOn = access?.installations.map((i) => i.account) ?? [];
  const slug = access?.installations[0]?.slug;
  // the connection to clone with: suggested from the owner's other repositories until the user picks one
  const keys = useStore((s) => s.sshKeys);
  const [conn, setConn] = useState<string>('default');
  const [connTouched, setConnTouched] = useState(false);
  const [connFrom, setConnFrom] = useState<string | null>(null);
  const [connTest, setConnTest] = useState<{ running: boolean; ok?: boolean; output?: string } | null>(null);
  useEffect(() => {
    if (!engine.online || connTouched || !url.trim()) return;
    const h = setTimeout(() => {
      void live.client.cloneHint(url.trim()).then(
        (hint) => {
          setConn(hint ? choiceOfAuth(hint.auth) : 'default');
          setConnFrom(hint?.from ?? null);
        },
        () => {},
      );
    }, 300);
    return () => clearTimeout(h);
  }, [url, engine.online, connTouched]);
  const connOptions = [
    { value: 'default', label: 'System default', hint: 'ssh-agent, ~/.ssh/config, id_*' },
    ...keys.map((k) => ({ value: `ssh:${k.name}`, label: `SSH key ${k.name}`, hint: k.type })),
    ...accounts.map((a) => ({ value: `account:${a.id}`, label: `Account ${a.login}`, hint: `HTTPS · ${a.host}` })),
  ];
  const testConn = async () => {
    setConnTest({ running: true });
    const r = await live.client.cloneTest(url.trim(), authOfChoice(conn)).catch((e) => ({ ok: false, output: String(e?.message ?? e), describe: '' }));
    setConnTest({ running: false, ok: r.ok, output: r.output });
  };
  const list = (ghRepos ?? []).map((r) => r.fullName).filter((r) => r.toLowerCase().includes(filter.toLowerCase()));
  const urlFor = (full: string) => (engine.online ? ghRepos?.find((r) => r.fullName === full)?.sshUrl ?? `git@github.com:${full}.git` : `git@github.com:${full}.git`);
  return (
    <Modal
      title="Clone repository"
      width={600}
      fill
      icon={<Icon name="clone" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Clone" primary icon="fetch" style={{ marginLeft: 8 }} disabled={!url.trim() || !nameOk} onPress={() => go()} testID="clone-go" />
        </>
      }
    >
      <Segmented value={source} onChange={setSource} options={[{ value: 'github', label: 'GitHub', icon: 'github' }, { value: 'url', label: 'URL', icon: 'link' }]} />
      {source === 'github' && (
        <View style={{ marginTop: 12, flex: 1, minHeight: 0 }}>
          {accounts.length === 0 ? (
            <View style={{ alignItems: 'center', padding: 16 }}>
              <Txt muted>No GitHub account connected.</Txt>
              <Button label="Connect GitHub" icon="github" primary style={{ marginTop: 10 }} onPress={() => openDialog({ type: 'accounts', tab: 'github' })} testID="clone-connect-github" />
            </View>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {accounts.length > 1 ? (
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Select value={accountId ?? ''} options={accounts.map((a) => ({ value: a.id, label: a.login, hint: a.orgs.join(', ') || a.host }))} onChange={(id) => {
                        // the other account's list replaces this one's
                        setGhRepos(null);
                        setAccess(null);
                        setPicked(id);
                      }}
                      icon="github"
                      testID="clone-account"
                    />
                  </View>
                ) : (
                  <>
                    <Avatar name={account?.name ?? ''} color={account?.avatarColor} size={18} />
                    <Txt size={FONT.sm} style={{ marginLeft: 6, flex: 1 }}>
                      {account?.login} · {account?.orgs.join(', ') || 'no orgs'}
                    </Txt>
                  </>
                )}
                <Input value={filter} onChange={setFilter} placeholder="Filter repositories" icon="search" small style={{ width: 220 }} />
              </View>
              {expired && (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, padding: 8, backgroundColor: t.del + '14' }} testID="clone-signin-expired">
                  <Icon name="warning" size={13} color={t.del} />
                  <Txt size={FONT.sm} style={{ marginLeft: 8, flex: 1 }}>
                    GitHub no longer accepts the sign-in of {account?.login}: sign in again to see its repositories (or clone by URL).
                  </Txt>
                  <Button small primary label="Sign in again…" onPress={() => openDialog({ type: 'accounts', tab: 'github' })} />
                </View>
              )}
              <GrowingList style={[styles.list, { borderColor: t.border, backgroundColor: t.bg }]}>
                {engine.online && accounts[0] && ghRepos === null && !expired && (
                  <Txt size={FONT.sm} faint style={{ padding: 8 }} testID="clone-loading">
                    loading repositories…
                  </Txt>
                )}
                {ghRepos && !list.length && (
                  <Txt size={FONT.sm} faint style={{ padding: 8 }}>
                    {filter ? 'nothing matches' : 'no repositories'}
                  </Txt>
                )}
                {list.map((r) => {
                  const u = urlFor(r);
                  return (
                    <Row key={r} height={26} selected={url === u} onPress={() => (setUrl(u), setNameEdit(null))} onDoublePress={() => go(u)} testID={`clone-repo-${r}`}>
                      <Icon name="github" size={12} color={t.textMuted} />
                      <Txt size={FONT.sm} style={{ marginLeft: 8, flex: 1 }}>
                        {r}
                      </Txt>
                      <Txt size={FONT.xs} faint>
                        {ghRepos?.find((x) => x.fullName === r)?.private ? 'private' : 'public'}
                      </Txt>
                    </Row>
                  );
                })}
              </GrowingList>
              {ghRepos && (
                <Txt size={FONT.xs} faint style={{ marginTop: 4 }} testID="clone-count">
                  {ghRepos.length} repositor{ghRepos.length === 1 ? 'y' : 'ies'}
                  {filter ? ` · ${list.length} shown` : ''}
                </Txt>
              )}
              {appOnly && (
                <View style={{ marginTop: 8, padding: 8, backgroundColor: t.info + '14' }} testID="clone-app-note">
                  <Txt size={FONT.xs}>
                    {account?.login} is signed in through a GitHub App: the list holds public repositories and those of the accounts and organizations the app is installed on (
                    {installedOn.length ? installedOn.join(', ') : 'none yet'}). An organization’s private repositories (Playrix, say) appear once the app is installed there — its owners approve that — or
                    after signing in with a personal access token. Cloning by URL works either way: your SSH key decides, not this list.
                  </Txt>
                  <View style={{ flexDirection: 'row', marginTop: 6, flexWrap: 'wrap', gap: 6 } as any}>
                    <Button small label="Sign in with a token…" icon="key" onPress={() => openDialog({ type: 'accounts', tab: 'github', token: true })} testID="clone-use-token" />
                    <Button small label={slug ? 'Install the app on an organization…' : 'Installed apps…'} icon="external" onPress={() => void live.openUrl(slug ? `https://github.com/apps/${slug}/installations/new` : 'https://github.com/settings/installations')} />
                  </View>
                </View>
              )}
            </>
          )}
        </View>
      )}
      <Field label="Repository URL" style={{ marginTop: 12 }}>
        <Input value={url} onChange={(v) => (setUrl(v), setConnTest(null))} onSubmit={() => go()} placeholder="git@github.com:user/repo.git or https://…" mono autoFocus={source === 'url'} testID="clone-url" />
      </Field>
      <Field label="Connection" style={{ marginTop: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Select
            value={conn}
            options={connOptions}
            onChange={(v) => {
              setConn(v);
              setConnTouched(true);
              setConnFrom(null);
              setConnTest(null);
            }}
            icon="key"
            testID="clone-connection"
          />
          <Button label={connTest?.running ? 'Testing…' : 'Test'} style={{ marginLeft: 6 }} disabled={!url.trim() || connTest?.running} onPress={() => void testConn()} testID="clone-test" />
        </View>
      </Field>
      {connFrom && !connTouched ? (
        <Txt size={FONT.xs} faint style={{ marginTop: 4 }} testID="clone-connection-hint">
          as {connFrom}: the same owner. The clone keeps it for fetch, pull and push, and its submodules use it too.
        </Txt>
      ) : null}
      {connTest && !connTest.running && (
        <Txt size={FONT.xs} color={connTest.ok ? t.add : t.del} style={{ marginTop: 4 }} selectable testID="clone-test-result">
          {connTest.ok ? 'Readable with this connection' : `Not readable with this connection: ${connTest.output?.split('\n').find((l) => /denied|fatal|error|could not/i.test(l)) ?? connTest.output ?? ''}`}
        </Txt>
      )}
      <View style={{ flexDirection: 'row', marginTop: 10 }}>
        <Field label="Parent folder" style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row' }}>
            <Input value={dir} onChange={setDir} mono style={{ flex: 1 }} testID="clone-dir" />
            <Button label="Choose…" icon="folder" style={{ marginLeft: 6 }} testID="clone-choose" onPress={async () => (desktop() ? setDir((await pickFolder('Choose the parent folder for the clone')) ?? dir) : toast('Folder picker is available in the macOS app', 'info'))} />
          </View>
        </Field>
        <Field label="Name" style={{ width: 180, marginLeft: 10 }}>
          <Input value={name} onChange={setNameEdit} onSubmit={() => go()} mono placeholder="repo" testID="clone-name" />
        </Field>
      </View>
      <View style={{ marginTop: 10 }}>
        <Checkbox checked={recursive} onChange={setRecursive} label="Clone submodules recursively" testID="clone-recursive" />
        <Checkbox checked={partial} onChange={setPartial} label="Partial clone: old versions of files are downloaded when needed (for large repositories)" testID="clone-partial" />
      </View>
    </Modal>
  );
}

/** where the Open and Init dialogs start: the active workspace's folder, else home */
const useStartFolder = () => useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspace)?.rootPath?.replace(/\/+$/, '') ?? '~');

export function OpenDialog() {
  const t = useTheme();
  const [path, setPath] = useState(`${useStartFolder()}/`);
  return (
    <Modal
      title="Open repository"
      width={520}
      icon={<Icon name="folder" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Open" primary style={{ marginLeft: 8 }} disabled={!path.trim()} onPress={() => openLocalRepo(path.trim())} testID="open-go" />
        </>
      }
    >
      <Field label="Path to a local git repository">
        <View style={{ flexDirection: 'row' }}>
          <Input value={path} onChange={setPath} mono autoFocus style={{ flex: 1 }} onSubmit={() => openLocalRepo(path.trim())} testID="open-path" />
          <Button label="Browse…" icon="folder" style={{ marginLeft: 6 }} testID="open-browse" onPress={async () => (desktop() ? setPath((await pickFolder('Choose a git repository', 'Open')) ?? path) : toast('Folder picker is available in the macOS app', 'info'))} />
        </View>
      </Field>
      <Txt size={FONT.sm} faint style={{ marginTop: 10 }}>
        Tip: in Finder, ⌥⌘C copies a folder’s path; paste it here.
      </Txt>
    </Modal>
  );
}

export function InitDialog() {
  const t = useTheme();
  const [path, setPath] = useState(`${useStartFolder()}/new-project`);
  const online = useStore((s) => s.engine.online);
  const init = () => {
    if (!path.trim()) return;
    if (online) void live.initPath(path.trim());
    else openLocalRepo(path.trim()); // says the engine is offline
  };
  return (
    <Modal
      title="Initialize repository"
      width={480}
      icon={<Icon name="plus" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Initialize" primary style={{ marginLeft: 8 }} disabled={!path.trim()} onPress={init} testID="init-go" />
        </>
      }
    >
      <Field label="Folder">
        <Input value={path} onChange={setPath} onSubmit={init} mono autoFocus testID="init-path" />
      </Field>
      <Txt size={FONT.sm} faint style={{ marginTop: 10 }}>
        git init: the folder is made if it does not exist; the repository opens, ready for its first commit.
      </Txt>
    </Modal>
  );
}

export function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: any }) {
  return (
    <View style={style}>
      <Txt size={FONT.xs} muted weight="600" style={{ marginBottom: 4 }}>
        {label}
      </Txt>
      {children}
    </View>
  );
}

// ---------- preferences: general / github / ssh ----------

export function AccountsDialog({ tab: initial = 'github', token }: { tab?: 'github' | 'ssh' | 'general'; token?: boolean }) {
  const t = useTheme();
  const [tab, setTab] = useState(initial);
  return (
    <Modal title="Preferences" width={720} icon={<Icon name="settings" size={18} color={t.accent} />}>
      <View style={{ flexDirection: 'row', minHeight: 380 }}>
        <View style={{ width: 150, marginRight: 16 }}>
          {(
            [
              ['general', 'General', 'settings'],
              ['github', 'Accounts', 'github'],
              ['ssh', 'SSH keys', 'key'],
            ] as const
          ).map(([k, label, icon]) => (
            <Row key={k} height={30} selected={tab === k} onPress={() => setTab(k)} style={{ borderRadius: 0 }} testID={`prefs-tab-${k}`}>
              <Icon name={icon} size={14} color={tab === k ? t.accent : t.textMuted} />
              <Txt style={{ marginLeft: 8 }} weight={tab === k ? '600' : '400'}>
                {label}
              </Txt>
            </Row>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          {tab === 'general' && <GeneralPrefs />}
          {tab === 'github' && <GitHubPrefs token={token} />}
          {tab === 'ssh' && <SshPrefs />}
        </View>
      </View>
    </Modal>
  );
}

function GeneralPrefs() {
  const t = useTheme();
  const theme = useStore((s) => s.theme);
  const uiScale = useStore((s) => s.uiScale);
  const engine = useStore((s) => s.engine);
  const settings = useStore((s) => s.serverSettings);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [editor, setEditor] = useState(settings?.editor ?? 'Visual Studio Code');
  const [terminal, setTerminal] = useState(settings?.terminal ?? 'Terminal');
  const [diffTool, setDiffTool] = useState(settings?.diffTool ?? '');
  const pullMode = settings?.pullMode ?? 'rebase';
  const fileView = useStore((s) => s.fileView);
  useEffect(() => {
    if (!engine.online) return;
    void live.readGlobalIdentity().then((i) => {
      setName(i.name);
      setEmail(i.email);
      setIdentityLoaded(true);
    });
  }, [engine.online]);
  const saveTools = () => void live.saveSettings({ editor, terminal, diffTool }).then(() => toast('External tools saved', 'success'));
  return (
    <ScrollView>
      <Txt weight="600" size={FONT.lg}>
        General
      </Txt>
      <Field label="Colour scheme" style={{ marginTop: 12 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 }}>
          {SCHEMES.map((s) => {
            const th = THEMES[s.id];
            const active = s.id === theme;
            return (
              <PressScale key={s.id} onPress={() => setTheme(s.id)} testID={`scheme-${s.id}`} scaleTo={0.97} style={[styles.scheme, { backgroundColor: th.bg, borderColor: active ? t.accent : t.borderStrong, borderWidth: active ? 2 : 1 }]} hoverStyle={{ borderColor: t.accent }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ width: 22, height: 8, backgroundColor: th.accent }} />
                  <Txt size={FONT.sm} color={th.selectionText} weight="700" style={{ backgroundColor: th.accent, paddingHorizontal: 3 }}>
                    ▸
                  </Txt>
                  <View style={{ flex: 1 }} />
                  {th.lanes.slice(0, 4).map((c) => (
                    <View key={c} style={{ width: 6, height: 6, backgroundColor: c, marginLeft: 2 }} />
                  ))}
                </View>
                <Txt size={FONT.sm} color={th.text} weight="600" style={{ marginTop: 6 }}>
                  {s.label}
                </Txt>
                <Txt size={FONT.xs} color={th.textMuted} numberOfLines={1}>
                  {s.hint}
                </Txt>
              </PressScale>
            );
          })}
        </View>
      </Field>
      <Field label={`Interface scale · ${Math.round(uiScale * 100)}%  (⌘+ / ⌘− / ⌘0)`} style={{ marginTop: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Segmented value={String(uiScale)} onChange={(v) => setUiScale(parseFloat(v))} options={UI_SCALES.map((v) => ({ value: String(v), label: `${Math.round(v * 100)}%` }))} />
          <Button small label="Reset" style={{ marginLeft: 8 }} onPress={() => setUiScale(1)} disabled={uiScale === 1} testID="scale-reset" />
        </View>
      </Field>
      <Field label="Lists" style={{ marginTop: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Segmented value={fileView} onChange={(v) => setFileView(v as 'list' | 'tree')} options={[{ value: 'tree', icon: 'tree', label: 'Tree' }, { value: 'list', icon: 'list', label: 'List' }]} />
          <Txt size={FONT.xs} faint style={{ marginLeft: 10 }}>
            files in Changes and commits · remembered
          </Txt>
        </View>
      </Field>
      <View style={{ marginTop: 12 }}>
        <Checkbox checked={settings?.avatars ?? true} onChange={(v) => void live.saveSettings({ avatars: v })} label="Author avatars from GitHub / Gravatar (cached by the engine)" testID="pref-avatars" />
      </View>
      <Txt weight="600" style={{ marginTop: 18 }}>
        Git identity (global)
      </Txt>
      {!engine.online && (
        <Txt size={FONT.xs} faint style={{ marginTop: 4 }}>
          Engine offline: identity is read from and written to ~/.gitconfig when the engine runs.
        </Txt>
      )}
      <View style={{ flexDirection: 'row', marginTop: 8, alignItems: 'flex-end' }}>
        <Field label="user.name" style={{ flex: 1 }}>
          <Input value={name} onChange={setName} placeholder={identityLoaded ? 'not set' : ''} testID="identity-name" />
        </Field>
        <Field label="user.email" style={{ flex: 1, marginLeft: 10 }}>
          <Input value={email} onChange={setEmail} placeholder={identityLoaded ? 'not set' : ''} testID="identity-email" />
        </Field>
        <Button small label="Save" primary style={{ marginLeft: 10, marginBottom: 1 }} disabled={!engine.online} onPress={() => void live.writeGlobalIdentity(name, email)} testID="identity-save" />
      </View>
      <Txt weight="600" style={{ marginTop: 18 }}>
        Default pull behaviour
      </Txt>
      <Radio checked={pullMode === 'merge'} onPress={() => void live.saveSettings({ pullMode: 'merge' })} label="Merge" hint="git pull" />
      <Radio checked={pullMode === 'rebase'} onPress={() => void live.saveSettings({ pullMode: 'rebase' })} label="Rebase" hint="git pull --rebase" />
      <Radio checked={pullMode === 'ff'} onPress={() => void live.saveSettings({ pullMode: 'ff' })} label="Fast-forward only" hint="git pull --ff-only" />
      <Txt weight="600" style={{ marginTop: 18 }}>
        Submodules
      </Txt>
      <Checkbox
        checked={settings?.autoUpdateSubmodules !== false}
        onChange={(v) => void live.saveSettings({ autoUpdateSubmodules: v })}
        label="Update submodules after a checkout, pull, merge or reset"
        testID="pref-auto-submodules"
      />
      <Txt size={FONT.xs} faint style={{ marginLeft: 24, marginTop: 2 }}>
        Only the submodules whose recorded commit changed, that are checked out and still where it was; one you moved
        yourself is left alone.
      </Txt>
      <Txt weight="600" style={{ marginTop: 18 }}>
        External tools
      </Txt>
      <Txt size={FONT.xs} faint style={{ marginTop: 2 }}>
        Application names as shown in /Applications; used by Open in editor / terminal / diff tool.
      </Txt>
      <View style={{ flexDirection: 'row', marginTop: 8, alignItems: 'flex-end' }}>
        <Field label="Editor" style={{ flex: 1 }}>
          <Input value={editor} onChange={setEditor} placeholder="Visual Studio Code" testID="tool-editor" />
        </Field>
        <Field label="Terminal" style={{ flex: 1, marginLeft: 10 }}>
          <Input value={terminal} onChange={setTerminal} placeholder="Terminal / iTerm" testID="tool-terminal" />
        </Field>
        <Field label="Diff / merge tool" style={{ flex: 1, marginLeft: 10 }}>
          <Input value={diffTool} onChange={setDiffTool} placeholder="Kaleidoscope" testID="tool-diff" />
        </Field>
        <Button small label="Save" primary style={{ marginLeft: 10, marginBottom: 1 }} onPress={saveTools} testID="tools-save" />
      </View>
    </ScrollView>
  );
}

function GitHubPrefs({ token: startWithToken }: { token?: boolean }) {
  const t = useTheme();
  const accounts = useStore((s) => s.accounts);
  const status = useStore((s) => s.accountStatus);
  // a fresh look whenever the tab opens: a token can expire while Prong runs
  useEffect(() => {
    void live.checkAccounts();
  }, []);
  const engine = useStore((s) => s.engine);
  const settings = useStore((s) => s.serverSettings);
  const [mode, setMode] = useState<'list' | 'device' | 'pat'>(startWithToken ? 'pat' : 'list');
  const [host, setHost] = useState('github.com');
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState(settings?.githubClientId ?? '');
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<{ code: string; url: string } | null>(null);
  // the sign-in under way, until Cancel or the dialog closes (then GitHub is not asked any more)
  const flow = useRef(0);
  useEffect(() => () => void ++flow.current, []);
  const cancelDevice = () => {
    flow.current++;
    setBusy(false);
    setDevice(null);
    setMode('list');
  };
  const startDevice = async () => {
    if (!engine.online) {
      // demo path without the engine
      setMode('device');
      setDevice({ code: 'B7KD-Q2XM', url: 'https://github.com/login/device' });
      setTimeout(() => {
        addGitHubAccount('github.com', 'demo-user');
        setMode('list');
      }, 3000);
      return;
    }
    if (!clientId.trim()) {
      toast('Device flow needs a GitHub OAuth app client id', 'error', 'create one at github.com/settings/developers and paste it below, or use a token');
      return;
    }
    await live.saveSettings({ githubClientId: clientId.trim() });
    const mine = ++flow.current;
    setMode('device');
    setBusy(true);
    const ok = await live.deviceFlow(clientId.trim(), host, (code, url) => setDevice({ code, url }), () => flow.current !== mine);
    if (flow.current !== mine) return;
    setBusy(false);
    if (ok) setMode('list');
  };
  if (mode === 'device')
    return (
      <View style={{ alignItems: 'center', paddingTop: 30 }}>
        <Icon name="github" size={40} color={t.text} />
        <Txt size={FONT.lg} weight="600" style={{ marginTop: 14 }}>
          Sign in with GitHub
        </Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Txt muted size={FONT.sm}>
            Open{' '}
          </Txt>
          <PressScale onPress={() => void live.openUrl(device?.url ?? 'https://github.com/login/device')}>
            <Txt size={FONT.sm} color={t.accent} style={{ textDecorationLine: 'underline' }}>
              {device?.url ?? 'https://github.com/login/device'}
            </Txt>
          </PressScale>
          <Txt muted size={FONT.sm}>
            {' '}and enter this code:
          </Txt>
        </View>
        <PressScale onPress={() => device && live.copyText(device.code)} style={[styles.code, { backgroundColor: t.bg, borderColor: t.borderStrong }]} testID="device-code">
          <Txt size={26} mono weight="700" style={{ letterSpacing: 4 }}>
            {device?.code ?? '········'}
          </Txt>
        </PressScale>
        <Txt faint size={FONT.xs} style={{ marginTop: 6 }}>
          code copied to the clipboard · click to copy again
        </Txt>
        <View style={{ flexDirection: 'row', marginTop: 14 }}>
          <Button label="Open in browser" icon="link" primary onPress={() => void live.openUrl(device?.url ?? 'https://github.com/login/device')} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16 }}>
          <Spinner />
          <Txt muted size={FONT.sm} style={{ marginLeft: 8 }}>
            Waiting for authorization…
          </Txt>
        </View>
        <Button label="Cancel" style={{ marginTop: 20 }} onPress={cancelDevice} testID="device-cancel" />
      </View>
    );
  const signInWithToken = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    const ok = engine.online ? await live.addAccount(host.trim() || 'github.com', token.trim()) : (addGitHubAccount(host, token), true);
    setBusy(false);
    if (ok) {
      setToken('');
      setMode('list');
    }
  };
  if (mode === 'pat')
    return (
      <View>
        <Txt weight="600" size={FONT.lg}>
          Sign in with a token
        </Txt>
        <Field label="Host" style={{ marginTop: 12 }}>
          <Input value={host} onChange={setHost} mono placeholder="github.com or ghe.company.com" testID="token-host" />
        </Field>
        <Field label="Personal access token (scopes: repo, read:org, admin:public_key)" style={{ marginTop: 10 }}>
          <Input value={token} onChange={setToken} onSubmit={() => void signInWithToken()} mono secure placeholder="ghp_… / github_pat_…" autoFocus testID="token-input" />
        </Field>
        <Txt size={FONT.xs} faint style={{ marginTop: 8 }}>
          The token is validated against the API and stored in the macOS Keychain (service space.zenkovich.prong). Nothing is written to disk in plain text.
        </Txt>
        <Txt size={FONT.xs} faint style={{ marginTop: 6 }}>
          A classic token (repo, read:org) sees every repository you can, organizations’ private ones too — unlike a GitHub App, which sees only where it is installed. For an organization with single sign-on (Playrix), authorize the token for it on GitHub: Settings → Developer settings → Tokens → Configure SSO → Authorize.
        </Txt>
        <Button small label="Create a token on GitHub…" icon="external" style={{ marginTop: 8, alignSelf: 'flex-start' }} testID="token-create" onPress={() => void live.openUrl(`https://${host || 'github.com'}/settings/tokens/new?scopes=repo,read:org,admin:public_key&description=Prong`)} />
        <View style={{ flexDirection: 'row', marginTop: 16 }}>
          <Button label="Back" onPress={() => setMode('list')} testID="token-back" />
          <Button
            testID="token-signin"
            label={busy ? 'Checking…' : 'Sign in'}
            primary
            style={{ marginLeft: 8 }}
            disabled={!token.trim() || busy}
            onPress={() => void signInWithToken()}
          />
        </View>
      </View>
    );
  return (
    <View>
      <Txt weight="600" size={FONT.lg}>
        Accounts
      </Txt>
      <Txt muted size={FONT.sm} style={{ marginTop: 4 }}>
        Used for the repository list when cloning and for uploading SSH keys. Git itself authenticates with your SSH keys or credential helper.
      </Txt>
      <View style={{ marginTop: 12 }}>
        {accounts.length === 0 && (
          <Txt size={FONT.sm} faint>
            No accounts yet.
          </Txt>
        )}
        {accounts.map((a) => (
          <View key={a.id} style={[styles.card, { borderColor: t.border, backgroundColor: t.panel }]} testID={`account-card-${a.login}`}>
            <Avatar name={a.name} color={a.avatarColor} size={34} />
            <View style={{ marginLeft: 12, flex: 1 }}>
              <Txt weight="600">{a.login}</Txt>
              <Txt size={FONT.sm} muted>
                {a.host} · {a.orgs.length ? `orgs: ${a.orgs.join(', ')}` : 'no organizations'}
              </Txt>
            </View>
            <AccountBadge id={a.id} />
            {status[a.id]?.state === 'expired' && (
              <Button
                small
                primary
                label="Sign in again"
                style={{ marginLeft: 8 }}
                // the device sign-in needs a client id; without one, a token (it used to end in an error)
                onPress={() => (clientId.trim() || !engine.online ? void startDevice() : (setHost(a.host), setMode('pat')))}
                testID={`resign-${a.login}`}
              />
            )}
            <Button small label="Sign out" style={{ marginLeft: 8 }} onPress={() => removeGitHubAccount(a.id)} testID={`signout-${a.login}`} />
          </View>
        ))}
      </View>
      {accounts.some((a) => status[a.id]?.state === 'expired') && (
        <Txt size={FONT.xs} color={t.del} style={{ marginTop: 8 }} testID="accounts-expired-note">
          {accounts.filter((a) => status[a.id]?.state === 'expired').map((a) => a.login).join(', ')}: GitHub no longer accepts the sign-in (it expired or was revoked, and could not be renewed). Sign in
          again as the same user: the account is replaced, and from now on Prong renews the sign-in by itself.
        </Txt>
      )}
      <View style={{ flexDirection: 'row', marginTop: 12, flexWrap: 'wrap' }}>
        <Button label="Sign in with GitHub (device)" icon="github" primary onPress={() => void startDevice()} testID="accounts-device" />
        <Button label="Token…" style={{ marginLeft: 8 }} onPress={() => setMode('pat')} testID="accounts-token" />
      </View>
      <Field label="OAuth app client id (for the device flow)" style={{ marginTop: 14 }}>
        <View style={{ flexDirection: 'row' }}>
          <Input value={clientId} onChange={setClientId} mono placeholder="Iv1.…" style={{ flex: 1 }} testID="client-id" />
          <Button small label="Save" style={{ marginLeft: 6 }} testID="client-id-save" onPress={() => void live.saveSettings({ githubClientId: clientId.trim() }).then(() => toast('Client id saved', 'success'))} />
        </View>
      </Field>
    </View>
  );
}

function SshPrefs() {
  const t = useTheme();
  const keys = useStore((s) => s.sshKeys);
  const accounts = useStore((s) => s.accounts);
  const engine = useStore((s) => s.engine);
  const [gen, setGen] = useState(false);
  const [name, setName] = useState('id_ed25519_prong');
  const [type, setType] = useState<'ed25519' | 'rsa' | 'ecdsa'>('ed25519');
  const [pass, setPass] = useState('');
  const [host, setHost] = useState('github.com');
  useEffect(() => {
    if (engine.online) void live.refreshSshKeys();
  }, [engine.online]);
  // a file in the SSH folder: no folders, nothing ssh-keygen reads as an option, not a key that exists
  const nameProblem = !/^[A-Za-z0-9_@+][A-Za-z0-9._@+-]*$/.test(name) || name.endsWith('.pub') ? 'letters, digits, . _ - @ + (no folders)' : keys.some((k) => k.name === name) ? 'a key of that name exists' : null;
  const generate = async () => {
    if (nameProblem) return;
    if (!engine.online) {
      generateSshKey(name, type, pass);
      setGen(false);
      return;
    }
    if (await live.generateKey(name, type, pass)) setGen(false);
  };
  if (gen)
    return (
      <View>
        <Txt weight="600" size={FONT.lg}>
          Generate SSH key
        </Txt>
        <Field label="File name (~/.ssh/)" style={{ marginTop: 12 }}>
          <Input value={name} onChange={setName} onSubmit={() => void generate()} mono testID="ssh-gen-name" />
        </Field>
        {nameProblem ? (
          <Txt size={FONT.xs} color={t.del} style={{ marginTop: 4 }} testID="ssh-gen-problem">
            {nameProblem}
          </Txt>
        ) : null}
        <Field label="Type" style={{ marginTop: 10 }}>
          <Segmented value={type} onChange={setType} options={[{ value: 'ed25519', label: 'ed25519' }, { value: 'rsa', label: 'RSA 4096' }, { value: 'ecdsa', label: 'ECDSA' }]} />
        </Field>
        <Field label="Passphrase (optional)" style={{ marginTop: 10 }}>
          <Input value={pass} onChange={setPass} secure mono testID="ssh-gen-pass" />
        </Field>
        <View style={{ flexDirection: 'row', marginTop: 16 }}>
          <Button label="Back" onPress={() => setGen(false)} testID="ssh-gen-back" />
          <Button
            testID="ssh-gen-go"
            label="Generate"
            primary
            icon="key"
            style={{ marginLeft: 8 }}
            disabled={!!nameProblem}
            onPress={() => void generate()}
          />
        </View>
      </View>
    );
  return (
    <ScrollView>
      <Txt weight="600" size={FONT.lg}>
        SSH keys
      </Txt>
      <Txt muted size={FONT.sm} style={{ marginTop: 4 }}>
        Keys found in ~/.ssh. Add them to the agent (stored in the macOS keychain) and to your GitHub account.
      </Txt>
      {keys.length === 0 && (
        <Txt size={FONT.sm} faint style={{ marginTop: 10 }}>
          No keys in ~/.ssh yet.
        </Txt>
      )}
      {keys.map((k) => (
        <View key={k.id} style={[styles.card, { borderColor: t.border, backgroundColor: t.panel, alignItems: 'flex-start' }]} testID={`ssh-key-${k.name}`}>
          <Icon name="key" size={18} color={t.accent} />
          <View style={{ marginLeft: 12, flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Txt weight="600" mono>
                {k.name}
              </Txt>
              <Badge style={{ marginLeft: 8 }}>{k.type}</Badge>
              {k.hasPassphrase && (
                <View style={{ marginLeft: 6 }}>
                  <Icon name="lock" size={11} />
                </View>
              )}
            </View>
            <Txt size={FONT.xs} faint mono style={{ marginTop: 3 }}>
              {k.fingerprint}
            </Txt>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <Checkbox checked={k.inAgent} onChange={(v) => (engine.online ? (v ? void live.addKeyToAgent(k.name) : toast('Remove from the agent with ssh-add -d in a terminal', 'info')) : updateSshKey(k.id, { inAgent: v }))} label="In ssh-agent" testID={`ssh-agent-${k.name}`} />
              <View style={{ width: 16 }} />
              {k.addedToGitHub ? (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Icon name="checkCircle" size={13} color={t.add} />
                  <Txt size={FONT.sm} muted style={{ marginLeft: 4 }}>
                    On GitHub
                  </Txt>
                </View>
              ) : (
                <Button small label="Add to GitHub" icon="github" testID={`ssh-github-${k.name}`} disabled={engine.online && accounts.length === 0} onPress={() => (engine.online ? void live.uploadKeyToGitHub(accounts[0].id, k) : (updateSshKey(k.id, { addedToGitHub: true }), toast('Public key uploaded to GitHub (mock)', 'success')))} />
              )}
            </View>
            <View style={{ flexDirection: 'row', marginTop: 8, flexWrap: 'wrap' }}>
              <Button small label="Copy public key" icon="copy" onPress={() => live.copyText(k.publicKey)} testID={`ssh-copy-${k.name}`} />
              <Button small label={`Test ssh to ${host}`} icon="link" style={{ marginLeft: 6 }} testID={`ssh-test-${k.name}`} onPress={() => (engine.online ? live.testSsh(host) : toast("Hi! You've successfully authenticated (mock)", 'success'))} />
              {!engine.online && <Button small label="Delete" danger style={{ marginLeft: 6 }} onPress={() => deleteSshKey(k.id)} />}
            </View>
          </View>
        </View>
      ))}
      <View style={{ flexDirection: 'row', marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button label="Generate new key" icon="plus" primary onPress={() => setGen(true)} testID="ssh-generate" />
        <Button label="Refresh" icon="refresh" style={{ marginLeft: 8 }} onPress={() => void live.refreshSshKeys()} disabled={!engine.online} testID="ssh-refresh" />
        <View style={{ width: 12 }} />
        <Txt size={FONT.xs} muted>
          test host
        </Txt>
        <Input value={host} onChange={setHost} small mono style={{ width: 150, marginLeft: 6 }} testID="ssh-host" />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // grows with the dialog (a resize gives it the height); 170 at least
  list: { flex: 1, minHeight: 170, borderWidth: 1, borderRadius: 0, marginTop: 8 },
  card: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, borderRadius: 0, marginTop: 8 },
  code: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 0, borderWidth: 1, marginTop: 12 },
  scheme: { width: 158, padding: 8, margin: 4 },
});
