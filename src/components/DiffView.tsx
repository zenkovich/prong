import React, { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import * as live from '../state/live';
import { DiffLine, FileChange, Hunk } from '../git/types';
import { discardFile, discardHunk, discardLines, loadLarge, relTime, resolveConflict, setDiffMode, stageFile, stageHunk, stageLines, toast, toggleHunk, unstageFile, unstageHunk, unstageLines, useRepo } from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Badge, Button, Chevron, FadeIn, PressScale, Segmented, Txt, webCursor } from '../ui/primitives';
import { statusColor } from './FileList';
import { langOf, LangDef, tokenize, TokenKind } from './highlight';
import { lineRange } from '../git/lineStaging';
import { MediaPreview } from './media/MediaPreview';
import { ErrorBoundary } from '../ui/ErrorBoundary';

const isMedia = (f: FileChange) => f.kind === 'image' || f.kind === 'audio' || f.kind === 'video' || f.kind === 'binary';

export function DiffView({ file, editable, area }: { file: FileChange | null; editable: boolean; area: 'unstaged' | 'staged' | 'commit' | 'stash' }) {
  const t = useTheme();
  const repo = useRepo();
  if (repo.blame) return <BlameView />;
  if (!file) {
    return (
      <View style={[styles.empty, { backgroundColor: t.panel }]}>
        <Icon name="file" size={28} color={t.textFaint} />
        <Txt muted style={{ marginTop: 8 }}>
          Select a file to see its diff
        </Txt>
      </View>
    );
  }
  const isUnstaged = area === 'unstaged';
  return (
    <View style={{ flex: 1, backgroundColor: t.panel }}>
      <View style={[styles.header, { borderColor: t.border, backgroundColor: t.panelAlt }]}>
        <Badge bg={statusColor(file.status, t) + '33'} color={statusColor(file.status, t)} mono>
          {file.status}
        </Badge>
        <Txt size={FONT.sm} mono numberOfLines={1} style={{ marginLeft: 8, flexShrink: 1 }}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </Txt>
        {file.similarity ? (
          <Txt size={FONT.xs} faint style={{ marginLeft: 6 }}>
            {file.similarity}% similar
          </Txt>
        ) : null}
        <View style={{ flex: 1 }} />
        {file.kind === 'text' && (
          <>
            <Txt size={FONT.xs} color={t.add} mono>
              +{file.additions}
            </Txt>
            <Txt size={FONT.xs} color={t.del} mono style={{ marginLeft: 6, marginRight: 10 }}>
              −{file.deletions}
            </Txt>
            <Segmented value={repo.diffMode} onChange={setDiffMode} options={[{ value: 'unified', icon: 'rows' }, { value: 'split', icon: 'columns' }]} />
          </>
        )}
        {editable && !file.conflict && (
          <View style={{ flexDirection: 'row', marginLeft: 10 }}>
            {isUnstaged ? (
              <>
                <Button small label="Discard" icon="undo" onPress={() => discardFile(file.path)} />
                <Button small primary label="Stage file" icon="plus" style={{ marginLeft: 6 }} onPress={() => stageFile(file.path)} />
              </>
            ) : (
              <Button small label="Unstage file" icon="minus" onPress={() => unstageFile(file.path)} />
            )}
          </View>
        )}
      </View>
      <FadeIn keyProp={file.path + area} slide={4} style={{ flex: 1 }}>
        <ErrorBoundary key={`${area}:${file.path}`} name="Preview" inline>
          {isMedia(file) ? (
            <MediaPreview file={file} area={area} rev={area === 'commit' ? repo.selectedCommit ?? '' : area === 'stash' ? `stash@{${repo.selectedStash ?? 0}}` : area} />
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
              <Body file={file} editable={editable} isUnstaged={isUnstaged} />
            </ScrollView>
          )}
        </ErrorBoundary>
      </FadeIn>
    </View>
  );
}

function Body({ file, editable, isUnstaged }: { file: FileChange; editable: boolean; isUnstaged: boolean }) {
  const t = useTheme();
  const repo = useRepo();
  if (file.conflict) return <ConflictView file={file} />;
  // listed with a big commit: the diff is on its way
  if (file.lazy && file.kind !== 'submodule')
    return (
      <Txt faint size={FONT.sm} style={{ padding: 16 }}>
        Loading the diff…
      </Txt>
    );
  if (file.truncated && file.hunks)
    return (
      <View>
        <View style={{ padding: 12 }}>
          <Notice icon="warning" title="Diff cut short" text="This diff is bigger than Prong reads at once; the start is shown. Open it in an external diff tool for the rest." color={t.warn} />
        </View>
        <TextDiff hunks={file.hunks} path={file.path} editable={false} isUnstaged={isUnstaged} />
      </View>
    );
  switch (file.kind) {
    case 'submodule':
      return <SubmoduleDiff file={file} />;
    case 'large':
      if (!repo.loadedLarge[file.path])
        return (
          <View style={{ padding: 16 }}>
            <Notice icon="warning" title="Large diff" text={`${(file.additions + file.deletions).toLocaleString()} changed lines. Rendering it may be slow.`} color={t.warn} />
            <View style={{ flexDirection: 'row', marginTop: 12 }}>
              <Button small primary label="Load anyway" onPress={() => loadLarge(file.path)} />
              <Button small label="Open in external diff tool" style={{ marginLeft: 8 }} onPress={() => (live.isLiveActive() ? live.openInDiffTool(live.absPath(file.path)) : toast('Launching external diff… (mock)', 'info'))} />
            </View>
          </View>
        );
      // the real diff replaces this file (kind 'text') once loaded; a mock repository shows a sample
      return repo.live ? (
        <Txt faint size={FONT.sm} style={{ padding: 16 }}>
          Loading the diff…
        </Txt>
      ) : (
        <TextDiff hunks={LARGE_PREVIEW} path={file.path} editable={false} isUnstaged={isUnstaged} />
      );
    default:
      return <TextDiff hunks={file.hunks ?? []} path={file.path} editable={editable} isUnstaged={isUnstaged} />;
  }
}

const LARGE_PREVIEW: Hunk[] = [
  {
    id: 'large-1',
    header: '@@ -1,6 +1,6 @@',
    lines: [
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'repo,commits,log_ms,status_ms,diff_ms' },
      { kind: 'del', oldNo: 2, text: 'linux,1240000,18420,96,310' },
      { kind: 'add', newNo: 2, text: 'linux,1251120,17980,91,305' },
      { kind: 'ctx', oldNo: 3, newNo: 3, text: 'chromium,1480000,21440,120,402' },
      { kind: 'del', oldNo: 4, text: 'rust,165000,2210,40,88' },
      { kind: 'add', newNo: 4, text: 'rust,166820,2190,39,85' },
      { kind: 'ctx', oldNo: 5, newNo: 5, text: '… 48 112 more lines …' },
    ],
  },
];

function PointerLine({ label, sha, subjects, isLive, onGo }: { label: string; sha: string; subjects: Record<string, string>; isLive: boolean; onGo?: (sha: string) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
      <Txt label faint size={10} style={{ width: 52 }}>
        {label}
      </Txt>
      {sha && onGo ? (
        <PressScale onPress={() => onGo(sha)} scaleTo={0.97} label={`Go to ${sha.slice(0, 7)} in the submodule`} testID={`submodule-pointer-${label}`}>
          <Txt size={FONT.sm} mono color={t.info} style={{ textDecorationLine: 'underline' }}>
            {sha.slice(0, 12)}
          </Txt>
        </PressScale>
      ) : (
        <Txt size={FONT.sm} mono color={t.info}>
          {sha ? sha.slice(0, 12) : '—'}
        </Txt>
      )}
      <Txt size={FONT.sm} muted style={{ marginLeft: 10, flex: 1 }} numberOfLines={1}>
        {sha && subjects[sha] ? subjects[sha] : sha && isLive ? '(commit not fetched in the submodule)' : ''}
      </Txt>
    </View>
  );
}

type SubRange = Awaited<ReturnType<typeof live.submoduleRange>>;

/**
 * A submodule pointer change: both pointers (click one to go there), the submodule commits it brought in or left
 * behind (click to go to that commit in the submodule's tab), and the way to the submodule itself.
 */
function SubmoduleDiff({ file }: { file: FileChange }) {
  const t = useTheme();
  const sm = file.submodule!;
  const [subjects, setSubjects] = useState<Record<string, string>>({});
  const [range, setRange] = useState<{ key: string; r: SubRange } | null>(null);
  const isLive = live.isLiveActive();
  const key = `${file.path}:${sm.before}:${sm.after}`;
  useEffect(() => {
    if (!isLive) return;
    let gone = false;
    void live.submoduleSubjects(file.path, [sm.before, sm.after].filter(Boolean)).then((x) => !gone && setSubjects(x));
    void live.submoduleRange(file.path, sm.before, sm.after).then((r) => !gone && setRange({ key, r }));
    return () => {
      gone = true;
    };
  }, [file.path, sm.before, sm.after, isLive, key]);
  const r = range?.key === key ? range.r : null;
  const name = file.path.split('/').pop() ?? file.path;
  const go = (sha?: string) => (isLive ? void live.openSubmoduleAt(file.path, sha) : toast(`Opened ${name} at ${sha?.slice(0, 7) ?? 'its HEAD'} (mock)`, 'info'));
  const canGo = !!sm.after && !r?.uninitialized && !r?.missing.includes(sm.after);
  const title = !sm.before ? 'Submodule added' : !sm.after ? 'Submodule removed' : 'Submodule pointer changed';
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 10 }} testID="submodule-diff">
      {/* one compact row: what changed and the way there, so the commit list fits under it */}
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
        <Icon name="layers" size={14} color={t.info} />
        <Txt size={FONT.md} weight="600" style={{ marginLeft: 8 }}>
          {title}
        </Txt>
        <Txt size={FONT.sm} muted style={{ marginLeft: 8, flexShrink: 1 }} numberOfLines={1}>
          {file.path}
        </Txt>
        <View style={{ flex: 1, minWidth: 12 }} />
        <Button small primary label={sm.after ? `Go to ${sm.after.slice(0, 7)} in ${name}` : `Open ${name}`} icon="layers" disabled={isLive && !!sm.after && !canGo} onPress={() => go(sm.after || undefined)} testID="submodule-go" />
        <Button small label="Update to index" icon="refresh" style={{ marginLeft: 6 }} onPress={() => (isLive ? live.updateSubmodules([file.path]) : toast('Submodule updated (mock)', 'success'))} />
      </View>
      <View style={{ marginTop: 8 }}>
        <PointerLine label="before" sha={sm.before} subjects={subjects} isLive={isLive} onGo={r && !r.uninitialized ? (s) => go(s) : undefined} />
        <PointerLine label="after" sha={sm.after} subjects={subjects} isLive={isLive} onGo={r && !r.uninitialized ? (s) => go(s) : undefined} />
      </View>
      {r?.uninitialized && (
        <Txt size={FONT.sm} color={t.warn} style={{ marginTop: 10 }}>
          The submodule is not checked out. “Update to index” clones it; then its commits can be opened.
        </Txt>
      )}
      {r && r.missing.length > 0 && (
        <Txt size={FONT.sm} color={t.warn} style={{ marginTop: 10 }}>
          The submodule clone does not have {r.missing.map((x) => x.slice(0, 7)).join(' and ')} yet: fetch in the submodule, or “Update to index”.
        </Txt>
      )}
      {r && r.added.length > 0 && <SubCommits title={`${r.added.length}${r.more ? '+' : ''} commit${r.added.length === 1 ? '' : 's'} brought in`} commits={r.added} onGo={go} testID="submodule-added" />}
      {r && r.removed.length > 0 && <SubCommits title={`${r.removed.length} commit${r.removed.length === 1 ? '' : 's'} left behind (the pointer moved back)`} commits={r.removed} onGo={go} testID="submodule-removed" />}
    </View>
  );
}

function SubCommits({ title, commits, onGo, testID }: { title: string; commits: NonNullable<SubRange>['added']; onGo: (sha: string) => void; testID: string }) {
  const t = useTheme();
  return (
    <View style={{ marginTop: 12 }} testID={testID}>
      <Txt label faint size={10} style={{ marginBottom: 4 }}>
        {title}
      </Txt>
      {commits.map((c) => (
        <PressScale key={c.sha} onPress={() => onGo(c.sha)} scaleTo={1} hoverStyle={{ backgroundColor: t.hover }} style={{ flexDirection: 'row', alignItems: 'center', height: 22, paddingHorizontal: 4 }} label={`Go to ${c.sha.slice(0, 7)} in the submodule`} testID={`submodule-commit-${c.sha.slice(0, 7)}`}>
          <Txt size={FONT.xs} mono color={t.info} style={{ width: 62 }}>
            {c.sha.slice(0, 7)}
          </Txt>
          <Txt size={FONT.sm} numberOfLines={1} style={{ flex: 1 }}>
            {c.subject}
          </Txt>
          <Txt size={FONT.xs} muted numberOfLines={1} style={{ width: 120, marginLeft: 8 }}>
            {c.author}
          </Txt>
          <Txt size={FONT.xs} faint style={{ width: 70, textAlign: 'right' }}>
            {relTime(c.date)}
          </Txt>
        </PressScale>
      ))}
    </View>
  );
}

function BlameView() {
  const t = useTheme();
  const repo = useRepo();
  const b = repo.blame!;
  const authors = useMemo(() => Array.from(new Set(b.lines.map((l) => l.author))), [b.lines]);
  return (
    <View style={{ flex: 1, backgroundColor: t.panel }}>
      <View style={[styles.header, { borderColor: t.border, backgroundColor: t.panelAlt }]}>
        <Txt label muted>
          blame
        </Txt>
        <Txt size={FONT.sm} mono style={{ marginLeft: 8, flex: 1 }} numberOfLines={1}>
          {b.path}
        </Txt>
        <Txt size={FONT.xs} faint style={{ marginRight: 10 }}>
          {b.lines.length} lines · {authors.length} authors
        </Txt>
        <Button small label="Close" icon="x" onPress={live.closeBlame} />
      </View>
      <ScrollView>
        {b.lines.length === 0 && (
          <Txt faint style={{ padding: 12 }}>
            loading…
          </Txt>
        )}
        {b.lines.map((l, i) => {
          const prev = b.lines[i - 1];
          const same = prev && prev.sha === l.sha;
          const color = t.lanes[authors.indexOf(l.author) % t.lanes.length];
          return (
            <View key={i} style={[styles.line, { backgroundColor: same ? 'transparent' : t.hover }]}>
              <PressScale onPress={() => (live.closeBlame(), selectCommitFromBlame(l.sha))} style={{ width: 230, flexDirection: 'row', alignItems: 'center', opacity: same ? 0.35 : 1 }}>
                <View style={{ width: 3, height: 14, backgroundColor: color, marginRight: 6 }} />
                <Txt size={FONT.xs} mono color={t.info} style={{ width: 62 }}>
                  {l.sha.slice(0, 7)}
                </Txt>
                <Txt size={FONT.xs} muted numberOfLines={1} style={{ width: 96 }}>
                  {l.author}
                </Txt>
                <Txt size={FONT.xs} faint numberOfLines={1} style={{ width: 60 }}>
                  {new Date(l.date).toLocaleDateString()}
                </Txt>
              </PressScale>
              <Txt size={FONT.xs} faint mono style={styles.gutter}>
                {i + 1}
              </Txt>
              <Code text={l.line} lang={langOf(b.path)} />
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function selectCommitFromBlame(sha: string) {
  import('../state/store').then((m) => m.selectCommit(sha));
}

function Notice({ icon, title, text, color }: { icon: any; title: string; text: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.notice, { borderColor: t.border, backgroundColor: t.panelAlt }]}>
      <Icon name={icon} size={20} color={color ?? t.textMuted} />
      <View style={{ marginLeft: 12, flex: 1 }}>
        <Txt weight="600">{title}</Txt>
        <Txt muted size={FONT.sm} mono style={{ marginTop: 2 }}>
          {text}
        </Txt>
      </View>
    </View>
  );
}

// ---------- text diff ----------

function TextDiff({ hunks, path, editable, isUnstaged }: { hunks: Hunk[]; path: string; editable: boolean; isUnstaged: boolean }) {
  const t = useTheme();
  const repo = useRepo();
  const lang = useMemo(() => langOf(path), [path]);
  // changed lines picked for staging / unstaging / discarding, within one hunk at a time
  const [picked, setPicked] = useState<{ path: string; hunkId: string; lines: number[]; anchor: number } | null>(null);
  const sel = picked && picked.path === path ? picked : null;
  const onLine = (h: Hunk, i: number, shift: boolean) => {
    if (!editable || h.lines[i]?.kind === 'ctx') return;
    if (shift && sel?.hunkId === h.id) return setPicked({ ...sel, lines: lineRange(h, sel.anchor, i) });
    const cur = sel?.hunkId === h.id ? sel.lines : [];
    const lines = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b);
    setPicked(lines.length ? { path, hunkId: h.id, lines, anchor: i } : null);
  };
  const clear = () => setPicked(null);
  if (hunks.length === 0)
    return (
      <View style={{ padding: 16 }}>
        <Txt muted>No textual changes.</Txt>
      </View>
    );
  return (
    <View>
      {editable && (
        <Txt size={FONT.xs} faint style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
          click changed lines to pick them (shift-click for a range), then {isUnstaged ? 'stage or discard' : 'unstage'} just those lines
        </Txt>
      )}
      {hunks.map((h, i) => {
        const collapsed = !!repo.collapsedHunks[h.id];
        const mine = sel?.hunkId === h.id ? sel.lines : [];
        const n = mine.length;
        return (
          <FadeIn key={h.id} delay={i * 40} slide={6}>
            <View style={[styles.hunkHeader, { backgroundColor: t.panelAlt, borderColor: t.border }]}>
              <PressScale onPress={() => toggleHunk(h.id)} scaleTo={1} style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <Chevron open={!collapsed} color={t.info} />
                <Txt size={FONT.xs} mono color={t.info} style={{ marginLeft: 6 }} numberOfLines={1}>
                  {h.header}
                </Txt>
              </PressScale>
              {editable && (
                <View style={{ flexDirection: 'row' }}>
                  {n > 0 ? (
                    <>
                      <Button small label="Clear" onPress={clear} />
                      {isUnstaged ? (
                        <>
                          <Button small label={`Discard ${n} line${n > 1 ? 's' : ''}`} style={{ marginLeft: 6 }} onPress={() => (discardLines(path, h.id, mine), clear())} testID="discard-lines" />
                          <Button small primary label={`Stage ${n} line${n > 1 ? 's' : ''}`} style={{ marginLeft: 6 }} onPress={() => (stageLines(path, h.id, mine), clear())} testID="stage-lines" />
                        </>
                      ) : (
                        <Button small primary label={`Unstage ${n} line${n > 1 ? 's' : ''}`} style={{ marginLeft: 6 }} onPress={() => (unstageLines(path, h.id, mine), clear())} testID="unstage-lines" />
                      )}
                    </>
                  ) : isUnstaged ? (
                    <>
                      <Button small label="Discard hunk" onPress={() => discardHunk(path, h.id)} />
                      <Button small label="Stage hunk" style={{ marginLeft: 6 }} onPress={() => stageHunk(path, h.id)} />
                    </>
                  ) : (
                    <Button small label="Unstage hunk" onPress={() => unstageHunk(path, h.id)} />
                  )}
                </View>
              )}
            </View>
            {!collapsed &&
              (repo.diffMode === 'split' ? (
                <SplitHunk hunk={h} lang={lang} picked={mine} onLine={editable ? (li, shift) => onLine(h, li, shift) : undefined} />
              ) : (
                <UnifiedHunk hunk={h} lang={lang} picked={mine} onLine={editable ? (li, shift) => onLine(h, li, shift) : undefined} />
              ))}
          </FadeIn>
        );
      })}
      <View style={[styles.hunkHeader, { backgroundColor: t.panelAlt, borderColor: t.border, justifyContent: 'center' }]}>
        <Txt size={FONT.xs} faint>
          Expand context ±10
        </Txt>
      </View>
    </View>
  );
}

/** one diff line; changed lines of an editable diff can be picked (click, shift-click for a range) */
function LineBox({ l, picked, onPick, children, style }: { l: DiffLine | null; picked: boolean; onPick?: (shift: boolean) => void; children: React.ReactNode; style?: any }) {
  const t = useTheme();
  const bg = !l ? t.bg : l.kind === 'add' ? t.addBg : l.kind === 'del' ? t.delBg : 'transparent';
  const box = [styles.line, { backgroundColor: bg, borderLeftWidth: 3, borderLeftColor: picked ? t.accent : 'transparent' }, picked && { backgroundColor: t.accentSoft }, style];
  if (!onPick || !l || l.kind === 'ctx') return <View style={box}>{children}</View>;
  return (
    <Pressable onPress={(e: any) => onPick(!!e?.nativeEvent?.shiftKey)} style={[box, webCursor('pointer')]} testID={picked ? 'line-picked' : undefined} {...({ dataSet: { line: l.kind } } as any)}>
      {children}
    </Pressable>
  );
}

const UnifiedHunk = memo(function UnifiedHunk({ hunk, lang, picked, onLine }: { hunk: Hunk; lang: Lang; picked: number[]; onLine?: (i: number, shift: boolean) => void }) {
  const t = useTheme();
  return (
    <View>
      {hunk.lines.map((l, i) => (
        <LineBox key={i} l={l} picked={picked.includes(i)} onPick={onLine ? (shift) => onLine(i, shift) : undefined}>
          <Txt size={FONT.xs} faint mono style={styles.gutter}>
            {l.oldNo ?? ''}
          </Txt>
          <Txt size={FONT.xs} faint mono style={styles.gutter}>
            {l.newNo ?? ''}
          </Txt>
          <Txt size={FONT.sm} mono color={l.kind === 'add' ? t.add : l.kind === 'del' ? t.del : t.textFaint} style={{ width: 16, textAlign: 'center' }}>
            {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
          </Txt>
          <Code text={l.text} lang={lang} />
        </LineBox>
      ))}
    </View>
  );
});

function SplitSide({ l, side, lang, picked, onPick }: { l: DiffLine | null; side: 'l' | 'r'; lang: Lang; picked: boolean; onPick?: (shift: boolean) => void }) {
  const t = useTheme();
  return (
    <LineBox l={l} picked={picked} onPick={onPick} style={[styles.splitSide, { borderColor: t.border }, side === 'l' && { borderRightWidth: 1 }]}>
      <Txt size={FONT.xs} faint mono style={styles.gutter}>
        {l ? (side === 'l' ? l.oldNo ?? '' : l.newNo ?? '') : ''}
      </Txt>
      {l ? <Code text={l.text} lang={lang} /> : <View style={{ flex: 1 }} />}
    </LineBox>
  );
}

const SplitHunk = memo(function SplitHunk({ hunk, lang, picked, onLine }: { hunk: Hunk; lang: Lang; picked: number[]; onLine?: (i: number, shift: boolean) => void }) {
  const pairs = useMemo(() => pairLines(hunk.lines), [hunk]);
  const pick = (l: DiffLine | null) => {
    const i = l ? hunk.lines.indexOf(l) : -1;
    return { picked: i >= 0 && picked.includes(i), onPick: onLine && i >= 0 ? (shift: boolean) => onLine(i, shift) : undefined };
  };
  return (
    <View>
      {pairs.map(([a, b], i) => (
        <View key={i} style={{ flexDirection: 'row' }}>
          <SplitSide l={a} side="l" lang={lang} {...pick(a && a.kind !== 'ctx' ? a : null)} />
          <SplitSide l={b} side="r" lang={lang} {...pick(b && b.kind !== 'ctx' ? b : null)} />
        </View>
      ))}
    </View>
  );
});

function pairLines(lines: DiffLine[]): [DiffLine | null, DiffLine | null][] {
  const out: [DiffLine | null, DiffLine | null][] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === 'ctx') {
      out.push([l, l]);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) out.push([dels[k] ?? null, adds[k] ?? null]);
    if (n === 0) i++;
  }
  return out;
}

// ---------- syntax highlighting (tokenizer in highlight.ts) ----------

type Lang = LangDef;

const Code = memo(function Code({ text, lang }: { text: string; lang: Lang }) {
  const t = useTheme();
  const colors = useMemo<Record<TokenKind, string>>(
    () => ({ plain: t.text, kw: t.kw, str: t.str, num: t.info, cm: t.textFaint, fn: t.tag, type: t.tagColor, prop: t.info, tag: t.tagColor, attr: t.kw, punct: t.textMuted, heading: t.accent, emph: t.kw, link: t.info, meta: t.tag }),
    [t],
  );
  const tokens = useMemo(() => tokenize(text, lang), [text, lang]);
  return (
    <Txt size={FONT.sm} mono style={{ flex: 1 }}>
      {tokens.length
        ? tokens.map((tok, i) => (
            <Txt key={i} size={FONT.sm} mono color={colors[tok.kind]} weight={tok.kind === 'heading' || tok.kind === 'emph' ? '700' : undefined} style={tok.kind === 'cm' ? { fontStyle: 'italic' } : undefined}>
              {tok.text}
            </Txt>
          ))
        : ' '}
    </Txt>
  );
});

// ---------- image diff ----------



// ---------- conflict ----------

function ConflictCol({ title, lines, color, action, lang }: { title: string; lines: string[]; color: string; action?: () => void; lang: Lang }) {
  const t = useTheme();
  return (
    <View style={[styles.conflictCol, { borderColor: t.border }]}>
      <View style={[styles.conflictHead, { backgroundColor: color + '22', borderColor: t.border }]}>
        <Txt size={FONT.xs} weight="700" color={color}>
          {title}
        </Txt>
        <View style={{ flex: 1 }} />
        {action && <Button small label="Take" onPress={action} />}
      </View>
      {lines.map((l, i) => (
        <View key={i} style={styles.line}>
          <Txt size={FONT.xs} faint mono style={styles.gutter}>
            {i + 1}
          </Txt>
          <Code text={l} lang={lang} />
        </View>
      ))}
    </View>
  );
}

function ConflictView({ file }: { file: FileChange }) {
  const t = useTheme();
  const c = file.conflict!;
  return (
    <View style={{ padding: 12 }}>
      <View style={[styles.notice, { borderColor: t.warn + '66', backgroundColor: t.warn + '14', marginBottom: 12 }]}>
        <Icon name="warning" size={18} color={t.warn} />
        <Txt style={{ marginLeft: 10, flex: 1 }}>Merge conflict. Choose a side or edit the file, then mark it resolved.</Txt>
        <Button small label="Use ours" onPress={() => resolveConflict(file.path, 'ours')} />
        <Button small label="Use theirs" style={{ marginLeft: 6 }} onPress={() => resolveConflict(file.path, 'theirs')} />
        <Button small label="Both" style={{ marginLeft: 6 }} onPress={() => resolveConflict(file.path, 'both')} />
      </View>
      <View style={{ flexDirection: 'row' }}>
        <ConflictCol lang={langOf(file.path)} title="OURS (HEAD)" lines={c.ours} color={t.accent} action={() => resolveConflict(file.path, 'ours')} />
        <View style={{ width: 8 }} />
        <ConflictCol lang={langOf(file.path)} title="BASE" lines={c.base} color={t.textMuted} />
        <View style={{ width: 8 }} />
        <ConflictCol lang={langOf(file.path)} title="THEIRS" lines={c.theirs} color={t.add} action={() => resolveConflict(file.path, 'theirs')} />
      </View>
    </View>
  );
}


const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', height: 34, paddingHorizontal: 10, borderBottomWidth: 1 },
  hunkHeader: { flexDirection: 'row', alignItems: 'center', height: 28, paddingHorizontal: 10, borderBottomWidth: 1, borderTopWidth: 1 },
  line: { flexDirection: 'row', alignItems: 'center', minHeight: 20, paddingRight: 10 },
  gutter: { width: 42, textAlign: 'right', paddingRight: 8 },
  splitSide: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 20, paddingRight: 8 },
  notice: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, borderRadius: 0 },
  conflictCol: { flex: 1, borderWidth: 1, borderRadius: 0, overflow: 'hidden' },
  conflictHead: { flexDirection: 'row', alignItems: 'center', height: 28, paddingHorizontal: 8, borderBottomWidth: 1 },
});
