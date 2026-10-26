import type { Ref } from '../git/types';

/** one release version: the branches `ver/XXX` (local) and `<remote>/ver/XXX` that carry it */
export interface VersionGroup {
  /** the XXX of ver/XXX */
  version: string;
  /** its branches, the local one first */
  refs: Ref[];
  /** a `ver/XXX` branch exists in the local repository */
  local: boolean;
  /** HEAD is on it */
  current: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** a version name starts with three digits (`001`, `042-fix`); a `ver/` branch that does not is just a branch */
const VERSION_NAME = /^\d{3}/;

export function isVersionName(name: string) {
  return VERSION_NAME.test(name);
}

/** `ver/XXX` (local) or `<remote>/ver/XXX` (remote) → XXX, XXX starting with three digits; null for every other ref */
export function versionOf(r: Ref): string | null {
  const m = r.kind === 'branch' ? /^ver\/(.+)$/.exec(r.name) : r.kind === 'remote' ? /^[^/]+\/ver\/(.+)$/.exec(r.name) : null;
  return m && isVersionName(m[1]) ? m[1] : null;
}

/** the versions of a repository, newest first (numeric compare, so ver/10 is above ver/9) */
export function versionGroups(refs: Ref[]): VersionGroup[] {
  const by = new Map<string, VersionGroup>();
  for (const r of refs) {
    const v = versionOf(r);
    if (v == null) continue;
    let g = by.get(v);
    if (!g) by.set(v, (g = { version: v, refs: [], local: false, current: false }));
    g.refs.push(r);
    if (r.kind === 'branch') g.local = true;
    if (r.current) g.current = true;
  }
  const out = [...by.values()];
  for (const g of out) g.refs.sort((a, b) => (a.kind === 'branch' ? 0 : 1) - (b.kind === 'branch' ? 0 : 1) || collator.compare(a.name, b.name));
  out.sort((a, b) => collator.compare(b.version, a.version));
  return out;
}
