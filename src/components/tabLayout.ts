/**
 * Repository tab bar layout: submodule tabs grouped under their parent repository, and widths that fit
 * the bar like browser tabs (natural width when there is room, shrinking evenly down to a minimum, then scroll).
 */

export interface TabIn {
  id: string;
  path: string;
  name: string;
}
export interface TabOut extends TabIn {
  /** open tab this one lives inside (submodule / nested checkout), null for a top-level repository */
  parent: string | null;
  /** label: the name for top-level tabs, the path relative to the parent for nested ones */
  label: string;
  /** ids of the open tabs nested in this one (top-level tabs only) */
  children: string[];
}

const norm = (p: string) => p.replace(/\/+$/, '');

/** Orders tabs so nested ones follow their outermost open parent; keeps the user's order otherwise. */
export function groupTabs(tabs: TabIn[]): TabOut[] {
  const roots: TabOut[] = [];
  const byId = new Map<string, TabOut>();
  // the outermost open tab containing this one is its group
  const outer = (t: TabIn) => {
    let best: TabIn | null = null;
    for (const o of tabs) {
      if (o.id === t.id || !o.path || !t.path) continue;
      const op = norm(o.path);
      if (norm(t.path).startsWith(op + '/') && (!best || op.length < norm(best.path).length)) best = o;
    }
    return best;
  };
  for (const t of tabs) {
    const p = outer(t);
    const out: TabOut = { ...t, parent: p?.id ?? null, label: p ? norm(t.path).slice(norm(p.path).length + 1) : t.name, children: [] };
    byId.set(t.id, out);
  }
  for (const t of tabs) {
    const o = byId.get(t.id)!;
    if (!o.parent) roots.push(o);
  }
  for (const t of tabs) {
    const o = byId.get(t.id)!;
    if (o.parent) byId.get(o.parent)!.children.push(o.id);
  }
  const ordered: TabOut[] = [];
  for (const r of roots) {
    ordered.push(r);
    for (const c of r.children) ordered.push(byId.get(c)!);
  }
  return ordered;
}

/**
 * Widths for tabs with these natural widths in `available` px: natural when they fit, otherwise the widest
 * shrink first (water-filling) and none goes below its minimum. `overflow` is true when even the minimums
 * do not fit (the bar scrolls then).
 */
export function fitWidths(natural: number[], available: number, min: number[] | number): { widths: number[]; overflow: boolean } {
  const mins = natural.map((_, i) => (Array.isArray(min) ? min[i] : min));
  const nat = natural.map((n, i) => Math.max(n, mins[i]));
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  if (sum(nat) <= available) return { widths: nat, overflow: false };
  if (sum(mins) >= available) return { widths: mins, overflow: sum(mins) > available };
  // find a cap c with Σ clamp(nat, min, c) = available
  let lo = Math.min(...mins);
  let hi = Math.max(...nat);
  for (let k = 0; k < 40; k++) {
    const c = (lo + hi) / 2;
    const total = sum(nat.map((n, i) => Math.max(mins[i], Math.min(n, c))));
    if (total > available) hi = c;
    else lo = c;
  }
  return { widths: nat.map((n, i) => Math.floor(Math.max(mins[i], Math.min(n, lo)))), overflow: false };
}

/**
 * Monospace UI: width of a tab from its label length. Chrome = padding 2×10 + border 2 + marker 7 (submodule icon
 * 10) + gap 5 + change dot 6+6; only the active tab reserves its close button (6+15), others overlay it on hover;
 * the "+N" badge adds 28.
 */
export function naturalTabWidth(label: string, opts: { charW: number; nested?: boolean; active?: boolean; badge?: number }) {
  const chrome = (opts.nested ? 50 : 47) + (opts.active ? 21 : 0);
  return Math.ceil(chrome + label.length * opts.charW + (opts.badge ? 28 : 0));
}
