import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { addGitHubAccount, cloneRepo, closeDialog, deleteSshKey, generateSshKey, openDialog, openLocalRepo, removeGitHubAccount, setFileView, setTheme, setUiScale, toast, updateSshKey, useStore } from '../state/store';
import * as live from '../state/live';
import type { GhRepo } from '../git/GitClient';
import { FONT, SCHEMES, THEMES, UI_SCALES, useTheme } from '../theme';
import { desktop, pickFolder } from '../desktop';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/overlays';
import { Avatar, Badge, Button, Checkbox, Input, PressScale, Radio, Row, Segmented, Spinner, Txt } from '../ui/primitives';

// ---------- clone / open / init ----------

export function CloneDialog({ initialUrl }: { initialUrl?: string }) {
  const t = useTheme();
  const accounts = useStore((s) => s.accounts);
  const [source, setSource] = useState<'url' | 'github'>(initialUrl ? 'url' : 'github');
  const [url, setUrl] = useState(initialUrl ?? '');
  const [dir, setDir] = useState('~/work');
  const [recursive, setRecursive] = useState(true);
  const [filter, setFilter] = useState('');
  const name = url.split('/').pop()?.replace(/\.git$/, '') || '';
  const engine = useStore((s) => s.engine);
  const [ghRepos, setGhRepos] = useState<GhRepo[] | null>(null);
  const accountId = accounts[0]?.id;
  useEffect(() => {
    if (engine.online && accountId) void live.githubRepos(accountId).then(setGhRepos);
  }, [engine.online, accountId]);
  const list = (ghRepos ?? []).map((r) => r.fullName).filter((r) => r.toLowerCase().includes(filter.toLowerCase()));
  const urlFor = (full: string) => (engine.online ? ghRepos?.find((r) => r.fullName === full)?.sshUrl ?? `git@github.com:${full}.git` : `git@github.com:${full}.git`);
  return (
    <Modal
      title="Clone repository"
      width={600}
      icon={<Icon name="clone" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Clone" primary icon="fetch" style={{ marginLeft: 8 }} disabled={!url.trim()} onPress={() => cloneRepo(url.trim(), dir, recursive)} />
        </>
      }
    >
      <Segmented value={source} onChange={setSource} options={[{ value: 'github', label: 'GitHub', icon: 'github' }, { value: 'url', label: 'URL', icon: 'link' }]} />
      {source === 'github' && (
        <View style={{ marginTop: 12 }}>
          {accounts.length === 0 ? (
            <View style={{ alignItems: 'center', padding: 16 }}>
              <Txt muted>No GitHub account connected.</Txt>
              <Button label="Connect GitHub" icon="github" primary style={{ marginTop: 10 }} onPress={() => openDialog({ type: 'accounts', tab: 'github' })} />
            </View>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Avatar name={accounts[0].name} color={accounts[0].avatarColor} size={18} />
                <Txt size={FONT.sm} style={{ marginLeft: 6, flex: 1 }}>
                  {accounts[0].login} · {accounts[0].orgs.join(', ') || 'no orgs'}
                </Txt>
                <Input value={filter} onChange={setFilter} placeholder="Filter repositories" icon="search" small style={{ width: 220 }} />
              </View>
              <ScrollView style={[styles.list, { borderColor: t.border, backgroundColor: t.bg }]}>
                {engine.online && accounts[0] && ghRepos === null && (
                  <Txt size={FONT.sm} faint style={{ padding: 8 }}>
                    loading repositories…
                  </Txt>
                )}
                {list.map((r) => {
                  const u = urlFor(r);
                  return (
                    <Row key={r} height={26} selected={url === u} onPress={() => setUrl(u)} onDoublePress={() => cloneRepo(u, dir, recursive)}>
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
              </ScrollView>
            </>
          )}
        </View>
      )}
      <Field label="Repository URL" style={{ marginTop: 12 }}>
        <Input value={url} onChange={setUrl} placeholder="git@github.com:user/repo.git or https://…" mono autoFocus={source === 'url'} />
      </Field>
      <View style={{ flexDirection: 'row', marginTop: 10 }}>
        <Field label="Parent folder" style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row' }}>
            <Input value={dir} onChange={setDir} mono style={{ flex: 1 }} />
            <Button label="Choose…" icon="folder" style={{ marginLeft: 6 }} onPress={async () => (desktop() ? setDir((await pickFolder('Choose the parent folder for the clone')) ?? dir) : toast('Folder picker is available in the macOS app', 'info'))} />
          </View>
        </Field>
        <Field label="Name" style={{ width: 180, marginLeft: 10 }}>
          <Input value={name} onChange={() => {}} mono placeholder="repo" />
        </Field>
      </View>
      <View style={{ marginTop: 10 }}>
        <Checkbox checked={recursive} onChange={setRecursive} label="Clone submodules recursively" />
      </View>
    </Modal>
  );
}

export function OpenDialog() {
  const t = useTheme();
  const [path, setPath] = useState('~/work/zenkovich.space/myhouse');
  return (
    <Modal
      title="Open repository"
      width={520}
      icon={<Icon name="folder" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Open" primary style={{ marginLeft: 8 }} disabled={!path.trim()} onPress={() => openLocalRepo(path.trim())} />
        </>
      }
    >
      <Field label="Path to a local git repository">
        <View style={{ flexDirection: 'row' }}>
          <Input value={path} onChange={setPath} mono autoFocus style={{ flex: 1 }} onSubmit={() => openLocalRepo(path.trim())} />
          <Button label="Browse…" icon="folder" style={{ marginLeft: 6 }} onPress={async () => (desktop() ? setPath((await pickFolder('Choose a git repository', 'Open')) ?? path) : toast('Folder picker is available in the macOS app', 'info'))} />
        </View>
      </Field>
      <Txt size={FONT.sm} faint style={{ marginTop: 10 }}>
        Tip: drag a folder onto the window to open it.
      </Txt>
    </Modal>
  );
}

export function InitDialog() {
  const t = useTheme();
  const [path, setPath] = useState('~/work/new-project');
  return (
    <Modal
      title="Initialize repository"
      width={480}
      icon={<Icon name="plus" size={18} color={t.accent} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label="Initialize" primary style={{ marginLeft: 8 }} onPress={() => (openLocalRepo(path), toast('git init done', 'success'))} />
        </>
      }
    >
      <Field label="Folder">
        <Input value={path} onChange={setPath} mono autoFocus />
      </Field>
      <View style={{ marginTop: 10 }}>
        <Checkbox checked={true} onChange={() => {}} label="Create initial commit with .gitignore" />
      </View>
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

export function AccountsDialog({ tab: initial = 'github' }: { tab?: 'github' | 'ssh' | 'general' }) {
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
            <Row key={k} height={30} selected={tab === k} onPress={() => setTab(k)} style={{ borderRadius: 0 }}>
              <Icon name={icon} size={14} color={tab === k ? t.accent : t.textMuted} />
              <Txt style={{ marginLeft: 8 }} weight={tab === k ? '600' : '400'}>
                {label}
              </Txt>
            </Row>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          {tab === 'general' && <GeneralPrefs />}
          {tab === 'github' && <GitHubPrefs />}
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
              <PressScale key={s.id} onPress={() => setTheme(s.id)} scaleTo={0.97} style={[styles.scheme, { backgroundColor: th.bg, borderColor: active ? t.accent : t.borderStrong, borderWidth: active ? 2 : 1 }]} hoverStyle={{ borderColor: t.accent }}>
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
          <Button small label="Reset" style={{ marginLeft: 8 }} onPress={() => setUiScale(1)} disabled={uiScale === 1} />
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
        <Checkbox checked={settings?.avatars ?? true} onChange={(v) => void live.saveSettings({ avatars: v })} label="Author avatars from GitHub / Gravatar (cached by the engine)" />
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
          <Input value={name} onChange={setName} placeholder={identityLoaded ? 'not set' : ''} />
        </Field>
        <Field label="user.email" style={{ flex: 1, marginLeft: 10 }}>
          <Input value={email} onChange={setEmail} placeholder={identityLoaded ? 'not set' : ''} />
        </Field>
        <Button small label="Save" primary style={{ marginLeft: 10, marginBottom: 1 }} disabled={!engine.online} onPress={() => void live.writeGlobalIdentity(name, email)} />
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
          <Input value={editor} onChange={setEditor} placeholder="Visual Studio Code" />
        </Field>
        <Field label="Terminal" style={{ flex: 1, marginLeft: 10 }}>
          <Input value={terminal} onChange={setTerminal} placeholder="Terminal / iTerm" />
        </Field>
        <Field label="Diff / merge tool" style={{ flex: 1, marginLeft: 10 }}>
          <Input value={diffTool} onChange={setDiffTool} placeholder="Kaleidoscope" />
        </Field>
        <Button small label="Save" primary style={{ marginLeft: 10, marginBottom: 1 }} onPress={saveTools} />
      </View>
    </ScrollView>
  );
}

function GitHubPrefs() {
  const t = useTheme();
  const accounts = useStore((s) => s.accounts);
  const engine = useStore((s) => s.engine);
  const settings = useStore((s) => s.serverSettings);
  const [mode, setMode] = useState<'list' | 'device' | 'pat'>('list');
  const [host, setHost] = useState('github.com');
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState(settings?.githubClientId ?? '');
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<{ code: string; url: string } | null>(null);
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
    setMode('device');
    setBusy(true);
    const ok = await live.deviceFlow(clientId.trim(), host, (code, url) => setDevice({ code, url }));
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
        <PressScale onPress={() => device && live.copyText(device.code)} style={[styles.code, { backgroundColor: t.bg, borderColor: t.borderStrong }]}>
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
        <Button label="Cancel" style={{ marginTop: 20 }} onPress={() => setMode('list')} />
      </View>
    );
  if (mode === 'pat')
    return (
      <View>
        <Txt weight="600" size={FONT.lg}>
          Sign in with a token
        </Txt>
        <Field label="Host" style={{ marginTop: 12 }}>
          <Input value={host} onChange={setHost} mono placeholder="github.com or ghe.company.com" />
        </Field>
        <Field label="Personal access token (scopes: repo, read:org, admin:public_key)" style={{ marginTop: 10 }}>
          <Input value={token} onChange={setToken} mono secure placeholder="ghp_… / github_pat_…" autoFocus />
        </Field>
        <Txt size={FONT.xs} faint style={{ marginTop: 8 }}>
          The token is validated against the API and stored in the macOS Keychain (service space.zenkovich.prong). Nothing is written to disk in plain text.
        </Txt>
        <View style={{ flexDirection: 'row', marginTop: 16 }}>
          <Button label="Back" onPress={() => setMode('list')} />
          <Button
            label={busy ? 'Checking…' : 'Sign in'}
            primary
            style={{ marginLeft: 8 }}
            disabled={!token || busy}
            onPress={async () => {
              setBusy(true);
              const ok = engine.online ? await live.addAccount(host.trim(), token.trim()) : (addGitHubAccount(host, token), true);
              setBusy(false);
              if (ok) {
                setToken('');
                setMode('list');
              }
            }}
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
          <View key={a.id} style={[styles.card, { borderColor: t.border, backgroundColor: t.panel }]}>
            <Avatar name={a.name} color={a.avatarColor} size={34} />
            <View style={{ marginLeft: 12, flex: 1 }}>
              <Txt weight="600">{a.login}</Txt>
              <Txt size={FONT.sm} muted>
                {a.host} · {a.orgs.length ? `orgs: ${a.orgs.join(', ')}` : 'no organizations'}
              </Txt>
            </View>
            <Badge bg={t.addBg} color={t.add}>
              connected
            </Badge>
            <Button small label="Sign out" style={{ marginLeft: 8 }} onPress={() => removeGitHubAccount(a.id)} />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', marginTop: 12, flexWrap: 'wrap' }}>
        <Button label="Sign in with GitHub (device)" icon="github" primary onPress={() => void startDevice()} />
        <Button label="Token…" style={{ marginLeft: 8 }} onPress={() => setMode('pat')} />
      </View>
      <Field label="OAuth app client id (for the device flow)" style={{ marginTop: 14 }}>
        <View style={{ flexDirection: 'row' }}>
          <Input value={clientId} onChange={setClientId} mono placeholder="Iv1.…" style={{ flex: 1 }} />
          <Button small label="Save" style={{ marginLeft: 6 }} onPress={() => void live.saveSettings({ githubClientId: clientId.trim() }).then(() => toast('Client id saved', 'success'))} />
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
  if (gen)
    return (
      <View>
        <Txt weight="600" size={FONT.lg}>
          Generate SSH key
        </Txt>
        <Field label="File name (~/.ssh/)" style={{ marginTop: 12 }}>
          <Input value={name} onChange={setName} mono />
        </Field>
        <Field label="Type" style={{ marginTop: 10 }}>
          <Segmented value={type} onChange={setType} options={[{ value: 'ed25519', label: 'ed25519' }, { value: 'rsa', label: 'RSA 4096' }, { value: 'ecdsa', label: 'ECDSA' }]} />
        </Field>
        <Field label="Passphrase (optional)" style={{ marginTop: 10 }}>
          <Input value={pass} onChange={setPass} secure mono />
        </Field>
        <View style={{ flexDirection: 'row', marginTop: 16 }}>
          <Button label="Back" onPress={() => setGen(false)} />
          <Button
            label="Generate"
            primary
            icon="key"
            style={{ marginLeft: 8 }}
            onPress={() => {
              generateSshKey(name, type, pass);
              setGen(false);
            }}
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
        <View key={k.id} style={[styles.card, { borderColor: t.border, backgroundColor: t.panel, alignItems: 'flex-start' }]}>
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
              <Checkbox checked={k.inAgent} onChange={(v) => (engine.online ? (v ? void live.addKeyToAgent(k.name) : toast('Remove from the agent with ssh-add -d in a terminal', 'info')) : updateSshKey(k.id, { inAgent: v }))} label="In ssh-agent" />
              <View style={{ width: 16 }} />
              {k.addedToGitHub ? (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Icon name="checkCircle" size={13} color={t.add} />
                  <Txt size={FONT.sm} muted style={{ marginLeft: 4 }}>
                    On GitHub
                  </Txt>
                </View>
              ) : (
                <Button small label="Add to GitHub" icon="github" disabled={engine.online && accounts.length === 0} onPress={() => (engine.online ? void live.uploadKeyToGitHub(accounts[0].id, k) : (updateSshKey(k.id, { addedToGitHub: true }), toast('Public key uploaded to GitHub (mock)', 'success')))} />
              )}
            </View>
            <View style={{ flexDirection: 'row', marginTop: 8, flexWrap: 'wrap' }}>
              <Button small label="Copy public key" icon="copy" onPress={() => live.copyText(k.publicKey)} />
              <Button small label={`Test ssh to ${host}`} icon="link" style={{ marginLeft: 6 }} onPress={() => (engine.online ? live.testSsh(host) : toast("Hi! You've successfully authenticated (mock)", 'success'))} />
              {!engine.online && <Button small label="Delete" danger style={{ marginLeft: 6 }} onPress={() => deleteSshKey(k.id)} />}
            </View>
          </View>
        </View>
      ))}
      <View style={{ flexDirection: 'row', marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button label="Generate new key" icon="plus" primary onPress={() => setGen(true)} />
        <Button label="Refresh" icon="refresh" style={{ marginLeft: 8 }} onPress={() => void live.refreshSshKeys()} disabled={!engine.online} />
        <View style={{ width: 12 }} />
        <Txt size={FONT.xs} muted>
          test host
        </Txt>
        <Input value={host} onChange={setHost} small mono style={{ width: 150, marginLeft: 6 }} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { height: 170, borderWidth: 1, borderRadius: 0, marginTop: 8 },
  card: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, borderRadius: 0, marginTop: 8 },
  code: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 0, borderWidth: 1, marginTop: 12 },
  scheme: { width: 158, padding: 8, margin: 4 },
});
