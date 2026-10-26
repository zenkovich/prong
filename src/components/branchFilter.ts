import type { GraphFilter } from './graphLayout';

/**
 * Fork-style branch filter (pure). The funnel next to a branch narrows the history to that branch; more
 * funnels add branches; removing the last one shows everything again.
 */
export function toggleFilterRef(f: GraphFilter, name: string): GraphFilter {
  if (f.mode !== 'selected') return { ...f, mode: 'selected', refs: [name] };
  const refs = f.refs.includes(name) ? f.refs.filter((r) => r !== name) : [...f.refs, name];
  return refs.length ? { ...f, mode: 'selected', refs } : { ...f, mode: 'all', refs: [] };
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
