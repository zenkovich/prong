import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { remoteOwner } from '../git/remoteUrl';
import type { RepoAuth, RepoAuthInfo } from '../git/types';
import * as live from '../state/live';
import { closeDialog, openDialog, useRepo, useStore } from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/overlays';
import { Badge, Button, PressScale, Txt, useKeyboard } from '../ui/primitives';

/** 'inherit' | 'default' | 'ssh:<key>' | 'account:<id>' */
type Choice = string;
const choiceOf = (a: RepoAuth | null | undefined): Choice | null => (!a ? null : a.kind === 'default' ? 'default' : a.kind === 'ssh' ? `ssh:${a.key}` : `account:${a.account}`);
const authOf = (c: Choice): RepoAuth | null => (c === 'default' ? { kind: 'default' } : c.startsWith('ssh:') ? { kind: 'ssh', key: c.slice(4) } : c.startsWith('account:') ? { kind: 'account', account: c.slice(8) } : null);
const describeAuth = (a: RepoAuth | null) => (!a || a.kind === 'default' ? 'system default' : a.kind === 'ssh' ? `SSH key ${a.key}` : `account ${a.account.replace(/^[^:]+:/, '')}`);

/**
 * Which SSH key or account git uses for this repository's remotes. Submodules and repositories inside its folder
 * follow it unless they have their own; a submodule shows what it inherits and can override it.
 */
export function ConnectionDialog() {
  const t = useTheme();
  const repo = useRepo();
  const keys = useStore((s) => s.sshKeys);
  const accounts = useStore((s) => s.accounts);
  const repoName = useStore((s) => s.repos.find((r) => r.id === s.activeTab)?.name ?? '');
  const [info, setInfo] = useState<RepoAuthInfo | null>(null);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [test, setTest] = useState<{ running: boolean; ok?: boolean; output?: string } | null>(null);
  useEffect(() => {
    void live.connectionInfo().then((i) => i && setInfo(i));
    void live.refreshSshKeys();
  }, [repo.id]);

  const remote = repo.remotes.find((r) => r.name === 'origin') ?? repo.remotes[0];
  const owner = remote ? remoteOwner(remote.url) : null;
  const saved = info ? choiceOf(info.own) ?? (info.inherited ? 'inherit' : 'default') : null;
  const choice = picked ?? saved;
  // what a choice means for git: "inherit" is the parent's setting; "default" with nothing to inherit is no setting
  const effective = (c: Choice): RepoAuth | null => (c === 'inherit' ? info?.inherited?.auth ?? null : c === 'default' ? null : authOf(c));
  const toSave = (c: Choice): RepoAuth | null => (c === 'inherit' ? null : c === 'default' ? (info?.inherited ? { kind: 'default' } : null) : authOf(c));

  const runTest = async () => {
    if (!remote || !choice) return;
    setTest({ running: true });
    const r = await live.testConnection(remote.name, effective(choice));
    setTest({ running: false, ok: !!r?.ok, output: r?.output });
  };
  const save = async () => {
    if (!choice) return;
    if (await live.setConnection(toSave(choice), describeAuth(effective(choice)))) closeDialog();
  };

  const pick = (value: Choice) => {
    setPicked(value);
    setTest(null);
  };
  // Enter saves a changed choice, as the dialog's button does
  useKeyboard((e) => {
    if (e.key === 'Enter' && !e.meta && !e.shift && !e.consumed && choice && choice !== saved) {
      e.preventDefault();
      void save();
    }
  });
  return (
    <Modal
      title={`Connection · ${repoName}`}
      width={620}
      icon={<Icon name="key" size={14} color={t.accent} />}
      footer={
        <>
          <Button small label={test?.running ? 'Testing…' : 'Test connection'} icon="refresh" disabled={!remote || !choice || !!test?.running} onPress={() => void runTest()} testID="conn-test" />
          <View style={{ flex: 1 }} />
          <Button label="Cancel" onPress={closeDialog} testID="conn-cancel" />
          <Button label="Save" primary style={{ marginLeft: 8 }} disabled={!choice || choice === saved} onPress={() => void save()} testID="conn-save" />
        </>
      }
    >
      <View testID="connection-dialog">
        <Txt muted size={FONT.sm}>
          How git signs in to {remote ? <Txt size={FONT.sm} mono>{remote.url}</Txt> : 'the remotes'} for fetch, pull and push. Submodules and repositories inside this folder use the same unless they have their own.
        </Txt>
        {info?.inherited && (
          <Txt size={FONT.sm} style={{ marginTop: 8 }} testID="conn-inherited">
            Inherited from <Txt size={FONT.sm} weight="600">{info.inherited.name}</Txt>: {describeAuth(info.inherited.auth)}
          </Txt>
        )}

        <View style={{ marginTop: 12 }}>
          {info?.inherited && <Option choice={choice} onPick={pick} value="inherit" title={`Same as ${info.inherited.name}`} hint={describeAuth(info.inherited.auth)} />}
          <Option choice={choice} onPick={pick} value="default" title="System default" hint="ssh-agent, ~/.ssh/config and git credential helpers decide" />
        </View>

        <Txt label faint size={10} style={{ marginTop: 12, marginBottom: 2 }}>
          SSH key {info ? `· ${info.sshDir}` : ''}
        </Txt>
        {keys.length === 0 && (
          <Txt faint size={FONT.sm} style={{ paddingLeft: 6 }}>
            No keys. Create or import one under Preferences → SSH.
          </Txt>
        )}
        {keys.map((k) => (
          <Option
            key={k.id}
            choice={choice}
            onPick={pick}
            value={`ssh:${k.name}`}
            title={k.name}
            hint={`${k.type} · ${k.fingerprint}${k.inAgent ? ' · in the agent' : ''}`}
            warn={k.hasPassphrase && !k.inAgent ? 'This key has a passphrase and is not in the agent: add it there under Preferences → SSH, Prong cannot ask for the passphrase.' : undefined}
          />
        ))}

        <Txt label faint size={10} style={{ marginTop: 12, marginBottom: 2 }}>
          Account (HTTPS with its token)
        </Txt>
        {accounts.length === 0 && (
          <Txt faint size={FONT.sm} style={{ paddingLeft: 6 }}>
            No accounts. Sign in under Preferences → Accounts.
          </Txt>
        )}
        {accounts.map((a) => {
          const fits = owner && a.host.toLowerCase() === owner.host && (a.login === owner.owner || a.orgs.includes(owner.owner));
          return <Option key={a.id} choice={choice} onPick={pick} value={`account:${a.id}`} title={`${a.login}`} hint={`${a.host}${a.orgs.length ? ` · ${a.orgs.slice(0, 4).join(', ')}` : ''}`} badge={fits ? (a.login === owner!.owner ? 'owner' : `member of ${owner!.owner}`) : undefined} />;
        })}

        {test && !test.running && (
          <View style={{ marginTop: 12, padding: 10, borderWidth: 1, borderColor: (test.ok ? t.add : t.del) + '66', backgroundColor: (test.ok ? t.add : t.del) + '14' }} testID="conn-test-result">
            <Txt size={FONT.sm} weight="600" color={test.ok ? t.add : t.del}>
              {test.ok ? `Connected to ${remote?.name}` : `Could not connect to ${remote?.name}`}
            </Txt>
            {!test.ok && test.output ? (
              <Txt size={FONT.xs} mono selectable style={{ marginTop: 4 }}>
                {test.output}
              </Txt>
            ) : null}
            {!test.ok && remote && (
              <View style={{ flexDirection: 'row', marginTop: 8 }}>
                <Button
                  small
                  icon="agent"
                  label="Ask AI"
                  onPress={() => {
                    closeDialog();
                    live.askAgentAbout({
                      title: `Could not connect to ${remote.name}`,
                      detail: test.output,
                      context: `Проверка подключения (git ls-remote ${remote.name} HEAD) к ${remote.url} через ${choice ? describeAuth(effective(choice)) : 'system default'}. Ключи SSH — в ~/.ssh; в Prong подключение задаётся на репозиторий (SSH-ключ или аккаунт), сабмодули его наследуют.`,
                    });
                  }}
                  testID="conn-ask-ai"
                />
              </View>
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

function Option({ choice, onPick, value, title, hint, badge, warn }: { choice: Choice | null; onPick: (v: Choice) => void; value: Choice; title: string; hint?: string; badge?: string; warn?: string }) {
  const t = useTheme();
  const on = choice === value;
  return (
    <PressScale onPress={() => onPick(value)} scaleTo={0.99} hoverStyle={{ backgroundColor: t.hover }} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 5, paddingHorizontal: 6 }} label={title} testID={`conn-option-${value}`}>
      <View style={{ width: 13, height: 13, borderWidth: 1, borderColor: on ? t.accent : t.borderStrong, alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>{on && <View style={{ width: 7, height: 7, backgroundColor: t.accent }} />}</View>
      <View style={{ marginLeft: 8, flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
          <Txt weight={on ? '600' : '400'}>{title}</Txt>
          {badge ? (
            <View style={{ marginLeft: 8 }}>
              <Badge bg={t.add + '33'} color={t.add}>
                {badge}
              </Badge>
            </View>
          ) : null}
        </View>
        {hint ? (
          <Txt muted size={FONT.sm} numberOfLines={2}>
            {hint}
          </Txt>
        ) : null}
        {warn && on ? (
          <Txt size={FONT.sm} color={t.warn}>
            {warn}
          </Txt>
        ) : null}
      </View>
    </PressScale>
  );
}

/** from the error dialog or a menu */
export const openConnectionDialog = () => openDialog({ type: 'connection' });
