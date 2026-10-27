import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SUGGESTIONS } from '../agent/mockAgent';
import { AgentMessage, AgentTarget, AppVersion } from '../agent/types';
import { Markdown } from './Markdown';
import {
  agentSend,
  clearAgentChat,
  fullDate,
  relTime,
  resetFactory,
  rollbackTo,
  setAgentTab,
  setAgentTarget,
  setAgentWidth,
  setState,
  setVersionStatus,
  toast,
  toggleAgent,
  toggleAgentBar,
  updateAgentSettings,
  useStore,
} from '../state/store';
import { FONT, useTheme } from '../theme';
import * as live from '../state/live';
import { Icon } from '../ui/Icon';
import { Badge, Button, Checkbox, Cursor, HoverReveal, Input, PressScale, Radio, Row, Segmented, Spinner, Splitter, Txt } from '../ui/primitives';

export function AgentPanel() {
  const t = useTheme();
  const agent = useStore((s) => s.agent);
  const applied = agent.versions.filter((v) => v.status === 'applied').length;
  return (
    <View style={{ flexDirection: 'row', alignSelf: 'stretch' }}>
      <Splitter orientation="vertical" onDelta={(d) => setAgentWidth(agent.width - d)} />
      <View style={[styles.panel, { width: agent.width, backgroundColor: t.panel, borderColor: t.border }]} testID="agent-panel">
        <View style={[styles.head, { borderColor: t.border, backgroundColor: t.panelAlt }]}>
          <Icon name="agent" size={14} color={t.accent} />
          <Txt label style={{ marginLeft: 6 }}>
            agent
          </Txt>
          <View style={{ width: 6, height: 6, backgroundColor: agent.settings.connected ? t.add : t.del, marginLeft: 8 }} />
          <Txt size={FONT.xs} faint style={{ marginLeft: 4, flex: 1 }} numberOfLines={1} testID="agent-connection">
            {agent.settings.connected ? `claude code ${agent.settings.cliVersion} · local` : 'not connected'}
          </Txt>
          <PressScale onPress={() => toggleAgentBar(true)} scaleTo={0.9} style={{ padding: 4 }} hoverStyle={{ backgroundColor: t.hover }} label="Fold into the command line (⌘J)" testID="agent-fold">
            <Icon name="collapse" size={13} />
          </PressScale>
          <PressScale onPress={() => toggleAgent(false)} scaleTo={0.9} style={{ padding: 4 }} hoverStyle={{ backgroundColor: t.hover }} label="Close agent" testID="agent-close">
            <Icon name="x" size={13} />
          </PressScale>
        </View>
        <View style={[styles.tabs, { borderColor: t.border }]}>
          {(
            [
              ['chat', 'Chat'],
              ['changes', `Changes${applied ? ` ${applied}` : ''}`],
              ['settings', 'Settings'],
            ] as const
          ).map(([k, label]) => {
            const active = agent.tab === k;
            return (
              <PressScale key={k} onPress={() => setAgentTab(k)} scaleTo={1} style={[styles.tab, active && { borderBottomColor: t.accent }]} hoverStyle={{ backgroundColor: t.hover }} testID={`agent-tab-${k}`}>
                <Txt label size={10} color={active ? t.accent : t.textMuted}>
                  {label}
                </Txt>
              </PressScale>
            );
          })}
        </View>
        {agent.tab === 'chat' && <Chat />}
        {agent.tab === 'changes' && <Changes />}
        {agent.tab === 'settings' && <Settings />}
      </View>
    </View>
  );
}

// ---------- chat ----------

function Chat() {
  const t = useTheme();
  const agent = useStore((s) => s.agent);
  const [text, setText] = useState('');
  const scroll = useRef<any>(null);
  useEffect(() => {
    setTimeout(() => scroll.current?.scrollToEnd({ animated: false }), 30);
  }, [agent.messages.length, agent.busy]);
  // the agent message of the run in progress (its steps stay unfolded)
  const runningId = agent.busy ? [...agent.messages].reverse().find((m) => m.role === 'agent')?.id : undefined;
  const send = () => {
    if (!text.trim() || agent.busy) return;
    agentSend(text);
    setText('');
  };
  return (
    <View style={{ flex: 1 }}>
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ padding: 10 }}>
        {agent.messages.map((m) => (
          <Message key={m.id} m={m} running={m.id === runningId} />
        ))}
        {agent.busy && (
          <View style={[styles.msg, { borderLeftColor: t.info, flexDirection: 'row', alignItems: 'center' }]} testID="agent-working">
            <Spinner size={12} />
            <Txt size={FONT.sm} muted style={{ marginLeft: 8, flexShrink: 1 }} numberOfLines={1}>
              {agent.status ?? (agent.target === 'app' ? 'Editing the sources…' : 'Working…')}
              {live.agentReady() ? '' : ' (mock)'}
            </Txt>
            <Cursor />
          </View>
        )}
      </ScrollView>
      <View style={[styles.composer, { borderColor: t.border, backgroundColor: t.panelAlt }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 6 }}>
          {SUGGESTIONS.filter((s) => agent.target === 'auto' || s.target === agent.target).map((s) => (
            <PressScale key={s.text} onPress={() => setText(s.text)} scaleTo={0.97} style={[styles.chip, { borderColor: t.borderStrong }]} hoverStyle={{ borderColor: t.accent }} testID="agent-suggestion">
              <Txt size={FONT.xs} muted>
                {s.text}
              </Txt>
            </PressScale>
          ))}
        </ScrollView>
        <Input value={text} onChange={setText} placeholder={agent.target === 'app' ? 'что изменить в интерфейсе' : agent.target === 'repo' ? 'что сделать в репозитории' : 'команда для репозитория или интерфейса'} slash onSubmit={send} autoFocus enterSends testID="agent-chat-input" />
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
          <Segmented<AgentTarget> value={agent.target} onChange={setAgentTarget} options={[{ value: 'auto', label: 'auto' }, { value: 'repo', label: 'repo' }, { value: 'app', label: 'app' }]} />
          <View style={{ flex: 1 }} />
          {/* not while a run is going: its answer had nowhere to go and was lost */}
          <PressScale onPress={clearAgentChat} disabled={agent.busy} scaleTo={0.9} style={{ padding: 4, marginRight: 4, opacity: agent.busy ? 0.4 : 1 }} hoverStyle={{ backgroundColor: t.hover }} label="Clear chat" testID="agent-clear">
            <Icon name="trash" size={12} />
          </PressScale>
          <Button small primary label="Send" icon="send" onPress={send} disabled={!text.trim() || agent.busy} testID="agent-chat-send" />
        </View>
      </View>
    </View>
  );
}

/** a step of the run (a tool it used), as opposed to its outcome lines (cost, version, warnings) */
const isStep = (a: string) => !/^(cost \$|done$|version v|no source changes|⚠|· )/.test(a);

/**
 * One chat message: who and where, the text as Markdown, then what the agent did — the last steps live while it
 * works, afterwards folded into one "N steps" row — and the outcome (cost, version).
 */
function Message({ m, running }: { m: AgentMessage; running: boolean }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const actions = m.actions ?? [];
  const steps = actions.filter(isStep);
  const outcome = actions.filter((a) => !isStep(a) && !a.startsWith('· '));
  const color = m.role === 'user' ? t.accent : m.role === 'agent' ? t.info : t.textFaint;
  return (
    <View style={[styles.msg, { borderLeftColor: color }]} testID={`agent-msg-${m.role}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
        <Txt label size={9.5} color={color}>
          {m.role === 'user' ? 'you' : m.role === 'agent' ? 'agent' : 'system'}
        </Txt>
        {m.target && (
          <Txt label size={9.5} faint style={{ marginLeft: 6 }}>
            · {m.target}
          </Txt>
        )}
        <Txt size={FONT.xs} faint style={{ marginLeft: 'auto' }}>
          {relTime(m.time)}
        </Txt>
      </View>
      {m.text ? <Markdown text={m.text} testID="agent-msg-text" /> : null}
      {running
        ? steps.slice(-4).map((a, i) => <Step key={i} text={a} />)
        : steps.length > 0 && (
            <View style={{ marginTop: 6 }}>
              <PressScale onPress={() => setOpen((v) => !v)} scaleTo={1} style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingVertical: 1, paddingRight: 4 }} hoverStyle={{ backgroundColor: t.hover }} label={open ? 'Hide the steps' : 'Show the steps'} testID="agent-steps">
                <Txt size={FONT.xs} faint style={{ width: 10 }}>
                  {open ? '▾' : '▸'}
                </Txt>
                <Txt size={FONT.xs} faint style={{ marginLeft: 2 }}>
                  {steps.length} step{steps.length === 1 ? '' : 's'}
                </Txt>
              </PressScale>
              {open && actions.filter((a) => isStep(a) || a.startsWith('· ')).map((a, i) => <Step key={i} text={a} />)}
            </View>
          )}
      {outcome.length > 0 && (
        <Txt size={FONT.xs} faint selectable style={{ marginTop: 4 }}>
          {outcome.join(' · ')}
        </Txt>
      )}
      {m.versionId && <VersionChip id={m.versionId} />}
    </View>
  );
}

function Step({ text }: { text: string }) {
  const t = useTheme();
  const sp = text.indexOf(' ');
  const tool = text.startsWith('· ') ? '' : sp < 0 ? text : text.slice(0, sp);
  const arg = text.startsWith('· ') ? text.slice(2) : sp < 0 ? '' : text.slice(sp + 1);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 2 }}>
      <Txt size={FONT.xs} color={t.add} style={{ width: 12 }}>
        {tool ? '✓' : '·'}
      </Txt>
      <Txt size={FONT.xs} muted selectable style={{ flex: 1 }} numberOfLines={2}>
        {tool ? <Txt size={FONT.xs} weight="600" muted>{tool} </Txt> : null}
        {arg}
      </Txt>
    </View>
  );
}

function VersionChip({ id }: { id: number }) {
  const t = useTheme();
  const v = useStore((s) => s.agent.versions.find((x) => x.id === id));
  if (!v) return null;
  const on = v.status === 'applied';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }} testID="agent-version-chip">
      <Badge bg={on ? t.accentSoft : t.raised} color={on ? t.accent : t.textFaint}>
        v{v.n} · {on ? 'applied' : 'reverted'}
      </Badge>
      <Button small label={on ? 'Revert' : 'Re-apply'} style={{ marginLeft: 6 }} onPress={() => setVersionStatus(v.id, on ? 'reverted' : 'applied')} testID="agent-chip-toggle" />
      <Button small label="Log" style={{ marginLeft: 4 }} onPress={() => setAgentTab('changes')} testID="agent-chip-log" />
    </View>
  );
}

// ---------- change log ----------

function Changes() {
  const t = useTheme();
  const versions = useStore((s) => s.agent.versions);
  const [openId, setOpenId] = useState<number | null>(null);
  const applied = versions.filter((v) => v.status === 'applied');
  const current = applied.length ? applied[applied.length - 1].n : 0;
  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.logHead, { borderColor: t.border }]}>
        <Txt size={FONT.sm} muted style={{ flex: 1 }} testID="agent-versions-head">
          current: <Txt size={FONT.sm} color={t.accent} weight="700">{current === 0 ? 'factory' : `v${current}`}</Txt> · {applied.length} of {versions.length} applied
        </Txt>
        <Button small label="Reset to factory" icon="rotate" danger={applied.length > 0} disabled={applied.length === 0} onPress={resetFactory} testID="agent-reset-factory" />
      </View>
      <ScrollView style={{ flex: 1 }}>
        <VersionRow n={0} title="Factory build" subtitle="the sources before the agent's first change" status={applied.length === 0 ? 'current' : 'base'} onRollback={() => rollbackTo(0)} />
        {versions.map((v) => (
          <View key={v.id}>
            <VersionRow
              n={v.n}
              title={v.title}
              subtitle={`${fullDate(v.time)} · ${v.files.length} file${v.files.length === 1 ? '' : 's'} · build ${v.build}`}
              status={v.status === 'reverted' ? 'reverted' : v.n === current ? 'current' : 'applied'}
              onPress={() => setOpenId(openId === v.id ? null : v.id)}
              onRollback={() => rollbackTo(v.n)}
              onToggle={() => setVersionStatus(v.id, v.status === 'applied' ? 'reverted' : 'applied')}
            />
            {openId === v.id && <VersionDetails v={v} />}
          </View>
        ))}
        {versions.length === 0 && (
          <Txt size={FONT.sm} faint style={{ padding: 12 }}>
            No interface changes yet. Ask the agent in the Chat tab, for example «скрой колонку автора».
          </Txt>
        )}
      </ScrollView>
    </View>
  );
}

function VersionRow({ n, title, subtitle, status, onPress, onRollback, onToggle }: { n: number; title: string; subtitle: string; status: 'current' | 'applied' | 'reverted' | 'base'; onPress?: () => void; onRollback: () => void; onToggle?: () => void }) {
  const t = useTheme();
  const color = status === 'current' ? t.accent : status === 'reverted' ? t.textFaint : t.text;
  return (
    <Row height={44} onPress={onPress} style={{ paddingLeft: 10, borderBottomWidth: 1, borderBottomColor: t.border, opacity: status === 'reverted' ? 0.6 : 1 }} testID={`agent-version-${n}`}>
      {({ hovered }) => (
        <>
          <Txt size={FONT.sm} mono color={color} weight="700" style={{ width: 34 }}>
            {n === 0 ? 'v0' : `v${n}`}
          </Txt>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt size={FONT.md} color={color} numberOfLines={1} style={status === 'reverted' ? { textDecorationLine: 'line-through' } : undefined}>
              {title}
            </Txt>
            <Txt size={FONT.xs} faint numberOfLines={1}>
              {subtitle}
            </Txt>
          </View>
          {status === 'current' && !onToggle ? (
            <Txt label size={9} color={t.accent}>
              current
            </Txt>
          ) : status === 'current' ? (
            // the latest change is the one most often taken back: its row can revert it too (there is nothing to
            // roll back to on it)
            <HoverReveal
              rowHovered={hovered}
              rest={
                <Txt label size={9} color={t.accent}>
                  current
                </Txt>
              }
            >
              <Button small label="Revert" onPress={onToggle} testID={`agent-version-toggle-${n}`} />
            </HoverReveal>
          ) : (
            // the buttons stay while the pointer is on them (a button shown only while its row is hovered vanished
            // the moment the pointer reached it)
            <HoverReveal
              rowHovered={hovered}
              rest={
                <Txt label size={9} faint>
                  {status}
                </Txt>
              }
            >
              {onToggle && <Button small label={status === 'reverted' ? 'Re-apply' : 'Revert'} onPress={onToggle} testID={`agent-version-toggle-${n}`} />}
              <Button small label="Roll back here" style={{ marginLeft: 4 }} onPress={onRollback} testID={`agent-version-rollback-${n}`} />
            </HoverReveal>
          )}
        </>
      )}
    </Row>
  );
}

/** the patch of a version, read from the sources' log when its details open (the list carries only its files) */
function useVersionDiff(v: AppVersion) {
  const [diff, setDiff] = useState<string | null>(v.sha ? null : v.diff);
  useEffect(() => {
    if (!v.sha || !v.sourcesPath) return;
    let alive = true;
    live.client.appDiff(v.sourcesPath, v.sha).then(
      (r) => alive && setDiff(r.diff),
      (e) => alive && setDiff(`could not read the diff: ${String(e?.message ?? e)}`),
    );
    return () => {
      alive = false;
    };
  }, [v.sha, v.sourcesPath]);
  return diff;
}

/** lines of a patch drawn in the panel; Copy diff gives all of it */
const DIFF_LINES = 300;

function VersionDetails({ v }: { v: AppVersion }) {
  const t = useTheme();
  const diff = useVersionDiff(v);
  const lines = diff === null ? [] : diff.replace(/\n$/, '').split('\n');
  // a file of the version in the editor: the sources folder it was recorded in (offline demo versions have none)
  const open = (f: string) => v.sourcesPath && live.openInEditor(`${v.sourcesPath.replace(/\/+$/, '')}/${f}`);
  return (
    <View style={{ padding: 10, backgroundColor: t.bg, borderBottomWidth: 1, borderBottomColor: t.border }} testID="agent-version-details">
      <Txt size={FONT.xs} faint>
        prompt
      </Txt>
      <Txt size={FONT.sm} selectable style={{ marginBottom: 6 }}>
        «{v.prompt}»
      </Txt>
      <Txt size={FONT.xs} faint>
        files
      </Txt>
      {v.files.map((f) => (
        <PressScale key={f} onPress={() => open(f)} disabled={!v.sourcesPath} scaleTo={1} style={{ alignSelf: 'flex-start' }} hoverStyle={{ backgroundColor: t.hover }} label={`Open ${f} in the editor`} testID="agent-version-file">
          <Txt size={FONT.sm} mono color={t.info}>
            {f}
          </Txt>
        </PressScale>
      ))}
      <Txt size={FONT.xs} faint style={{ marginTop: 6 }}>
        diff
      </Txt>
      <View testID="agent-version-diff">
        {diff === null ? (
          <Spinner size={12} />
        ) : (
          lines.slice(0, DIFF_LINES).map((l, i) => {
            const add = l.startsWith('+') && !l.startsWith('+++');
            const del = l.startsWith('-') && !l.startsWith('---');
            return (
              <Txt key={i} size={FONT.xs} mono selectable color={add ? t.add : del ? t.del : t.textMuted} style={{ backgroundColor: add ? t.addBg : del ? t.delBg : 'transparent' }}>
                {l || ' '}
              </Txt>
            );
          })
        )}
        {lines.length > DIFF_LINES && (
          <Txt size={FONT.xs} faint style={{ marginTop: 2 }}>
            … {lines.length - DIFF_LINES} more lines (Copy diff has them all)
          </Txt>
        )}
      </View>
      <View style={{ flexDirection: 'row', marginTop: 8 }}>
        <Button small label="Open in editor" icon="edit" disabled={!v.sourcesPath || !v.files.length} onPress={() => open(v.files[0])} testID="agent-version-editor" />
        <Button small label="Copy diff" icon="copy" style={{ marginLeft: 6 }} disabled={!diff} onPress={() => diff && live.copyText(diff)} testID="agent-version-copy" />
      </View>
    </View>
  );
}

// ---------- settings ----------

function Settings() {
  const t = useTheme();
  const s = useStore((st) => st.agent.settings);
  const engine = useStore((st) => st.engine);
  // the binary the engine found on PATH (an empty field means that one, not a path of its own)
  const detected = useStore((st) => st.agentAvailable?.path ?? null);
  const [checking, setChecking] = useState(false);
  const persist = (patch: Partial<typeof s>) => {
    updateAgentSettings(patch);
    if (engine.online) void live.saveSettings({ agent: { provider: patch.provider ?? s.provider, model: patch.model ?? s.model, cliPath: patch.cliPath ?? s.cliPath, sourcesPath: patch.sourcesPath ?? s.sourcesPath, askBeforeApply: patch.askBeforeApply ?? s.askBeforeApply, autoRollbackOnBuildError: patch.autoRollbackOnBuildError ?? s.autoRollbackOnBuildError } });
  };
  const check = async () => {
    setChecking(true);
    if (!engine.online) {
      setTimeout(() => {
        setChecking(false);
        updateAgentSettings({ connected: true, cliVersion: '2.1.4' });
        toast('claude --version → 2.1.4 (mock, engine offline)', 'info');
      }, 700);
      return;
    }
    await live.saveSettings({ agent: { ...toServerAgent(s) } });
    const r = await live.client.agentCheck().catch(() => null);
    setChecking(false);
    // what decides whether a request goes to Claude Code (it was read once at start: a path fixed here did not count)
    setState({ agentAvailable: r });
    if (r?.ok) {
      updateAgentSettings({ connected: true, cliVersion: r.version.replace(/\s*\(Claude Code\)/, '') });
      toast(`${r.version}`, 'success', r.path ?? '');
    } else {
      updateAgentSettings({ connected: false });
      toast('Claude Code not found', 'error', 'install it (npm i -g @anthropic-ai/claude-code) or set the binary path');
    }
  };
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
      <Txt label faint>
        ── provider
      </Txt>
      <View style={{ marginTop: 4 }}>
        <Radio checked={s.provider === 'anthropic-claude-code'} onPress={() => persist({ provider: 'anthropic-claude-code' })} label="Anthropic · local Claude Code" hint="Runs claude -p on this machine with the repository and the app sources as its working directory. Uses your Claude subscription, nothing leaves the machine except model calls." />
        <Radio checked={s.provider === 'anthropic-api'} onPress={() => persist({ provider: 'anthropic-api' })} label="Anthropic API key" hint="Direct Messages API with the built-in tool set. Not implemented yet: the local Claude Code provider is the one that runs." />
        <Radio checked={s.provider === 'openai-compatible'} onPress={() => persist({ provider: 'openai-compatible' })} label="OpenAI-compatible endpoint" hint="Any local or remote server with the chat completions API. Not implemented yet." />
      </View>
      <Field label="Model (empty = Claude Code default)">
        <Input value={s.model} onChange={(v) => persist({ model: v })} mono placeholder="claude-fable-5-1 / sonnet / opus" testID="agent-set-model" />
      </Field>
      {s.provider === 'anthropic-claude-code' && (
        <Field label="Claude Code binary">
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Input value={s.cliPath} onChange={(v) => persist({ cliPath: v })} mono style={{ flex: 1 }} placeholder={!s.cliPath && detected ? `auto-detect: ${detected}` : 'auto-detect (claude on PATH)'} testID="agent-set-cli" />
            <PressScale onPress={() => void check()} style={{ marginLeft: 6 }} testID="agent-check">
              <View style={{ flexDirection: 'row', alignItems: 'center', height: 26, paddingHorizontal: 8, borderWidth: 1, borderColor: t.borderStrong, backgroundColor: t.raised }}>
                {checking ? <Spinner size={12} /> : <Icon name="link" size={12} />}
                <Txt label size={10} style={{ marginLeft: 6 }}>
                  check
                </Txt>
              </View>
            </PressScale>
          </View>
        </Field>
      )}
      <Txt label faint style={{ marginTop: 14 }}>
        ── app sources
      </Txt>
      <Field label="Sources folder (git repository the agent edits for app changes)">
        <Input value={s.sourcesPath} onChange={(v) => persist({ sourcesPath: v })} mono placeholder="path to the Prong sources" testID="agent-set-sources" />
      </Field>
      {/* gaps, not margins: a button that wraps to the next line starts at the edge */}
      <View style={{ flexDirection: 'row', marginTop: 6, flexWrap: 'wrap', gap: 6 } as any}>
        <Button small label="Reveal folder" icon="folder" disabled={!engine.online || !s.sourcesPath} onPress={() => live.revealPath(s.sourcesPath)} testID="agent-sources-reveal" />
        <Button small label="Open as repository" icon="branch" disabled={!engine.online || !s.sourcesPath} onPress={() => void live.openPath(s.sourcesPath)} testID="agent-sources-open" />
        <Button small label="Open in editor" icon="edit" disabled={!engine.online || !s.sourcesPath} onPress={() => live.openInEditor(s.sourcesPath)} testID="agent-sources-editor" />
      </View>
      <View style={{ marginTop: 10 }}>
        <Checkbox checked={s.askBeforeApply} onChange={(v) => persist({ askBeforeApply: v })} label="Plan only: do not let the agent edit files (review in chat first)" testID="agent-plan-only" />
        <Checkbox checked={s.autoRollbackOnBuildError} onChange={(v) => persist({ autoRollbackOnBuildError: v })} label="Roll back an interface change whose build fails" testID="agent-auto-rollback" />
      </View>
      <Txt size={FONT.xs} faint style={{ marginTop: 12, lineHeight: 15 }}>
        Each change the agent makes to the interface is a commit: in the sources’ own repository, or in Prong’s log of them when the folder has none. Revert and Re-apply are git revert, Roll back here and Reset to factory revert every later change; the log is kept, so any version can be applied again.
      </Txt>
    </ScrollView>
  );
}

function toServerAgent(s: { provider: any; model: string; cliPath: string; sourcesPath: string; askBeforeApply: boolean; autoRollbackOnBuildError: boolean }) {
  return { provider: s.provider, model: s.model, cliPath: s.cliPath, sourcesPath: s.sourcesPath, askBeforeApply: s.askBeforeApply, autoRollbackOnBuildError: s.autoRollbackOnBuildError };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 10 }}>
      <Txt size={FONT.xs} muted weight="600" style={{ marginBottom: 4 }}>
        {label}
      </Txt>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderLeftWidth: 1, flexDirection: 'column' },
  head: { flexDirection: 'row', alignItems: 'center', height: 32, paddingHorizontal: 10, borderBottomWidth: 1 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1 },
  tab: { paddingHorizontal: 12, height: 26, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  msg: { borderLeftWidth: 2, paddingLeft: 8, paddingVertical: 4, marginBottom: 10 },
  composer: { borderTopWidth: 1, padding: 10 },
  chip: { borderWidth: 1, paddingHorizontal: 6, height: 20, justifyContent: 'center', marginRight: 6 },
  logHead: { flexDirection: 'row', alignItems: 'center', padding: 10, borderBottomWidth: 1 },
});
