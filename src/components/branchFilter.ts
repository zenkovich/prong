import type { Ref } from '../git/types';
import { remoteTwin } from './branchNames';
import type { GraphFilter } from './graphLayout';

/**
 * Fork-style branch filter (pure). The funnel next to a branch narrows the history to that branch; more
 * funnels add branches; removing the last one shows everything again. A local branch comes with `twin`, its branch
 * on the remote: both go in and out together.
 */
export function toggleFilterRef(f: GraphFilter, name: string, twin?: string): GraphFilter {
  const pair = twin && twin !== name ? [name, twin] : [name];
  if (f.mode !== 'selected') return { ...f, mode: 'selected', refs: pair };
  const refs = f.refs.includes(name) ? f.refs.filter((r) => !pair.includes(r)) : [...f.refs, ...pair.filter((r) => !f.refs.includes(r))];
  return refs.length ? { ...f, mode: 'selected', refs } : { ...f, mode: 'all', refs: [] };
}

/**
 * The filter with `name` in it: a click on a branch or tag in the sidebar takes it into a filter that leaves it out,
 * so the history shows where the click went. A local branch comes with `twin`, as by its funnel. "Current branch"
 * becomes a selection of the current branch (`current`, with its twin) and this one. The same object back when the
 * filter already shows the ref (or shows every branch).
 */
export function withFilterRef(f: GraphFilter, name: string, twin?: string, current?: FilterChip): GraphFilter {
  const pair = (n: string, t?: string) => (t && t !== n ? [n, t] : [n]);
  if (f.mode === 'all') return f;
  if (f.mode === 'selected') return f.refs.includes(name) ? f : { ...f, refs: [...f.refs, ...pair(name, twin).filter((r) => !f.refs.includes(r))] };
  if (current?.name === name) return f;
  return { ...f, mode: 'selected', refs: [...new Set([...(current ? pair(current.name, current.twin) : []), ...pair(name, twin)])] };
}

/**
 * The remote branch a local branch's funnel takes along: the one it tracks, else its namesake on origin. None for
 * a remote branch or a tag, and none while remote branches are hidden (it would filter nothing).
 */
export function filterTwin(refs: Ref[], remotes: { name: string }[], name: string, hideRemotes = false): string | undefined {
  if (hideRemotes) return undefined;
  const b = refs.find((x) => x.kind === 'branch' && x.name === name);
  return b ? remoteTwin(refs, remotes, b) : undefined;
}

/** one chip of the filter bar: a ref, or a local branch with its remote branch (both in the filter) */
export interface FilterChip {
  name: string;
  twin?: string;
}

/** the chips of a filter: a local branch and its twin share one, at the local branch's place */
export function filterChips(f: GraphFilter, refs: Ref[], remotes: { name: string }[]): FilterChip[] {
  if (f.mode !== 'selected') return [];
  const on = new Set(f.refs);
  const twins = new Map<string, string>();
  const paired = new Set<string>();
  for (const name of f.refs) {
    const twin = filterTwin(refs, remotes, name, f.hideRemotes);
    if (twin && on.has(twin) && !paired.has(twin) && !twins.has(twin)) {
      twins.set(name, twin);
      paired.add(twin);
    }
  }
  return f.refs.filter((n) => !paired.has(n)).map((name) => (twins.has(name) ? { name, twin: twins.get(name) } : { name }));
}

export function inFilter(f: GraphFilter, name: string) {
  return f.mode === 'selected' && f.refs.includes(name);
}

/** git revisions for a filter, or null when nothing is filtered (the full history) */
export function filterRevs(f: GraphFilter): string[] | null {
  if (f.mode === 'all') return f.hideRemotes ? ['--branches', '--tags'] : null;
  if (f.mode === 'current') return ['HEAD'];
  return f.refs;
}
