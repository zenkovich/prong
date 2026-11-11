import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { FileChange, SubmoduleInside } from '../git/types';
import * as live from '../state/live';
import { closeDialog, useRepo } from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Modal, useModalResized } from '../ui/overlays';
import { Button, Checkbox, Chevron, Row, Segmented, Txt, useKeyboard } from '../ui/primitives';
import { FileIcon, FolderIcon } from '../ui/FileIcon';
import { rowTop, useVirtualWindow } from '../ui/virtual';
import { buildTree, flatten, rowKey, type TreeNode } from './fileTree';
import { insideText, statusColor } from './FileList';

/** a submodule's own files are named up to this many in its block; the rest are counted */
const INSIDE_SHOWN = 12;
const ROW = 22;
const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;
/** an untracked folder comes as one entry ("sdk/AiHelp/"): its name keeps the slash */
const split = (p: string) => {
  const folder = p.endsWith('/');
  const bare = p.replace(/\/+$/, '');
  const cut = bare.lastIndexOf('/') + 1;
  return { dir: bare.slice(0, cut), name: bare.slice(cut) + (folder ? '/' : ''), folder };
};
const missing = (path: string): FileChange => ({ path, status: '?', kind: 'text', additions: 0, deletions: 0 });
/** a submodule discarded by going back to the commit recorded here: its own files are left where they are */
const movesBack = (f: FileChange) => !f.inside?.only && !!f.submodule && f.submodule.before !== f.submodule.after;

/**
 * Discard asking first: what it drops, file by file, as the list or the tree of the Changes panel (the same icons,
 * status letters and folders), and a block per submodule saying what happens inside it — with the tick that drops
 * what is staged in it as well (on by default; without it git keeps the staged version). Dragged bigger by its
 * corner, the list of files takes every pixel the window gained.
 */
export function DiscardDialog({ title, note, confirmLabel, paths, what, onConfirm }: {
  title: string;
  note: string;
  confirmLabel?: string;
  paths: string[];
  what?: string;
  onConfirm: (opts: { staged: boolean }) => void;
}) {
  const t = useTheme();
  const [staged, setStaged] = useState(true);

  const go = () => {
    closeDialog();
    onConfirm({ staged });
  };
  // Enter answers with the dialog's button, as every confirmation does (Escape cancels: the Modal's)
  useKeyboard((e) => {
    if (e.key === 'Enter' && !e.meta && !e.shift && !e.consumed) {
      e.preventDefault();
      e.consume();
      go();
    }
  });
  return (
    <Modal
      title={title}
      width={560}
      fill
      icon={<Icon name="warning" size={16} color={t.warn} />}
      testID="discard-dialog"
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} testID="confirm-cancel" />
          <Button label={confirmLabel ?? 'Discard'} danger style={{ marginLeft: 8 }} onPress={go} testID="confirm-ok" />
        </>
      }
    >
      {/* the body is its own component: only inside the Modal does it see whether the window was dragged bigger */}
      <DiscardBody note={note} paths={paths} what={what} staged={staged} onStaged={setStaged} />
    </Modal>
  );
}

/** what the discard drops, filling the window: the files (list or tree) and a block per submodule */
function DiscardBody({ note, paths, what, staged, onStaged }: {
  note: string;
  paths: string[];
  what?: string;
  staged: boolean;
  onStaged: (v: boolean) => void;
}) {
  const t = useTheme();
  const repo = useRepo();
  const resized = useModalResized();
  const [view, setView] = useState<'list' | 'tree'>(repo.fileView);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const files = useMemo(() => {
    const by = new Map(repo.unstaged.map((f) => [f.path, f]));
    return paths.map((p) => by.get(p) ?? by.get(p.replace(/\/+$/, '')) ?? missing(p));
  }, [paths, repo.unstaged]);
  // the submodules get their own block (what goes inside them), the rest the list
  const subs = useMemo(() => files.filter((f) => f.kind === 'submodule'), [files]);
  const plain = useMemo(() => files.filter((f) => f.kind !== 'submodule'), [files]);
  // how many of the submodules' own changes are staged in them: only then is the tick worth showing (one moving back
  // to its recorded commit keeps its own changes, staged or not)
  const stagedInside = subs.reduce((n, f) => n + (movesBack(f) ? 0 : f.inside?.staged ?? 0), 0);
  const counts = useMemo(() => {
    let changed = 0;
    let added = 0;
    let deleted = 0;
    for (const f of plain) {
      if (f.status === '?' || f.status === 'A') added++;
      else if (f.status === 'D') deleted++;
      else changed++;
    }
    const n = (x: number) => x.toLocaleString('en-US');
    return [changed ? `${n(changed)} changed` : '', added ? `${n(added)} new` : '', deleted ? `${n(deleted)} deleted` : ''].filter(Boolean).join(' · ');
  }, [plain]);

  const tree = useMemo(() => (view === 'tree' ? buildTree(plain) : null), [view, plain]);
  const rows = useMemo(() => (tree ? flatten(tree, 'discard', collapsed) : null), [tree, collapsed]);
  // the files under each folder, for its count
  const under = useMemo(() => {
    const m = new Map<string, number>();
    const walk = (n: TreeNode): number => {
      if (n.file) return 1;
      const inside = n.children.reduce((s, c) => s + walk(c), 0);
      m.set(n.path, inside);
      return inside;
    };
    if (tree) for (const n of tree) walk(n);
    return m;
  }, [tree]);
  const count = rows ? rows.length : plain.length;
  const win = useVirtualWindow(count, ROW, { overscan: 20 });

  return (
      <View style={{ flex: resized ? 1 : undefined, flexShrink: 1, minHeight: 0 }}>
        <Txt muted testID="confirm-message">
          {note}
        </Txt>
        {/* one file and nothing else: the line above already names it, so the list of one row is left out */}
        {plain.length > (subs.length ? 0 : 1) && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
              <Txt size={FONT.sm} style={{ flex: 1 }} numberOfLines={1} testID="discard-summary">
                {plural(plain.length, 'file')}
                {counts ? ` · ${counts}` : ''}
                {what ? ` in ${what}` : ''}
              </Txt>
              <Segmented value={view} onChange={setView} options={[{ value: 'list', icon: 'list' }, { value: 'tree', icon: 'tree' }]} />
            </View>
            <ScrollView
              style={[
                { marginTop: 4, borderWidth: 1, borderColor: t.border, backgroundColor: t.bg },
                // the window dragged bigger: the list fills what the blocks below it leave, instead of staying 260 tall
                resized ? { flex: 1, minHeight: 60 } : { maxHeight: 260 },
              ]}
              onScroll={win.onScroll}
              onLayout={win.onLayout}
              scrollEventThrottle={16}
              testID="discard-files"
            >
              <View style={{ height: count * ROW }}>
                {rows
                  ? rows.slice(win.first, win.last).map((r, k) => (
                      <View key={rowKey(r)} style={rowTop(win.first + k, ROW)}>
                        {r.node.file ? (
                          <FileLine file={r.node.file} indent={r.depth * 14} nameOnly />
                        ) : (
                          <Row
                            height={ROW}
                            indent={r.depth * 14}
                            onPress={() => setCollapsed((c) => ({ ...c, [`tree:discard:${r.node.path}`]: r.open }))}
                            testID={`discard-folder-${r.node.path}`}
                          >
                            <Chevron open={r.open} color={t.textMuted} />
                            <FolderIcon name={r.node.name} open={r.open} />
                            <Txt size={FONT.sm} muted style={{ marginLeft: 5, flex: 1 }} numberOfLines={1}>
                              {r.node.name}
                            </Txt>
                            <Txt size={FONT.xs} mono faint>
                              {under.get(r.node.path) ?? 0}
                            </Txt>
                          </Row>
                        )}
                      </View>
                    ))
                  : plain.slice(win.first, win.last).map((f, k) => (
                      <View key={f.path} style={rowTop(win.first + k, ROW)}>
                        <FileLine file={f} />
                      </View>
                    ))}
              </View>
            </ScrollView>
          </>
        )}
        {subs.length > 0 && (
          <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ flexGrow: 0 }}>
            {subs.map((f) => (
              <SubmoduleBlock key={f.path} file={f} staged={staged} />
            ))}
          </ScrollView>
        )}
        {stagedInside > 0 && (
          <View style={{ marginTop: 8 }}>
            <Checkbox checked={staged} onChange={onStaged} label={`Discard what is staged inside too (${plural(stagedInside, 'file')})`} testID="discard-staged" />
            <Txt size={FONT.xs} faint style={{ marginLeft: 23 }}>
              {staged ? 'The submodule goes back to its commit, index and all (Undo puts both back).' : 'git keeps the staged version: those files stay as they are staged in the submodule.'}
            </Txt>
          </View>
        )}
      </View>
  );
}

/** one file of the list: status letter, its icon, name (the folder faint after it in the flat list) */
function FileLine({ file, indent = 0, nameOnly }: { file: FileChange; indent?: number; nameOnly?: boolean }) {
  const t = useTheme();
  const { dir, name, folder } = split(file.path);
  return (
    <Row height={ROW} indent={indent} testID={`discard-file-${file.path}`}>
      <Txt size={FONT.xs} mono weight="700" color={statusColor(file.status, t)} style={{ width: 14 }}>
        {file.status}
      </Txt>
      {folder ? <FolderIcon name={name.replace(/\/$/, '')} open={false} /> : <FileIcon name={file.path} />}
      <View style={{ flexDirection: 'row', flex: 1, marginLeft: 6, overflow: 'hidden', alignItems: 'center' }}>
        <Txt size={FONT.sm} numberOfLines={1}>
          {name}
        </Txt>
        {!nameOnly && dir ? (
          <Txt size={FONT.xs} faint numberOfLines={1} style={{ marginLeft: 6, flexShrink: 1 }}>
            {dir.replace(/\/$/, '')}
          </Txt>
        ) : null}
      </View>
    </Row>
  );
}

/**
 * A submodule among the discarded paths: what happens to it in words (the engine does exactly that), and the files
 * of its own that go — the ones staged in it marked, and said to stay when the tick is off.
 */
function SubmoduleBlock({ file, staged }: { file: FileChange; staged: boolean }) {
  const t = useTheme();
  const text = live.submoduleDiscardText(file.path);
  const inside: SubmoduleInside | undefined = file.inside && file.inside.modified + file.inside.untracked > 0 ? file.inside : undefined;
  // its commit goes back: its own files are left where they are, so they are not listed as dropped
  const moves = !file.inside?.only && !!file.submodule && file.submodule.before !== file.submodule.after;
  const listed = inside && !moves ? inside.files.slice(0, INSIDE_SHOWN) : [];
  const more = inside && !moves ? inside.modified + inside.untracked - listed.length : 0;
  return (
    <View style={{ marginTop: 10 }} testID={`discard-submodule-${file.path}`}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        <Icon name="layers" size={13} color={t.info} />
        <Txt size={FONT.sm} muted style={{ marginLeft: 7, flex: 1 }}>
          {text ?? `${file.path} is discarded.`}
        </Txt>
      </View>
      {inside && !moves ? (
        <View style={{ marginTop: 4, borderWidth: 1, borderColor: t.border, backgroundColor: t.bg }}>
          {listed.map((f) => (
            <Row key={f.path} height={ROW} testID={`discard-inside-${file.path}/${f.path}`}>
              <Txt size={FONT.xs} mono weight="700" color={statusColor(f.status, t)} style={{ width: 14 }}>
                {f.status}
              </Txt>
              <FileIcon name={f.path} />
              <Txt size={FONT.sm} style={{ marginLeft: 6, flex: 1 }} numberOfLines={1} faint={!!f.staged && !staged}>
                {f.path}
              </Txt>
              {f.staged ? (
                <Txt size={FONT.xs} faint mono>
                  {staged ? 'staged' : 'staged · stays'}
                </Txt>
              ) : null}
            </Row>
          ))}
          {more > 0 && (
            <Row height={ROW}>
              <Txt size={FONT.xs} faint style={{ marginLeft: 14 }}>
                … {plural(more, 'file')} more
              </Txt>
            </Row>
          )}
        </View>
      ) : inside && moves ? (
        <Txt size={FONT.xs} faint style={{ marginLeft: 20, marginTop: 2 }}>
          {insideText(inside)} of its own stay in its working copy
        </Txt>
      ) : null}
    </View>
  );
}
