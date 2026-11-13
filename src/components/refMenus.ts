import { Ref } from '../git/types';
import * as live from '../state/live';
import { checkout, clearBranchFilter, deleteBranch, deleteTag, getState, MenuItem, openDialog, pullBranch, pushBranch, showOnlyRef, syncBranch, toast, toggleBranchFilter } from '../state/store';
import { inFilter } from './branchFilter';
import { remoteTwin } from './branchNames';

/**
 * The menu of a branch or a tag: one for the branch list on the left and for the branch labels on the commit rows,
 * so a right-click does the same wherever the branch is. Read at the moment the menu opens (the current branch,
 * the filter), not on every render.
 */
export function refMenu(r: Ref): MenuItem[] {
  if (r.kind === 'tag') return tagMenu(r);
  return branchMenu(r, r.kind === 'remote' ? 'remote' : 'branch');
}

export function branchMenu(r: Ref, kind: 'branch' | 'remote'): MenuItem[] {
  const repo = getState().repoStates[getState().activeTab ?? ''];
  const current = repo?.refs.find((x) => x.kind === 'branch' && x.current);
  const mode = repo?.graphFilter.mode ?? 'all';
  const filtered = repo ? inFilter(repo.graphFilter, r.name) : false;
  // the remote branch “Delete (local + remote)” takes along (none: it is on no remote)
  const twin = repo && kind === 'branch' ? remoteTwin(repo.refs, repo.remotes, r) : undefined;
  const graphItems: MenuItem[] = [
    { separator: true },
    { label: 'Show only this branch', onPress: () => showOnlyRef(r.name) },
    ...(mode === 'selected' ? [{ label: filtered ? 'Remove from the filter' : 'Add to the filter', onPress: () => toggleBranchFilter(r.name) }] : []),
    ...(mode !== 'all' ? [{ label: 'Clear the branch filter', onPress: clearBranchFilter }] : []),
  ];
  if (kind === 'branch')
    return [
      { label: r.current ? 'Already checked out' : `Checkout ${r.name}`, disabled: !!r.current, onPress: () => checkout(r.name) },
      { label: `Merge ${r.name} into ${current?.name ?? 'HEAD'}`, disabled: !!r.current, onPress: () => openDialog({ type: 'merge', source: r.name }) },
      { label: `Rebase ${current?.name ?? 'HEAD'} onto ${r.name}`, disabled: !!r.current, onPress: () => openDialog({ type: 'rebase', onto: r.name }) },
      { separator: true },
      { label: r.upstream ? `Push to ${r.upstream}` : 'Push…', onPress: () => pushBranch(r.name) },
      {
        label: r.current ? 'Pull…' : r.upstream && !r.gone ? `Pull ${r.upstream} (fast-forward)` : 'Pull (it tracks no remote branch)',
        disabled: !r.current && (!r.upstream || r.gone),
        onPress: () => (r.current ? openDialog({ type: 'pull' }) : pullBranch(r.name)),
      },
      { label: r.upstream && !r.gone ? `Sync with ${r.upstream}` : 'Sync (it tracks no remote branch)', disabled: !r.upstream || r.gone, onPress: () => syncBranch(r.name) },
      { label: 'Set upstream…', onPress: () => openDialog({ type: 'upstream', branch: r.name }) },
      { separator: true },
      { label: 'Create branch here…', onPress: () => openDialog({ type: 'branch', fromSha: r.sha, fromName: r.name }) },
      { label: 'Rename…', onPress: () => openDialog({ type: 'renameBranch', name: r.name }) },
      { label: 'Copy branch name', onPress: () => live.copyText(r.name) },
      { separator: true },
      { label: 'Delete', danger: true, disabled: !!r.current, onPress: () => deleteBranch(r.name) },
      { label: twin ? `Delete (local + ${twin})` : 'Delete (local + remote): it is on no remote', danger: true, disabled: !!r.current || !twin, onPress: () => deleteBranch(r.name, true) },
      ...graphItems,
    ];
  // a remote branch checks out its local branch: the one tracking it, else the same name, else a new one (as Fork)
  const short = r.name.slice(r.name.indexOf('/') + 1);
  const local = repo?.refs.find((x) => x.kind === 'branch' && x.upstream === r.name) ?? repo?.refs.find((x) => x.kind === 'branch' && x.name === short);
  return [
    { label: local?.current ? `Already on ${local.name}` : local && local.name !== short ? `Checkout ${local.name} (tracks ${r.name})` : `Checkout ${short}`, disabled: !!local?.current, onPress: () => checkout(r.name) },
    { label: `Merge ${r.name} into ${current?.name ?? 'HEAD'}`, onPress: () => openDialog({ type: 'merge', source: r.name }) },
    { label: `Rebase ${current?.name ?? 'HEAD'} onto ${r.name}`, onPress: () => openDialog({ type: 'rebase', onto: r.name }) },
    { separator: true },
    { label: 'Create branch here…', onPress: () => openDialog({ type: 'branch', fromSha: r.sha, fromName: r.name }) },
    { label: 'Copy branch name', onPress: () => live.copyText(r.name) },
    { label: 'Delete remote branch', danger: true, onPress: () => deleteBranch(r.name) },
    ...graphItems,
  ];
}

export function tagMenu(tag: Ref): MenuItem[] {
  const isLive = live.isLiveActive();
  return [
    { label: `Checkout ${tag.name}`, onPress: () => (isLive ? live.checkoutDetached(tag.sha) : toast(`Detached HEAD at ${tag.name} (mock)`, 'info')) },
    { label: 'Push tag', onPress: () => (isLive ? live.pushTag(tag.name) : toast(`Pushed tag ${tag.name} (mock)`, 'success')) },
    { label: 'Create branch here…', onPress: () => openDialog({ type: 'branch', fromSha: tag.sha, fromName: tag.name }) },
    { label: 'Copy name', onPress: () => live.copyText(tag.name) },
    { separator: true },
    { label: 'Delete tag', danger: true, onPress: () => deleteTag(tag.name) },
  ];
}
