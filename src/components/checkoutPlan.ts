import type { Ref } from '../git/types';

/**
 * What checking out a branch does (pure; the Checkout dialog that every double click on a branch opens). A remote
 * branch means its local branch: the one tracking it, else the same-named one, else a new one tracking it (as Fork).
 * The local branch is compared with its counterpart: the remote branch picked, or the local one's upstream.
 */
export interface CheckoutPlan {
  /** the ref picked */
  ref: string;
  /** the local branch HEAD ends on */
  target: string;
  /** a new branch made at this remote branch, tracking it */
  start?: string;
  /** HEAD is on the target already */
  current: boolean;
  /** what the target is brought up to by a merge or a rebase: the remote branch picked, else the target's upstream */
  other?: string;
  /** commits of the target not in `other`, and the other way round; undefined when git's tracking does not say */
  ahead?: number;
  behind?: number;
  /** the target and `other` point to different commits */
  differs: boolean;
}

export function checkoutPlan(refs: Ref[], name: string): CheckoutPlan | null {
  const ref = refs.find((x) => x.name === name && (x.kind === 'branch' || x.kind === 'remote'));
  if (!ref || name.endsWith('/HEAD')) return null;
  const shaOf = (n: string) => refs.find((x) => x.name === n && x.kind === 'remote')?.sha;
  if (ref.kind === 'branch') {
    const other = ref.upstream && !ref.gone && shaOf(ref.upstream) ? ref.upstream : undefined;
    return { ref: name, target: name, current: !!ref.current, other, ahead: other ? ref.ahead ?? 0 : undefined, behind: other ? ref.behind ?? 0 : undefined, differs: !!other && shaOf(other) !== ref.sha };
  }
  const short = name.slice(name.indexOf('/') + 1);
  const local = refs.find((x) => x.kind === 'branch' && x.upstream === name) ?? refs.find((x) => x.kind === 'branch' && x.name === short);
  if (!local) return { ref: name, target: short, start: name, current: false, differs: false };
  const tracks = local.upstream === name && !local.gone;
  return { ref: name, target: local.name, current: !!local.current, other: name, ahead: tracks ? local.ahead ?? 0 : undefined, behind: tracks ? local.behind ?? 0 : undefined, differs: local.sha !== ref.sha };
}

export type Integrate = 'none' | 'merge' | 'rebase';

/** a merge or a rebase is worth offering: the target differs from its counterpart and is not just ahead of it */
export const canIntegrate = (p: CheckoutPlan) => p.differs && !(p.behind === 0 && (p.ahead ?? 0) > 0);

/** picked at first: only behind → brought up the way pulls go (the Preferences' mode); gone both ways or unknown → left */
export function defaultIntegrate(p: CheckoutPlan, pullMode: 'merge' | 'rebase' | 'ff' = 'merge'): Integrate {
  if (!canIntegrate(p) || !p.behind || p.ahead) return 'none';
  return pullMode === 'rebase' ? 'rebase' : 'merge';
}

/** how the target stands against its counterpart, for the dialog */
export function relationText(p: CheckoutPlan): string | null {
  if (!p.other) return p.start ? `A new branch ${p.target} is made at ${p.start} and tracks it` : null;
  if (!p.differs) return `${p.target} is at ${p.other}`;
  const n = (k: number) => `${k} commit${k === 1 ? '' : 's'}`;
  if (p.ahead === undefined || p.behind === undefined) return `${p.target} and ${p.other} point to different commits`;
  if (p.ahead && p.behind) return `${p.target} and ${p.other} have diverged: ${n(p.ahead)} of its own, ${n(p.behind)} new on ${p.other}`;
  if (p.behind) return `${p.target} is ${n(p.behind)} behind ${p.other}`;
  return `${p.target} is ${n(p.ahead)} ahead of ${p.other}: push to publish`;
}

/** the branches a double click on a commit row offers: its local branches (not the current one), then remote branches without a local label there */
export function rowCheckoutChoices(refs: Ref[]): string[] {
  const locals = refs.filter((r) => r.kind === 'branch');
  const others = locals.filter((r) => !r.current);
  const remotes = refs.filter((r) => r.kind === 'remote' && !r.name.endsWith('/HEAD') && !locals.some((l) => l.upstream === r.name || r.name.endsWith('/' + l.name)));
  return [...others.map((r) => r.name), ...remotes.map((r) => r.name)];
}
