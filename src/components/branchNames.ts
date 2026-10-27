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
