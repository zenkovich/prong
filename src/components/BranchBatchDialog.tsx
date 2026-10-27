import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { closeDialog, deleteBranchesBatch, useRepo } from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/overlays';
import { Button, Checkbox, Txt } from '../ui/primitives';

function NameList({ title, items }: { title: string; items: string[] }) {
  const t = useTheme();
  return (
    <View style={{ marginTop: 10 }}>
      <Txt label faint size={10} style={{ marginBottom: 4 }}>
        {title} · {items.length}
      </Txt>
      <ScrollView style={{ maxHeight: 150, borderWidth: 1, borderColor: t.border, backgroundColor: t.bg }} contentContainerStyle={{ padding: 6 }}>
        {items.map((n) => (
          <Txt key={n} size={FONT.sm} mono numberOfLines={1}>
            {n}
          </Txt>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * Deleting several branches: what goes (local and remote, listed), what stays (the current branch), whether their
 * remote branches go too, and whether unmerged ones may go (otherwise git keeps them and says so).
 */
export function DeleteBranchesDialog({ names }: { names: string[] }) {
  const t = useTheme();
  const repo = useRepo();
  const [withRemote, setWithRemote] = useState(false);
  // on by default: picking branches to delete means deleting them; untick to keep the unmerged ones
  const [force, setForce] = useState(true);
  const refs = names.map((n) => repo.refs.find((r) => r.name === n)).filter((r): r is NonNullable<typeof r> => !!r);
  const current = refs.filter((r) => r.kind === 'branch' && r.current);
  const locals = refs.filter((r) => r.kind === 'branch' && !r.current);
  const remotes = refs.filter((r) => r.kind === 'remote');
  const tracked = locals.filter((r) => r.upstream && !r.gone && !remotes.some((x) => x.name === r.upstream));
  const count = locals.length + remotes.length + (withRemote ? tracked.length : 0);
  return (
    <Modal
      title={`Delete ${locals.length + remotes.length} branch${locals.length + remotes.length === 1 ? '' : 'es'}`}
      width={520}
      icon={<Icon name="trash" size={14} color={t.del} />}
      footer={
        <>
          <Button label="Cancel" onPress={closeDialog} />
          <Button label={`Delete ${count}`} danger style={{ marginLeft: 8 }} disabled={count === 0} onPress={() => deleteBranchesBatch([...locals, ...remotes].map((r) => r.name), { force, withRemote })} testID="batch-delete-confirm" />
        </>
      }
    >
      <View testID="delete-branches-dialog">
        {locals.length > 0 && <NameList title="Local branches" items={locals.map((r) => r.name)} />}
        {remotes.length > 0 && <NameList title="Remote branches (deleted on the server)" items={remotes.map((r) => r.name)} />}
        {current.length > 0 && (
          <Txt size={FONT.sm} color={t.warn} style={{ marginTop: 8 }}>
            {current[0].name} is checked out and stays.
          </Txt>
        )}
        <View style={{ marginTop: 10 }}>
          {tracked.length > 0 && <Checkbox checked={withRemote} onChange={setWithRemote} label={`Also delete their ${tracked.length} branch${tracked.length === 1 ? '' : 'es'} on the remote`} testID="batch-with-remote" />}
          {locals.length > 0 && <Checkbox checked={force} onChange={setForce} label="Also unmerged ones (commits that are only on them become unreachable)" testID="batch-force" />}
        </View>
      </View>
    </Modal>
  );
}
