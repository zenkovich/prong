import type { Ref } from '../git/types';
import { refNameProblem } from './refName';

/**
 * Why git would refuse `name` as a branch name (`git check-ref-format --branch`), or null when it takes it.
 * Every reason starts with “Not a valid branch name”. The rules are refName.ts's, shared with the new-branch and
 * tag dialogs.
 */
export function branchNameProblem(name: string): string | null {
  const why = name ? refNameProblem(name) : 'type one';
  return why ? `Not a valid branch name: ${why}` : null;
}

/**
 * The branch on a remote that “Delete (local + remote)” deletes too: the branch's upstream when the remote still has
 * it, else the same name on origin (or the first remote) when that exists; undefined when there is none.
 */
export function remoteTwin(refs: Ref[], remotes: { name: string }[], b: Ref): string | undefined {
  const isRemote = (n: string) => refs.some((x) => x.kind === 'remote' && x.name === n);
  if (b.upstream && !b.gone && isRemote(b.upstream)) return b.upstream;
  const rm = remotes.find((x) => x.name === 'origin') ?? remotes[0];
  const same = rm ? `${rm.name}/${b.name}` : '';
  return same && isRemote(same) ? same : undefined;
}

/** remoteTwin of every local branch at once (one pass: a repository can have thousands), by branch name */
export function remoteTwins(refs: Ref[], remotes: { name: string }[]): Map<string, string> {
  const remote = new Set<string>();
  for (const x of refs) if (x.kind === 'remote') remote.add(x.name);
  const rm = remotes.find((x) => x.name === 'origin') ?? remotes[0];
  const out = new Map<string, string>();
  for (const b of refs) {
    if (b.kind !== 'branch') continue;
    const twin = b.upstream && !b.gone && remote.has(b.upstream) ? b.upstream : rm && remote.has(`${rm.name}/${b.name}`) ? `${rm.name}/${b.name}` : undefined;
    if (twin) out.set(b.name, twin);
  }
  return out;
}

/**
 * The repository's main branch, pinned at the top of the sidebar: the branch origin/HEAD points to (the remote's
 * default), else main or master. Its local branch (the same name, else one tracking it) and its remote branch,
 * either of which may be missing; null when there is neither.
 */
export function mainBranch(refs: Ref[], remotes: { name: string }[]): { name: string; local?: Ref; remote?: Ref } | null {
  const rm = remotes.find((x) => x.name === 'origin') ?? remotes[0];
  const target = rm ? refs.find((x) => x.kind === 'remote' && x.name === `${rm.name}/HEAD`)?.target : undefined;
  const has = (n: string) => refs.some((x) => (x.kind === 'branch' && x.name === n) || (!!rm && x.kind === 'remote' && x.name === `${rm.name}/${n}`));
  const name = rm && target?.startsWith(`${rm.name}/`) && target !== `${rm.name}/HEAD` ? target.slice(rm.name.length + 1) : ['main', 'master'].find(has);
  if (!name) return null;
  const remote = rm ? refs.find((x) => x.kind === 'remote' && x.name === `${rm.name}/${name}`) : undefined;
  const local = refs.find((x) => x.kind === 'branch' && x.name === name) ?? (remote ? refs.find((x) => x.kind === 'branch' && x.upstream === remote.name) : undefined);
  return local || remote ? { name, local, remote } : null;
}
