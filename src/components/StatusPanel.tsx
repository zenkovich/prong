import React, { useEffect, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, View } from 'react-native';
import type { QueueItem } from '../git/types';
import { cancelOperation, dismissToast, showErrors, useRepo, useStore } from '../state/store';
import { cancelQueued, mergeAbort, rebaseAbort, rebaseContinue, removeStaleLock, undoLast } from '../state/live';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Button, PressScale, Spinner, Txt } from '../ui/primitives';

const NO_ITEMS: QueueItem[] = [];
/** a lock unchanged for this long was probably left by a git that crashed (the engine refuses to delete it sooner) */
const STALE_LOCK_MS = 60_000;
/** an action that runs alone shows up once it takes this long (a checkout of a large repository) */
const SLOW_MS = 700;
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);
const lockName = (p?: string) => p?.split('/').pop() ?? 'a lock';

/**
 * The status panel on the right of the toolbar — the one place for status and progress (there is no status bar at
 * the bottom). Idle: the current branch, ahead / behind its upstream, a merge or rebase in progress with Continue and
 * Abort. While something runs: what it is, its progress and a stop button (a click shows git's output); an action
 * waiting for its turn or for another git process's lock (a click lists the queue: cancel, delete a stale lock).
 * After an action, its result for a few seconds (an error opens the error dialog). On the right: the session's
 * error count, a stopped engine, Undo of the last action (⌘Z). On the start screen it has no branch and no Undo.
 */
export function StatusPanel({ welcome }: { welcome?: boolean }) {
  const t = useTheme();
  const repo = useRepo();
  const op = useStore((s) => s.operation);
  const engine = useStore((s) => s.engine);
  const errorCount = useStore((s) => s.errors.length);
  const repoPath = useStore((s) => (welcome ? undefined : s.repos.find((r) => r.id === s.activeTab && r.live)?.path));
  const queue = useStore((s) => (repoPath ? s.queues[repoPath] : undefined)) ?? NO_ITEMS;
  const undo = useStore((s) => (!welcome && s.activeTab ? s.undo[s.activeTab] : undefined));
  // the newest notification while it lasts (they leave the store by themselves after a few seconds)
  const last = useStore((s) => s.toasts[s.toasts.length - 1]);
  const [pop, setPop] = useState<'log' | 'queue' | null>(null);
  // a clock for "taking a while" and lock ages, ticking only while the queue has something
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!queue.length) return;
    const h = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(h);
  }, [queue.length]);
  const progress = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    Animated.timing(progress, { toValue: op?.progress ?? 0, duration: 80, easing: Easing.linear, useNativeDriver: false }).start();
  }, [op?.progress, progress]);

  const cur = repo.refs.find((r) => r.kind === 'branch' && r.current);
  const inOp = !welcome && repo.opKind && repo.opKind !== 'none' ? repo.opKind : null;
  // a long operation already has its progress here: its queue entry is not shown twice
  const queued = queue.filter((i) => !(i.state === 'running' && i.label === op?.label));
  const waiting = queued.find((i) => i.state === 'waiting-lock');
  const showQueue = queued.length > 0 && (!!waiting || queued.length > 1 || now - queued[0].since > SLOW_MS);
  const top = undo?.at(-1);
  // a list whose subject is gone closes
  if (pop === 'log' && !op) setPop(null);
  if (pop === 'queue' && !showQueue) setPop(null);

  let body: React.ReactNode;
  if (op) {
    body = (
      <PressScale onPress={() => setPop(pop === 'log' ? null : 'log')} scaleTo={1} outerStyle={styles.grow} style={styles.row} label="Show the output" testID="activity-op">
        <Spinner size={11} />
        <Txt size={FONT.sm} numberOfLines={1} style={{ marginLeft: 7, flexShrink: 1 }}>
          {op.label}
        </Txt>
        <Txt size={FONT.xs} faint mono style={{ marginLeft: 8 }}>
          {Math.round(op.progress * 100)}%
        </Txt>
      </PressScale>
    );
  } else if (showQueue) {
    const head = waiting ?? queued[0];
    body = (
      <PressScale onPress={() => setPop(pop === 'queue' ? null : 'queue')} scaleTo={1} outerStyle={styles.grow} style={styles.row} label="Action queue" testID="queue-status">
        {waiting ? <Icon name="lock" size={11} color={t.warn} /> : <Spinner size={11} />}
        <Txt size={FONT.sm} color={waiting ? t.warn : t.text} numberOfLines={1} style={{ marginLeft: 7, flexShrink: 1 }}>
          {waiting ? `Waiting for ${lockName(waiting.lock)} · ${head.label}` : `${head.label}…`}
          {queued.length > 1 ? ` · ${queued.length - 1} more` : ''}
        </Txt>
      </PressScale>
    );
  } else if (last) {
    const color = last.kind === 'error' ? t.del : last.kind === 'success' ? t.add : t.info;
    body = (
      <PressScale
        onPress={() => (last.errorId ? showErrors(last.errorId) : dismissToast(last.id))}
        scaleTo={1}
        outerStyle={styles.grow}
        style={styles.row}
        label={last.errorId ? 'Show the error' : 'Dismiss'}
        testID="status-notice"
      >
        <Icon name={last.kind === 'error' ? 'warning' : last.kind === 'success' ? 'check' : 'info'} size={11} color={color} />
        <Txt size={FONT.sm} color={color} numberOfLines={1} style={{ marginLeft: 7, flexShrink: 1 }} testID="activity-result">
          {last.text}
          {last.detail ? <Txt size={FONT.xs} color={color}>{` · ${last.detail}`}</Txt> : null}
        </Txt>
        {last.errorId ? (
          <Txt size={FONT.xs} color={color} style={{ marginLeft: 6, textDecorationLine: 'underline' }}>
            details
          </Txt>
        ) : null}
      </PressScale>
    );
  } else if (!welcome && repo.loading) {
    body = (
      <View style={[styles.row, styles.grow]}>
        <Spinner size={11} />
        <Txt size={FONT.sm} muted style={{ marginLeft: 7 }}>
          loading
        </Txt>
      </View>
    );
  } else if (welcome) {
    body = (
      <View style={[styles.row, styles.grow]} testID="activity-idle">
        <View style={{ width: 6, height: 6, backgroundColor: engine.online ? t.add : t.del }} />
        <Txt size={FONT.sm} faint numberOfLines={1} style={{ marginLeft: 7, flexShrink: 1 }}>
          {engine.online ? `engine · ${engine.git.replace('git version ', 'git ')}` : 'engine offline'}
        </Txt>
      </View>
    );
  } else {
    body = (
      <View style={[styles.row, styles.grow]} testID="activity-branch">
        {cur ? <View style={{ width: 7, height: 7, backgroundColor: t.accent }} /> : <Icon name="commit" size={11} color={t.warn} />}
        <Txt size={FONT.sm} weight="600" numberOfLines={1} style={{ marginLeft: 7, flexShrink: 1 }}>
          {cur ? cur.name : repo.head ? `detached at ${repo.head.slice(0, 7)}` : repo.live ? '…' : 'no branch'}
        </Txt>
        {cur?.upstream ? (
          <Txt size={FONT.xs} faint numberOfLines={1} style={{ marginLeft: 8, flexShrink: 2 }}>
            {[cur.ahead ? `↑${cur.ahead}` : '', cur.behind ? `↓${cur.behind}` : '', cur.gone ? `${cur.upstream} gone` : !cur.ahead && !cur.behind ? `= ${cur.upstream}` : cur.upstream].filter(Boolean).join(' ')}
          </Txt>
        ) : cur ? (
          <Txt size={FONT.xs} faint style={{ marginLeft: 8 }}>
            not published
          </Txt>
        ) : null}
        {inOp && (
          <>
            <Txt label size={9.5} color={t.warn} style={{ marginLeft: 8 }} numberOfLines={1}>
              {inOp} in progress
            </Txt>
            {inOp === 'rebase' && <Button small label="Continue" primary style={{ marginLeft: 6, height: 18 }} onPress={rebaseContinue} testID="op-continue" />}
            <Button small label="Abort" style={{ marginLeft: 4, height: 18 }} onPress={inOp === 'rebase' ? rebaseAbort : mergeAbort} testID="op-abort" />
          </>
        )}
      </View>
    );
  }

  return (
    <View style={{ flexDirection: 'row', alignItems: 'stretch', width: '100%', minWidth: 0 }} testID="activity-box">
      <View style={[styles.box, { borderColor: t.border, backgroundColor: t.bg }]} testID="status-bar">
        {body}
        {op && (
          <PressScale onPress={cancelOperation} scaleTo={0.9} style={{ marginLeft: 6, padding: 2 }} hoverStyle={{ backgroundColor: t.hover }} label={`Stop ${op.label}`} testID="activity-stop">
            <Icon name="x" size={11} />
          </PressScale>
        )}
        {errorCount > 0 && (
          <PressScale onPress={() => showErrors()} scaleTo={0.94} style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8, paddingHorizontal: 3 }} hoverStyle={{ backgroundColor: t.hover }} label={`Errors of this session: ${errorCount}`} testID="error-log-button">
            <Icon name="warning" size={11} color={t.del} />
            <Txt size={FONT.xs} color={t.del} style={{ marginLeft: 3 }}>
              {errorCount}
            </Txt>
          </PressScale>
        )}
        {!engine.online && !welcome && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8 }} testID="engine-offline">
            <View style={{ width: 6, height: 6, backgroundColor: t.del }} />
            <Txt size={FONT.xs} color={t.del} style={{ marginLeft: 4 }}>
              {repo.live ? 'engine offline' : 'mock'}
            </Txt>
          </View>
        )}
        {op && <Animated.View style={{ position: 'absolute', left: 0, bottom: 0, height: 2, backgroundColor: t.accent, width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />}
      </View>
      {!welcome && (
        <PressScale
          onPress={() => undoLast()}
          disabled={!top || !!op}
          scaleTo={0.94}
          style={[styles.undo, { borderColor: t.border, backgroundColor: t.bg }]}
          hoverStyle={{ backgroundColor: t.hover }}
          label={top ? `Undo ${top.label} (⌘Z)` : 'Nothing to undo'}
          testID="undo-button"
        >
          <Icon name="undo" size={12} color={top ? t.text : t.textFaint} />
        </PressScale>
      )}
      {pop === 'log' && op && (
        <View style={[styles.pop, { backgroundColor: t.panel, borderColor: t.border, shadowColor: t.shadow }]} testID="op-log">
          <Txt label faint size={10} style={{ marginBottom: 6 }}>
            {op.label}
          </Txt>
          <ScrollView style={{ maxHeight: 220 }}>
            {op.log.length ? (
              op.log.map((l, i) => (
                <Txt key={i} size={FONT.xs} mono muted selectable>
                  {l}
                </Txt>
              ))
            ) : (
              <Txt size={FONT.xs} mono faint>
                …
              </Txt>
            )}
          </ScrollView>
        </View>
      )}
      {pop === 'queue' && repoPath && <QueueList items={queued} repoPath={repoPath} now={now} />}
    </View>
  );
}

/** the repository's action queue under the panel: what runs, what waits; cancel what has not started, delete a stale lock */
function QueueList({ items, repoPath, now }: { items: QueueItem[]; repoPath: string; now: number }) {
  const t = useTheme();
  return (
    <View style={[styles.pop, { backgroundColor: t.panel, borderColor: t.border, shadowColor: t.shadow }]} testID="queue-panel">
      <Txt label faint size={10} style={{ marginBottom: 6 }}>
        Actions on this repository · one at a time
      </Txt>
      {items.map((i, n) => {
        const stale = i.state === 'waiting-lock' && i.lockSince != null && now - i.lockSince > STALE_LOCK_MS;
        return (
          <View key={i.id} style={{ paddingVertical: 4, borderTopWidth: n ? 1 : 0, borderColor: t.border }} testID={`queue-item-${i.state}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ width: 16 }}>{i.state === 'running' ? <Spinner size={11} /> : i.state === 'waiting-lock' ? <Icon name="lock" size={11} color={t.warn} /> : <Txt size={FONT.xs} faint>{n + 1}</Txt>}</View>
              <Txt size={FONT.sm} numberOfLines={1} style={{ flex: 1 }}>
                {i.label}
              </Txt>
              <Txt size={FONT.xs} faint style={{ marginLeft: 8 }}>
                {i.state === 'running' ? `running · ${ago(now - i.since)}` : i.state === 'queued' ? 'next in line' : `waiting · ${ago(now - i.since)}`}
              </Txt>
              {i.state !== 'running' && (
                <PressScale onPress={() => cancelQueued(i.id)} scaleTo={0.9} style={{ marginLeft: 6, padding: 2 }} hoverStyle={{ backgroundColor: t.hover }} label={`Cancel ${i.label}`} testID={`queue-cancel-${i.id}`}>
                  <Icon name="x" size={11} />
                </PressScale>
              )}
            </View>
            {i.state === 'waiting-lock' && (
              <View style={{ marginLeft: 16, marginTop: 3 }}>
                <Txt size={FONT.xs} color={t.warn}>
                  {lockName(i.lock)} is held by another git process{i.lockSince ? `, unchanged for ${ago(now - i.lockSince)}` : ''}. Runs as soon as it is released.
                </Txt>
                {stale && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                    <Button small danger label={`Delete ${lockName(i.lock)}…`} onPress={() => removeStaleLock(repoPath, i.lock!)} testID="queue-remove-lock" />
                    <Txt size={FONT.xs} faint style={{ marginLeft: 8, flexShrink: 1 }}>
                      only if no git is running here: a crash leaves it behind
                    </Txt>
                  </View>
                )}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  box: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', height: 24, paddingHorizontal: 10, borderWidth: 1, overflow: 'hidden' },
  undo: { height: 24, width: 28, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderLeftWidth: 0 },
  pop: { position: 'absolute', top: 27, right: 0, width: 480, borderWidth: 1, padding: 10, zIndex: 80, shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
});
