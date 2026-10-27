import React, { memo, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import * as live from '../state/live';
import { DiffLine, FileChange, Hunk } from '../git/types';
import { discardFile, discardHunk, discardLines, loadLarge, markResolved, relTime, resolveConflict, revealCommit, setDiffMode, setSection, stageFile, stageHunk, stageLines, toast, toggleHunk, unstageFile, unstageHunk, unstageLines, useRepo } from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Badge, Button, Chevron, FadeIn, PressScale, Segmented, Txt, useKeyboard, webCursor } from '../ui/primitives';
import { insideText, statusColor } from './FileList';
import { langOf, LangDef, tokenize, TokenKind } from './highlight';
import { lineRange } from '../git/lineStaging';
import { coversWholeFile } from '../git/diffContext';
import { MediaPreview } from './media/MediaPreview';
import { ErrorBoundary } from '../ui/ErrorBoundary';

const isMedia = (f: FileChange) => f.kind === 'image' || f.kind === 'audio' || f.kind === 'video' || f.kind === 'binary';

/**
 * F7 / F8: the next / previous hunk of the diff shown (the shortcut list promised it; nothing answered): its header
 * scrolled to the top of the diff.
 */
function jumpHunk(dir: 1 | -1) {
  if (Platform.OS !== 'web') return;
  const box = document.querySelector('[data-testid="diff-body"]') as HTMLElement | null;
  if (!box) return;
  // layout positions (offsetTop), not the drawn ones: a hunk fades in sliding a few pixels
  const yIn = (el: HTMLElement) => {
    let y = 0;
    let n: HTMLElement | null = el;
    while (n && n !== box) {
      y += n.offsetTop;
      n = n.offsetParent as HTMLElement | null;
    }
    return n === box ? y : el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  };
  const heads = [...box.querySelectorAll<HTMLElement>('[data-testid="hunk-toggle"]')].map(yIn);
  // the hunk at the top now (its header at or just above the top), then the one after or before it
  const now = box.scrollTop;
  const cur = heads.reduce((k, y, i) => (y <= now + 12 ? i : k), -1);
  const target = dir > 0 ? heads[cur + 1] : cur >= 0 && heads[cur] < now - 12 ? heads[cur] : cur > 0 ? heads[cur - 1] : 0;
  // the first hunk: the very top, with whatever is above it
  if (target !== undefined) box.scrollTop = target === heads[0] ? 0 : Math.max(0, target);
}

export function DiffView({ file, editable, area }: { file: FileChange | null; editable: boolean; area: 'unstaged' | 'staged' | 'commit' | 'stash' }) {
  const t = useTheme();
  const repo = useRepo();
  useKeyboard((e) => {
    if ((e.key !== 'F7' && e.key !== 'F8') || e.meta) return;
    const target = e.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
    e.preventDefault();
    jumpHunk(e.key === 'F7' ? 1 : -1);
  });
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
      <View style={[styles.header, { borderColor: t.border, backgroundColor: t.panelAlt }]} testID="diff-header">
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
        {file.kind === 'text' && !file.conflict && file.status !== 'U' && (
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
        {/* a conflicted file is resolved in its view below (sides, Mark resolved); a submodule's own files are
            committed in the submodule (its view opens it) */}
        {editable && !file.conflict && file.status !== 'U' && !(isUnstaged && file.inside?.only) && (
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
          {isMedia(file) && !file.conflict ? (
            <MediaPreview file={file} area={area} rev={area === 'commit' ? repo.selectedCommit ?? '' : area === 'stash' ? `stash@{${repo.selectedStash ?? 0}}` : area} />
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }} testID="diff-body">
              <Body file={file} editable={editable} isUnstaged={isUnstaged} working={area === 'unstaged' || area === 'staged'} />
            </ScrollView>
          )}
        </ErrorBoundary>
      </FadeIn>
    </View>
  );
}

/**
 * why a text change shows no lines: a rename or copy with the same content, a mode change, an empty file added or
 * deleted, line endings only
 */
function noLinesNote(file: FileChange) {
  const exec = (m: string) => m.endsWith('755');
  const mode =
    file.mode && file.mode.before !== file.mode.after
      ? `the file mode changed: ${file.mode.before} → ${file.mode.after}${exec(file.mode.after) && !exec(file.mode.before) ? ' (made executable)' : exec(file.mode.before) && !exec(file.mode.after) ? ' (no longer executable)' : ''}`
      : '';
  // a pure rename (or copy) said "No textual changes."
  if (file.status === 'R') return `Renamed from ${file.oldPath ?? 'another path'}; the content is the same${mode ? `, and ${mode}` : ''}.`;
  if (file.status === 'C') return `Copied from ${file.oldPath ?? 'another path'}; the content is the same.`;
  if (mode) return `Only ${mode}.`;
  if (file.status === '?' || file.status === 'A') return 'A new, empty file.';
  if (file.status === 'D') return 'An empty file, deleted.';
  return 'No textual changes: only line endings or file attributes differ.';
}

function Body({ file, editable, isUnstaged, working }: { file: FileChange; editable: boolean; isUnstaged: boolean; working: boolean }) {
  const t = useTheme();
  const repo = useRepo();
  if (file.conflict) return <ConflictView file={file} />;
  // an untracked folder still listed whole: a repository of its own, or more files than are listed
  if (file.status === '?' && file.path.endsWith('/'))
    return (
      <View style={{ padding: 16 }} testID="untracked-folder-note">
        <Txt muted>A new folder, listed whole: it is a repository of its own, or holds more files than Prong lists one by one.</Txt>
        <Txt faint size={FONT.sm} style={{ marginTop: 6 }}>
          Stage adds all of it (a repository of its own goes in as a pointer to its commit); Discard deletes a folder of files but leaves a repository alone; or add it to .gitignore from its menu.
        </Txt>
      </View>
    );
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
      if (file.hunks?.length)
        return (
          <TextDiff
            hunks={file.hunks}
            path={file.path}
            editable={editable}
            isUnstaged={isUnstaged}
            // more unchanged lines around the changes, until the whole file shows (live repositories)
            onExpand={repo.live && !file.contextAll && !coversWholeFile(file) ? () => void live.expandContext(file.path) : undefined}
          />
        );
      // a working-copy file's diff is read when it is selected: until then nothing is known about its lines
      if (working && repo.live && !file.hunks)
        return (
          <Txt faint size={FONT.sm} style={{ padding: 16 }}>
            Loading the diff…
          </Txt>
        );
      return (
        <View style={{ padding: 16 }} testID="diff-no-lines">
          <Txt muted>{noLinesNote(file)}</Txt>
        </View>
      );
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
const NO_POINTERS = { before: '', after: '' };

/**
 * A submodule pointer change: both pointers (click one to go there), the submodule commits it brought in or left
 * behind (click to go to that commit in the submodule's tab), and the way to the submodule itself.
 */
function SubmoduleDiff({ file }: { file: FileChange }) {
  if (file.inside?.only) return <InsideDiff file={file} />;
  return <PointerDiff file={file} />;
}

/**
 * A submodule at the commit the project records whose own files have changes: what they are, and the way to them
 * (the submodule's tab, on Changes). Nothing is staged here: they are committed in the submodule.
 */
function InsideDiff({ file }: { file: FileChange }) {
  const t = useTheme();
  const c = file.inside!;
  const name = file.path.split('/').pop() ?? file.path;
  const isLive = live.isLiveActive();
  const open = (f?: string) => (isLive ? void live.openSubmoduleChanges(file.path, f) : toast(`Opened ${name} (mock)`, 'info'));
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 10 }} testID="submodule-inside">
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
        <Icon name="layers" size={14} color={t.info} />
        <Txt size={FONT.md} weight="600" style={{ marginLeft: 8 }}>
          Changes inside the submodule
        </Txt>
        <Txt size={FONT.sm} muted style={{ marginLeft: 8, flexShrink: 1 }} numberOfLines={1}>
          {file.path}
        </Txt>
        <View style={{ flex: 1, minWidth: 12 }} />
        <Button small primary label={`Open ${name}`} icon="layers" onPress={() => open()} testID="submodule-inside-open" />
      </View>
      <Txt size={FONT.sm} muted style={{ marginTop: 8 }}>
        {name} is at the commit this project records; its own files have changes ({insideText(c)}). They are committed in the submodule, and its new commit then shows here, to stage.
      </Txt>
      <InsideFiles inside={c} onOpen={open} title="In the submodule" />
    </View>
  );
}

/** a submodule's changed files (paths inside it); a click opens the submodule on that file */
function InsideFiles({ inside, onOpen, title }: { inside: NonNullable<FileChange['inside']>; onOpen: (file: string) => void; title: string }) {
  const t = useTheme();
  const more = inside.modified + inside.untracked - inside.files.length;
  return (
    <View style={{ marginTop: 12 }} testID="submodule-inside-files">
      <Txt label faint size={10} style={{ marginBottom: 4 }}>
        {title}
      </Txt>
      {inside.files.map((f) => (
        <PressScale key={f.path} onPress={() => onOpen(f.path)} scaleTo={1} hoverStyle={{ backgroundColor: t.hover }} style={{ flexDirection: 'row', alignItems: 'center', height: 22, paddingHorizontal: 4 }} label={`Open ${f.path} in the submodule`} testID={`submodule-inside-file-${f.path}`}>
          <Txt size={FONT.xs} mono weight="700" color={statusColor(f.status, t)} style={{ width: 16 }}>
            {f.status}
          </Txt>
          <Txt size={FONT.sm} mono numberOfLines={1} style={{ flex: 1 }}>
            {f.path}
          </Txt>
        </PressScale>
      ))}
      {more > 0 && (
        <Txt size={FONT.xs} faint style={{ marginTop: 4, paddingHorizontal: 4 }}>
          … {more} more
        </Txt>
      )}
    </View>
  );
}

function PointerDiff({ file }: { file: FileChange }) {
  const t = useTheme();
  // a working-copy change has its pointers once its diff is read (a moment after it is selected)
  const sm = file.submodule ?? NO_POINTERS;
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
      {/* and edits in its own files, not part of the pointer: they are committed in the submodule */}
      {file.inside && <InsideFiles inside={file.inside} onOpen={(f) => (isLive ? void live.openSubmoduleChanges(file.path, f) : toast(`Opened ${name} (mock)`, 'info'))} title={`Not committed in the submodule (${insideText(file.inside)}): not part of this change`} />}
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

/** git blames lines that are not committed yet on an all-zero commit id ("Not Committed Yet") */
const UNCOMMITTED = /^0+$/;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
/** "4 lines · 2 authors · 1 not committed yet" (lines not committed have no author) */
function blameCounts(lines: number, authors: number, uncommitted: number) {
  return [plural(lines, 'line'), authors ? plural(authors, 'author') : '', uncommitted ? `${uncommitted} not committed yet` : ''].filter(Boolean).join(' · ');
}

function BlameView() {
  const t = useTheme();
  const repo = useRepo();
  const b = repo.blame!;
  const authors = useMemo(() => Array.from(new Set(b.lines.filter((l) => !UNCOMMITTED.test(l.sha)).map((l) => l.author))), [b.lines]);
  return (
    <View style={{ flex: 1, backgroundColor: t.panel }} testID="blame-view">
      <View style={[styles.header, { borderColor: t.border, backgroundColor: t.panelAlt }]}>
        <Txt label muted>
          blame
        </Txt>
        <Txt size={FONT.sm} mono style={{ marginLeft: 8, flex: 1 }} numberOfLines={1}>
          {b.path}
        </Txt>
        <Txt size={FONT.xs} faint style={{ marginRight: 10 }} testID="blame-counts">
          {b.loading ? 'loading…' : blameCounts(b.lines.length, authors.length, b.lines.filter((l) => UNCOMMITTED.test(l.sha)).length)}
        </Txt>
        <Button small label="Close" icon="x" onPress={live.closeBlame} testID="blame-close" />
      </View>
      <ScrollView>
        {b.lines.length === 0 && (
          <Txt faint style={{ padding: 12 }}>
            {b.loading ? 'loading…' : 'The file is empty.'}
          </Txt>
        )}
        {b.lines.map((l, i) => {
          const prev = b.lines[i - 1];
          const same = prev && prev.sha === l.sha;
          const mine = UNCOMMITTED.test(l.sha);
          const color = mine ? t.warn : t.lanes[authors.indexOf(l.author) % t.lanes.length];
          // a line's commit: selected and scrolled to in the history (read from git when it is deep); a line not
          // committed yet: Changes (it used to "select" a commit that does not exist)
          const go = () => {
            live.closeBlame();
            if (mine) setSection('changes');
            else revealCommit(l.sha);
          };
          return (
            <View key={i} style={[styles.line, { backgroundColor: same ? 'transparent' : t.hover }]} testID={`blame-line-${i + 1}`}>
              <PressScale onPress={go} style={{ width: 230, flexDirection: 'row', alignItems: 'center', opacity: same ? 0.35 : 1 }} label={mine ? 'Not committed yet: open Changes' : `Go to ${l.sha.slice(0, 7)}`}>
                <View style={{ width: 3, height: 14, backgroundColor: color, marginRight: 6 }} />
                <Txt size={FONT.xs} mono color={mine ? t.warn : t.info} style={{ width: 62 }}>
                  {mine ? 'not yet' : l.sha.slice(0, 7)}
                </Txt>
                <Txt size={FONT.xs} muted numberOfLines={1} style={{ width: 96 }}>
                  {mine ? 'uncommitted' : l.author}
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

function TextDiff({ hunks, path, editable, isUnstaged, onExpand }: { hunks: Hunk[]; path: string; editable: boolean; isUnstaged: boolean; onExpand?: () => void }) {
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
              <PressScale onPress={() => toggleHunk(h.id)} scaleTo={1} outerStyle={{ flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center' }} style={{ flexDirection: 'row', alignItems: 'center', marginRight: 8 }} label={collapsed ? 'Unfold the hunk' : 'Fold the hunk'} testID="hunk-toggle">
                <Chevron open={!collapsed} color={t.info} />
                <Txt size={FONT.xs} mono color={t.info} style={{ marginLeft: 6 }} numberOfLines={1}>
                  {h.header}
                </Txt>
              </PressScale>
              {editable && (
                <View style={{ flexDirection: 'row' }}>
                  {n > 0 ? (
                    <>
                      <Button small label="Clear" onPress={clear} testID="clear-lines" />
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
                      <Button small label="Discard hunk" onPress={() => discardHunk(path, h.id)} testID="discard-hunk" />
                      <Button small label="Stage hunk" style={{ marginLeft: 6 }} onPress={() => stageHunk(path, h.id)} testID="stage-hunk" />
                    </>
                  ) : (
                    <Button small label="Unstage hunk" onPress={() => unstageHunk(path, h.id)} testID="unstage-hunk" />
                  )}
                </View>
              )}
            </View>
            {!collapsed &&
              (repo.diffMode === 'split' ? (
                <View testID="diff-split">
                  <SplitHunk hunk={h} lang={lang} picked={mine} onLine={editable ? (li, shift) => onLine(h, li, shift) : undefined} />
                </View>
              ) : (
                <View testID="diff-unified">
                  <UnifiedHunk hunk={h} lang={lang} picked={mine} onLine={editable ? (li, shift) => onLine(h, li, shift) : undefined} />
                </View>
              ))}
          </FadeIn>
        );
      })}
      {/* "Expand context ±10" was a label that looked like a button and did nothing: now it reads more */}
      {onExpand && (
        <PressScale onPress={onExpand} scaleTo={1} style={[styles.hunkHeader, { backgroundColor: t.panelAlt, borderColor: t.border, justifyContent: 'center' }]} hoverStyle={{ backgroundColor: t.hover }} testID="expand-context" label="Expand context ±10">
          <Icon name="chevronDown" size={11} color={t.info} />
          <Txt size={FONT.xs} color={t.info} style={{ marginLeft: 6 }}>
            Expand context ±10
          </Txt>
        </PressScale>
      )}
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

function ConflictCol({ title, lines, color, action, lang, testID }: { title: string; lines: string[]; color: string; action?: () => void; lang: Lang; testID?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.conflictCol, { borderColor: t.border }]} testID={testID}>
      <View style={[styles.conflictHead, { backgroundColor: color + '22', borderColor: t.border }]}>
        <Txt size={FONT.xs} weight="700" color={color}>
          {title}
        </Txt>
        <View style={{ flex: 1 }} />
        {action && <Button small label="Take" onPress={action} />}
      </View>
      {/* the conflicting regions only ("⋯" between two), so no line numbers of the file */}
      {lines.length === 0 ? (
        <Txt size={FONT.xs} faint style={{ padding: 8 }}>
          (nothing here)
        </Txt>
      ) : (
        lines.map((l, i) =>
          l === '⋯' ? (
            <Txt key={i} size={FONT.xs} faint style={{ textAlign: 'center', paddingVertical: 2 }}>
              ⋯
            </Txt>
          ) : (
            <View key={i} style={[styles.line, { paddingLeft: 8 }]}>
              <Code text={l} lang={lang} />
            </View>
          ),
        )
      )}
    </View>
  );
}

/**
 * A conflicted file: what each side has where they conflict, a side to take (or both), or — after editing the file
 * by hand — Mark resolved. A file one side deleted, or a binary one, only offers the sides.
 */
function ConflictView({ file }: { file: FileChange }) {
  const t = useTheme();
  const c = file.conflict!;
  const text = !c.deleted && !c.binary;
  const what =
    c.deleted === 'theirs'
      ? 'Conflict: they deleted this file, you changed it. Keep yours (Use ours), delete it (Use theirs), or edit it and mark it resolved.'
      : c.deleted === 'ours'
        ? 'Conflict: you deleted this file, they changed it. Delete it (Use ours), keep theirs (Use theirs), or edit it and mark it resolved.'
        : c.binary
          ? 'Conflict in a binary file: take one side, or put the right version in place and mark it resolved.'
          : 'Merge conflict. Choose a side, keep both, or edit the file and mark it resolved.';
  return (
    <View style={{ padding: 12 }} testID="conflict-view">
      <View style={[styles.notice, { borderColor: t.warn + '66', backgroundColor: t.warn + '14', marginBottom: 12, flexWrap: 'wrap' }]}>
        <Icon name="warning" size={18} color={t.warn} />
        <Txt style={{ marginLeft: 10, flex: 1, minWidth: 220 }}>{what}</Txt>
        <View style={{ flexDirection: 'row', marginLeft: 10, marginVertical: 2 }}>
          <Button small label="Use ours" onPress={() => resolveConflict(file.path, 'ours')} testID="conflict-ours" />
          <Button small label="Use theirs" style={{ marginLeft: 6 }} onPress={() => resolveConflict(file.path, 'theirs')} testID="conflict-theirs" />
          {text && <Button small label="Both" style={{ marginLeft: 6 }} onPress={() => resolveConflict(file.path, 'both')} testID="conflict-both" />}
          <Button small primary label="Mark resolved" style={{ marginLeft: 6 }} onPress={() => markResolved(file.path)} testID="conflict-resolved" />
        </View>
      </View>
      {text && (
        <View style={{ flexDirection: 'row' }}>
          <ConflictCol lang={langOf(file.path)} title="OURS (HEAD)" lines={c.ours} color={t.accent} action={() => resolveConflict(file.path, 'ours')} testID="conflict-col-ours" />
          <View style={{ width: 8 }} />
          <ConflictCol lang={langOf(file.path)} title="BASE" lines={c.base} color={t.textMuted} testID="conflict-col-base" />
          <View style={{ width: 8 }} />
          <ConflictCol lang={langOf(file.path)} title="THEIRS" lines={c.theirs} color={t.add} action={() => resolveConflict(file.path, 'theirs')} testID="conflict-col-theirs" />
        </View>
      )}
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
