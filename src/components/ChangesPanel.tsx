import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  commit,
  COMMIT_BOX_MIN,
  discardAll,
  findHunk,
  selectFile,
  clickFileSelection,
  clickFolderSelection,
  setCommitAction,
  setCommitDescription,
  setCommitMessage,
  setFileView,
  setLayout,
  showContextMenu,
  stageAll,
  toast,
  toggleAmend,
  toggleCommitDesc,
  unstageAll,
  useRepo,
  useStore,
} from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Button, Checkbox, Chevron, IconButton, Input, PressScale, SectionHeader, Segmented, Splitter, Txt } from '../ui/primitives';
import { DiffView } from './DiffView';
import * as live from '../state/live';
import { FileList } from './FileList';

export function ChangesPanel() {
  const t = useTheme();
  const repo = useRepo();
  const filesW = useStore((s) => s.layout.files);
  const { file } = findHunk(repo);
  const conflicts = repo.unstaged.filter((f) => f.status === 'U').length;
  const op = repo.opKind && repo.opKind !== 'none' ? repo.opKind : null;
  const descOpen = useStore((s) => s.commitDescOpen);
  const boxH = useStore((s) => s.layout.commitBox);

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: t.panel }}>
      <View style={{ width: filesW, borderRightWidth: 0 }}>
        {conflicts > 0 && (
          <View style={[styles.conflictBar, { backgroundColor: t.warn + '22', borderColor: t.warn + '55' }]} testID="conflict-bar">
            <Icon name="warning" size={14} color={t.warn} />
            <Txt size={FONT.sm} style={{ marginLeft: 8, flex: 1 }} numberOfLines={1}>
              {conflicts} conflicted file{conflicts > 1 ? 's' : ''}
            </Txt>
            {/* what stopped on the conflicts goes back; conflicts left by a stash apply have nothing to abort */}
            {(op || !repo.live) && <Button small label={`Abort ${op ?? 'merge'}`} onPress={() => (repo.live ? (op === 'rebase' ? live.rebaseAbort() : live.mergeAbort()) : toast('Merge aborted (mock)', 'info'))} testID="conflict-abort" />}
          </View>
        )}
        <SectionHeader
          title="Unstaged"
          count={repo.unstaged.length}
          right={
            <>
              <Segmented value={repo.fileView} onChange={setFileView} options={[{ value: 'list', icon: 'list' }, { value: 'tree', icon: 'tree' }]} />
              <View style={{ width: 6 }} />
              <IconButton icon="undo" size={13} title="Discard all" onPress={discardAll} disabled={repo.unstaged.length === 0} />
              <IconButton icon="plus" size={14} title="Stage all" onPress={stageAll} disabled={repo.unstaged.length === 0} />
            </>
          }
        />
        <View style={{ flex: Math.max(1, Math.min(4, repo.unstaged.length)) }}>
          <FileList
            files={repo.unstaged}
            area="unstaged"
            selected={repo.selectedArea === 'unstaged' ? repo.selectedFile : null}
            onSelect={(p) => selectFile('unstaged', p)}
            filterable={false}
            compact
            picked={repo.selectedArea === 'unstaged' ? repo.fileSelection : undefined}
            onPick={(p, m, order) => clickFileSelection('unstaged', p, m, order)}
            onPickFolder={(inside, m, order) => clickFolderSelection('unstaged', inside, m, order)}
          />
        </View>
        <SectionHeader title="Staged" count={repo.staged.length} right={<IconButton icon="minus" size={14} title="Unstage all" onPress={unstageAll} disabled={repo.staged.length === 0} />} />
        <View style={{ flex: Math.max(1, Math.min(4, repo.staged.length)) }}>
          <FileList
            files={repo.staged}
            area="staged"
            selected={repo.selectedArea === 'staged' ? repo.selectedFile : null}
            onSelect={(p) => selectFile('staged', p)}
            filterable={false}
            compact
            picked={repo.selectedArea === 'staged' ? repo.fileSelection : undefined}
            onPick={(p, m, order) => clickFileSelection('staged', p, m, order)}
            onPickFolder={(inside, m, order) => clickFolderSelection('staged', inside, m, order)}
          />
        </View>
      </View>
      <Splitter orientation="vertical" onDelta={(d) => setLayout({ files: Math.max(240, Math.min(600, filesW + d)) })} />
      {/* Fork's layout: the diff above, the commit message under it */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <DiffView file={file} editable={repo.selectedArea === 'unstaged' || repo.selectedArea === 'staged'} area={repo.selectedArea} />
        {descOpen && <Splitter orientation="horizontal" testID="commit-box-splitter" onDelta={(d) => setLayout({ commitBox: Math.max(COMMIT_BOX_MIN, Math.min(640, boxH - d)) })} />}
        <CommitBox />
      </View>
    </View>
  );
}

function CommitBox() {
  const t = useTheme();
  const repo = useRepo();
  // the repository's own commit.gpgsign (a global Prong setting used to show here while git signed per repository)
  const mockSign = useStore((s) => s.serverSettings?.signCommits ?? false);
  const [signed, setSigned] = useState<{ id: string; on: boolean } | null>(null);
  useEffect(() => {
    let gone = false;
    if (repo.live) void live.readSignCommits().then((on) => !gone && setSigned({ id: repo.id, on }));
    return () => {
      gone = true;
    };
  }, [repo.live, repo.id]);
  const sign = repo.live ? (signed?.id === repo.id ? signed.on : false) : mockSign;
  const toggleSign = (v: boolean) => {
    if (!repo.live) return toast('Signing uses the key from Preferences → SSH (mock)', 'info');
    const id = repo.id;
    setSigned({ id, on: v });
    // not set (an error, said by the error dialog): the box shows what git has
    void live.setSignCommits(v).then((ok) => {
      if (!ok) void live.readSignCommits().then((on) => setSigned({ id, on }));
    });
  };
  const action = useStore((s) => s.commitAction);
  const current = repo.refs.find((r) => r.kind === 'branch' && r.current);
  const summaryLen = repo.commitMessage.length;
  // a merge whose conflicts all went to our side stages nothing, and still is committed (git makes the merge commit)
  const canCommit = repo.commitMessage.trim().length > 0 && (repo.staged.length > 0 || repo.amend || repo.opKind === 'merge');
  // the name git will put on the commit: the repository's own identity when it has one (it said the global name)
  const [identity, setIdentity] = useState<{ id: string; name: string; email: string } | null>(null);
  useEffect(() => {
    let gone = false;
    if (repo.live) void live.readCommitIdentity().then((i) => !gone && setIdentity({ id: repo.id, ...i }));
    return () => {
      gone = true;
    };
  }, [repo.live, repo.id]);
  const as = identity?.id === repo.id ? identity : null;
  const push = action === 'commit-push';
  const label = `${repo.amend ? 'Amend' : 'Commit'}${push ? ' & Push' : ''}`;
  const descOpen = useStore((s) => s.commitDescOpen);
  const boxH = useStore((s) => s.layout.commitBox);
  return (
    // with the description unfolded the box has the height the splitter above gives it; folded, it is compact
    <View style={[styles.commitBox, { borderColor: t.border, backgroundColor: t.panelAlt }, descOpen && { height: boxH }]} testID="commit-box">
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Input value={repo.commitMessage} onChange={setCommitMessage} placeholder="Commit summary" style={{ flex: 1 }} onSubmit={() => canCommit && commit(push)} testID="commit-summary" />
        <Txt size={FONT.xs} color={summaryLen > 72 ? t.del : summaryLen > 50 ? t.warn : t.textFaint} mono style={{ marginLeft: 8, width: 28, textAlign: 'right' }} testID="commit-counter">
          {summaryLen}
        </Txt>
        <PressScale onPress={toggleCommitDesc} scaleTo={0.9} style={styles.fold} hoverStyle={{ backgroundColor: t.hover }} label={descOpen ? 'Hide the description' : 'Show the description'} testID="toggle-commit-desc">
          <Chevron open={descOpen} color={repo.commitDescription.trim() && !descOpen ? t.accent : t.textMuted} />
        </PressScale>
      </View>
      {descOpen ? (
        <Input value={repo.commitDescription} onChange={setCommitDescription} placeholder="Description (optional)" multiline fill style={{ marginTop: 6, flex: 1, minHeight: 32, alignItems: 'stretch' }} testID="commit-description-input" />
      ) : repo.commitDescription.trim() ? (
        <Txt size={FONT.xs} faint numberOfLines={1} style={{ marginTop: 4 }}>
          description: {repo.commitDescription.trim().split('\n')[0]}
        </Txt>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <Checkbox checked={repo.amend} onChange={toggleAmend} label="Amend" testID="commit-amend" />
        <View style={{ width: 14 }} />
        <Checkbox checked={sign} onChange={toggleSign} label="Sign" testID="commit-sign" />
        <Txt size={FONT.xs} faint style={{ marginLeft: 14, flexShrink: 1 }} numberOfLines={1} testID="commit-target">
          to <Txt size={FONT.xs} color={t.accent}>{current?.name ?? 'HEAD'}</Txt>
          {as?.name ? ` as ${as.name}` : ''} · ⌘⏎
        </Txt>
        <View style={{ flex: 1 }} />
        <Button label={label} primary disabled={!canCommit} onPress={() => commit(push)} icon={push ? 'push' : 'check'} testID="commit-button" />
        <PressScale
          testID="commit-menu"
          label="Choose: commit, or commit and push"
          scaleTo={0.94}
          style={[styles.split, { backgroundColor: t.accentSoft }]}
          hoverStyle={{ backgroundColor: t.hover }}
          onPressAt={(a) =>
            showContextMenu(a.x + a.w - 220, a.y - 70, [
              { label: `${push ? '   ' : '✓  '}Commit`, onPress: () => setCommitAction('commit') },
              { label: `${push ? '✓  ' : '   '}Commit and push`, onPress: () => setCommitAction('commit-push') },
            ])
          }
        >
          <Icon name="chevronDown" size={12} color={t.accent} />
        </PressScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  commitBox: { borderTopWidth: 1, padding: 10 },
  // the commit button's menu: its fill only, no outline
  split: { height: 28, width: 24, marginLeft: 2, alignItems: 'center', justifyContent: 'center' },
  fold: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  conflictBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, height: 32, borderBottomWidth: 1 },
});
