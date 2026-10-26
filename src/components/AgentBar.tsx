import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { elapsed, summarize } from '../agent/status';
import { AgentTarget } from '../agent/types';
import { agentSend, agentStop, dismissAgentNotice, setAgentTarget, setVersionStatus, toggleAgent, toggleAgentBar, useStore } from '../state/store';
import { FONT, TABS_H, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Glass, PressScale, Spinner, Txt } from '../ui/primitives';
import { Markdown } from './Markdown';

/**
 * The agent lives in the tab bar as one line:
 * - idle: an AGENT button; a click unfolds it into a command line (⌘J), Esc folds it back;
 * - working: the line shows what Claude Code is doing right now, the elapsed time and a stop button;
 * - done: a card under the bar says what was done; it stays until closed.
 * ⤢ opens the full chat panel (history, versions, settings) as before.
 */

const NEXT: Record<AgentTarget, AgentTarget> = { auto: 'repo', repo: 'app', app: 'auto' };

export function AgentBar() {
  const t = useTheme();
  const agent = useStore((s) => s.agent);
  const [text, setText] = useState('');
  const input = useRef<any>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!agent.busy) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [agent.busy]);
  useEffect(() => {
    if (agent.bar && !agent.busy) setTimeout(() => input.current?.focus(), 30);
  }, [agent.bar, agent.busy]);
  const send = () => {
    if (!text.trim() || agent.busy) return;
    agentSend(text);
    setText('');
  };

  if (agent.busy)
    return (
      <View testID="agent-bar" style={[styles.line, { borderColor: t.accent, backgroundColor: t.panel, width: 380 }]}>
        <Spinner size={12} />
        <PressScale onPress={() => toggleAgent(true)} scaleTo={1} style={{ flex: 1, marginLeft: 8, minWidth: 0 }} label="Open the agent chat">
          <Txt size={FONT.sm} numberOfLines={1} testID="agent-status">
            {agent.status ?? 'Working…'}
          </Txt>
        </PressScale>
        <Txt size={FONT.xs} faint mono style={{ marginHorizontal: 8 }}>
          {agent.startedAt ? `${Math.floor((now - agent.startedAt) / 1000)} s` : ''}
        </Txt>
        <PressScale onPress={agentStop} scaleTo={0.9} style={styles.icon} hoverStyle={{ backgroundColor: t.hover }} label="Stop the agent" testID="agent-stop">
          <Icon name="stop" size={11} color={t.del} />
        </PressScale>
        <PressScale onPress={() => toggleAgent(true)} scaleTo={0.9} style={styles.icon} hoverStyle={{ backgroundColor: t.hover }} label="Open the full agent window">
          <Icon name="expand" size={12} />
        </PressScale>
      </View>
    );

  if (!agent.bar)
    return (
      <PressScale onPress={() => toggleAgentBar(true)} scaleTo={0.96} style={[styles.button, { borderColor: agent.open ? t.accent : t.borderStrong, backgroundColor: agent.open ? t.accentSoft : t.panel }]} hoverStyle={{ borderColor: t.accent }} label="Agent (⌘J)" testID="agent-button">
        <Icon name="agent" size={13} color={t.accent} />
        <Txt label size={FONT.xs} style={{ marginLeft: 5 }} color={agent.open ? t.accent : undefined}>
          agent
        </Txt>
        {agent.notices.length > 0 && (
          <View style={[styles.count, { backgroundColor: agent.notices.some((n) => !n.ok) ? t.del : t.accent }]}>
            <Txt size={9.5} weight="700" color={t.accentText}>
              {agent.notices.length}
            </Txt>
          </View>
        )}
      </PressScale>
    );

  return (
    <View testID="agent-bar" style={[styles.line, { borderColor: t.accent, backgroundColor: t.bg, width: 460 }]}>
      <Icon name="agent" size={13} color={t.accent} />
      <PressScale onPress={() => setAgentTarget(NEXT[agent.target])} scaleTo={0.95} style={[styles.target, { borderColor: t.borderStrong }]} hoverStyle={{ borderColor: t.accent }} label="Where the request runs: auto, repository or Prong's own interface (click to change)">
        <Txt label size={9.5} color={agent.target === 'auto' ? t.textMuted : t.accent}>
          {agent.target}
        </Txt>
      </PressScale>
      <TextInput
        ref={input}
        value={text}
        onChangeText={setText}
        placeholder="ask the agent: repository or interface…"
        placeholderTextColor={t.textFaint}
        onSubmitEditing={send}
        onKeyPress={(e: any) => e.nativeEvent?.key === 'Escape' && toggleAgentBar(false)}
        testID="agent-input"
        style={{ flex: 1, minWidth: 0, color: t.text, fontFamily: t.fontFor('400'), fontSize: FONT.sm, paddingVertical: 0, ...({ outlineStyle: 'none' } as any) }}
      />
      <PressScale onPress={send} disabled={!text.trim()} scaleTo={0.9} style={styles.icon} hoverStyle={{ backgroundColor: t.hover }} label="Send (↵)" testID="agent-send">
        <Icon name="send" size={12} color={text.trim() ? t.accent : t.textFaint} />
      </PressScale>
      <PressScale onPress={() => toggleAgent(true)} scaleTo={0.9} style={styles.icon} hoverStyle={{ backgroundColor: t.hover }} label="Open the full agent window (⌘⇧J)" testID="agent-expand">
        <Icon name="expand" size={12} />
      </PressScale>
      <PressScale onPress={() => toggleAgentBar(false)} scaleTo={0.9} style={styles.icon} hoverStyle={{ backgroundColor: t.hover }} label="Fold (Esc)">
        <Icon name="x" size={12} />
      </PressScale>
    </View>
  );
}

/** Cards with finished runs, under the agent bar; each stays until its × is pressed. */
export function AgentNotices() {
  const t = useTheme();
  const notices = useStore((s) => s.agent.notices);
  const versions = useStore((s) => s.agent.versions);
  const panelOpen = useStore((s) => s.agent.open);
  const panelW = useStore((s) => s.agent.width);
  if (!notices.length) return null;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: TABS_H + 6, right: 10 + (panelOpen ? panelW + 6 : 0), width: 420, zIndex: 120 }}>
      {notices.slice(0, 3).map((n) => {
        const v = n.versionId ? versions.find((x) => x.id === n.versionId) : undefined;
        const color = n.title === 'No changes' || n.title === 'Stopped' ? t.warn : n.ok ? t.add : t.del;
        return (
          <Glass key={n.id} style={[styles.card, { borderLeftColor: color }]}>
            <View testID="agent-notice" style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Icon name={n.ok && n.title !== 'No changes' ? 'check' : 'warning'} size={13} color={color} />
              <Txt label size={10} color={color} style={{ marginLeft: 6 }}>
                {n.title}
              </Txt>
              <Txt size={FONT.xs} faint style={{ marginLeft: 8, flex: 1 }} numberOfLines={1}>
                {[n.target, n.durationMs !== undefined ? elapsed(n.durationMs) : null, n.cost].filter(Boolean).join(' · ')}
              </Txt>
              <PressScale onPress={() => dismissAgentNotice(n.id)} scaleTo={0.9} style={styles.icon} hoverStyle={{ backgroundColor: t.hover }} label="Close" testID="agent-notice-close">
                <Icon name="x" size={12} />
              </PressScale>
            </View>
            <ScrollView style={{ maxHeight: 220, marginTop: 6 }}>
              <Markdown text={n.text} size={FONT.sm} />
            </ScrollView>
            {n.actions.length > 0 && (
              <Txt size={FONT.xs} muted numberOfLines={2} style={{ marginTop: 6 }}>
                {summarize(n.actions)}
              </Txt>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6 } as any}>
              <PressScale onPress={() => toggleAgent(true)} scaleTo={0.96} style={[styles.chip, { borderColor: t.borderStrong }]} hoverStyle={{ borderColor: t.accent }}>
                <Txt label size={9.5}>open chat</Txt>
              </PressScale>
              <PressScale onPress={() => toggleAgentBar(true)} scaleTo={0.96} style={[styles.chip, { borderColor: t.borderStrong }]} hoverStyle={{ borderColor: t.accent }}>
                <Txt label size={9.5}>reply</Txt>
              </PressScale>
              {v && (
                <PressScale onPress={() => setVersionStatus(v.id, v.status === 'applied' ? 'reverted' : 'applied')} scaleTo={0.96} style={[styles.chip, { borderColor: t.borderStrong }]} hoverStyle={{ borderColor: t.accent }}>
                  <Txt label size={9.5} color={t.accent}>
                    {v.status === 'applied' ? `revert v${v.n}` : `re-apply v${v.n}`}
                  </Txt>
                </PressScale>
              )}
            </View>
          </Glass>
        );
      })}
      {notices.length > 3 && (
        <Txt size={FONT.xs} faint style={{ textAlign: 'right', marginTop: 4 }}>
          +{notices.length - 3} more · open chat to see all
        </Txt>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', height: 24, paddingHorizontal: 8, borderWidth: 1 },
  line: { flexDirection: 'row', alignItems: 'center', height: 26, paddingLeft: 8, paddingRight: 2, borderWidth: 1, flexShrink: 1, minWidth: 220 },
  target: { borderWidth: 1, paddingHorizontal: 5, height: 16, justifyContent: 'center', marginHorizontal: 8 },
  icon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  count: { minWidth: 14, height: 14, paddingHorizontal: 3, marginLeft: 6, alignItems: 'center', justifyContent: 'center' },
  card: { padding: 10, marginBottom: 8, borderLeftWidth: 3 },
  chip: { borderWidth: 1, paddingHorizontal: 7, height: 20, justifyContent: 'center' },
});
