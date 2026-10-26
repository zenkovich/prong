import type { Ref } from '../git/types';

/**
 * Ref labels on a commit row, Fork-style: a local branch and the remote branch it tracks (or its
 * same-named origin twin) on the same commit become one label with a cloud mark; remote-only branches
 * keep their own label with the cloud; tags last. The current branch comes first.
 */
export interface RefLabel {
  ref: Ref;
  /** shown text */
  name: string;
  /** a remote branch is on this commit: the local label carries it, or the label is the remote itself */
  remote: boolean;
  /** remote branch without a local label on this commit */
  remoteOnly: boolean;
}

export function refLabels(refs: Ref[]): RefLabel[] {
  const locals = refs.filter((r) => r.kind === 'branch');
  const remotes = refs.filter((r) => r.kind === 'remote' && !r.name.endsWith('/HEAD'));
  const tags = refs.filter((r) => r.kind === 'tag');
  const absorbed = new Set<string>();
  const out: RefLabel[] = [];
  for (const l of [...locals].sort((a, b) => Number(!!b.current) - Number(!!a.current))) {
    const twin = remotes.find((r) => r.name === l.upstream) ?? remotes.find((r) => r.name.slice(r.name.indexOf('/') + 1) === l.name);
    if (twin) absorbed.add(twin.name);
    out.push({ ref: l, name: l.name, remote: !!twin, remoteOnly: false });
  }
  for (const r of remotes) if (!absorbed.has(r.name)) out.push({ ref: r, name: r.name, remote: true, remoteOnly: true });
  for (const t of tags) out.push({ ref: t, name: t.name, remote: false, remoteOnly: false });
  return out;
}
