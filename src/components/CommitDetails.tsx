import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { applyStash, DETAILS_HEADER_MIN, dropStash, findCommit, findHunk, fullDate, openDialog, selectCommit, selectFile, setFileView, setLayout, shortSha, toast, toggleDetailsDesc, useRepo, useStore } from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Avatar, Button, Chevron, FadeIn, PressScale, Segmented, Splitter, Txt } from '../ui/primitives';
import { RefChip } from './CommitList';
import { refLabels } from './commitRefs';
import { DiffView } from './DiffView';
import { FileList } from './FileList';

export function CommitDetails() {
  const t = useTheme();
  const repo = useRepo();
  const filesW = useStore((s) => s.layout.files);
  const descOpen = useStore((s) => s.detailsDescOpen);
  const headerH = useStore((s) => s.layout.detailsHeader);
  const isStash = repo.selectedArea === 'stash';
  const stash = isStash ? repo.stashes.find((s) => s.index === repo.selectedStash) : null;
  const commit = !isStash ? findCommit(repo, repo.selectedCommit) : null;
  const { file } = findHunk(repo);
  const files = stash?.files ?? commit?.files ?? [];
  const refs = commit ? repo.refs.filter((r) => r.sha === commit.sha && r.name !== 'origin/HEAD') : [];

  if (!commit && !stash)
    return (
      <View style={[styles.empty, { backgroundColor: t.panel }]}>
        <Txt muted>Select a commit</Txt>
      </View>
    );

  return (
    <View style={{ flex: 1, backgroundColor: t.panel }}>
      {/* the description across the whole width, then files on the left and the diff on the right */}
      {/* folded: one line with the subject; unfolded: a block as tall as the splitter below makes it */}
      <View style={[{ borderBottomWidth: 1, borderColor: t.border }, descOpen ? { height: headerH } : null]} testID="commit-description">
        {!descOpen && (commit || stash) ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 36, height: 30 }}>
            <Txt size={FONT.md} weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
              {commit?.subject ?? stash?.message}
            </Txt>
            {commit && (
              <Txt size={FONT.xs} faint mono style={{ marginLeft: 10 }}>
                {commit.author} · {shortSha(commit.sha)}
              </Txt>
            )}
          </View>
        ) : null}
      {descOpen && (
      <FadeIn keyProp={commit?.sha ?? stash?.sha} slide={4} style={{ flex: 1 }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingLeft: 12, paddingRight: 36, paddingVertical: 10 }}>
            {commit && (
              <>
                <Txt size={FONT.lg} weight="600" selectable>
                  {commit.subject}
                </Txt>
                {commit.body ? (
                  <Txt size={FONT.sm} muted mono selectable style={{ marginTop: 6 }}>
                    {commit.body}
                  </Txt>
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
                  <Avatar name={commit.author} email={commit.email} size={22} />
                  <View style={{ marginLeft: 8, flex: 1 }}>
                    <Txt size={FONT.sm}>
                      {commit.author} <Txt size={FONT.sm} faint>{`<${commit.email}>`}</Txt>
                    </Txt>
                    <Txt size={FONT.xs} muted>
                      {fullDate(commit.date)}
                    </Txt>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <Txt size={FONT.xs} muted style={{ marginRight: 4 }}>
                    SHA
                  </Txt>
                  <PressScale onPress={() => toast('Copied', 'info', commit.sha)} scaleTo={0.97}>
                    <Txt size={FONT.xs} mono color={t.info}>
                      {commit.sha.slice(0, 12)}
                    </Txt>
                  </PressScale>
                  {commit.parents.length > 0 && (
                    <Txt size={FONT.xs} muted style={{ marginLeft: 10, marginRight: 4 }}>
                      Parent{commit.parents.length > 1 ? 's' : ''}
                    </Txt>
                  )}
                  {commit.parents.map((p) => (
                    <PressScale key={p} onPress={() => selectCommit(p)} scaleTo={0.97} style={{ marginRight: 6 }}>
                      <Txt size={FONT.xs} mono color={t.info}>
                        {shortSha(p)}
                      </Txt>
                    </PressScale>
                  ))}
                </View>
                {refs.length > 0 && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }}>
                    {refLabels(refs).map((l) => (
                      <RefChip key={l.ref.name} r={l.ref} label={l} />
                    ))}
                  </View>
                )}
              </>
            )}
            {stash && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Icon name="stash" size={16} />
                  <Txt size={FONT.lg} weight="600" style={{ marginLeft: 8, flex: 1 }}>
                    {stash.message}
                  </Txt>
                </View>
                <Txt size={FONT.xs} muted style={{ marginTop: 4 }}>
                  stash@{`{${stash.index}}`} · {fullDate(stash.date)}
                </Txt>
                <View style={{ flexDirection: 'row', marginTop: 10 }}>
                  <Button small primary label="Apply" onPress={() => applyStash(stash.index, false)} />
                  <Button small label="Pop" style={{ marginLeft: 6 }} onPress={() => applyStash(stash.index, true)} />
                  <Button small label="Drop" danger style={{ marginLeft: 6 }} onPress={() => dropStash(stash.index)} />
                  <Button small label="Branch from stash" style={{ marginLeft: 6 }} onPress={() => openDialog({ type: 'branch', fromSha: repo.head })} />
                </View>
              </>
            )}
        </ScrollView>
      </FadeIn>
      )}
        {/* last, so it paints over the scrolling description */}
        <View style={styles.foldAt}>
          <PressScale onPress={toggleDetailsDesc} scaleTo={0.9} style={styles.fold} hoverStyle={{ backgroundColor: t.hover }} label={descOpen ? 'Fold the description' : 'Unfold the description'} testID="toggle-details-desc">
            <Chevron open={descOpen} color={t.textMuted} />
          </PressScale>
        </View>
      </View>
      {descOpen && <Splitter orientation="horizontal" testID="details-header-splitter" onDelta={(d) => setLayout({ detailsHeader: Math.max(DETAILS_HEADER_MIN, Math.min(480, headerH + d)) })} />}
      <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
      <View style={{ width: filesW }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, height: 24 }}>
          <Txt label faint size={10}>
            ──
          </Txt>
          <Txt label muted style={{ marginLeft: 6 }}>
            Files
          </Txt>
          <Txt size={FONT.xs} faint style={{ marginLeft: 6 }}>
            {files.length}
          </Txt>
          <View style={{ flex: 1 }} />
          <Segmented value={repo.fileView} onChange={setFileView} options={[{ value: 'list', icon: 'list' }, { value: 'tree', icon: 'tree' }]} />
        </View>
        <FileList files={files} area={isStash ? 'stash' : 'commit'} selected={repo.selectedFile} onSelect={(p) => selectFile(isStash ? 'stash' : 'commit', p)} filterable={files.length > 6} />
      </View>
      <Splitter orientation="vertical" onDelta={(d) => setLayout({ files: Math.max(220, Math.min(600, filesW + d)) })} />
      <DiffView file={file} editable={false} area={isStash ? 'stash' : 'commit'} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // the press target keeps its own box (PressScale puts the style on its inner view)
  foldAt: { position: 'absolute', right: 8, top: 4, zIndex: 2 },
  fold: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
});
