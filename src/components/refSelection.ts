/**
 * Multi-selection of branches in the sidebar, as in a file manager: ⌘ (Ctrl) toggles one, Shift selects the run
 * from the last clicked one to this one in the order the sidebar shows, ⌘⇧ adds that run. `order` is that order.
 */
export function nextSelection(sel: string[], anchor: string | null, name: string, mods: { meta: boolean; shift: boolean }, order: string[]): { sel: string[]; anchor: string | null } {
  if (mods.shift) {
    const from = anchor && order.includes(anchor) ? anchor : name;
    const a = order.indexOf(from);
    const b = order.indexOf(name);
    if (a < 0 || b < 0) return { sel: sel.includes(name) ? sel : [...sel, name], anchor: from };
    const run = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return { sel: mods.meta ? [...new Set([...sel, ...run])] : run, anchor: from };
  }
  if (mods.meta) return { sel: sel.includes(name) ? sel.filter((n) => n !== name) : [...sel, name], anchor: name };
  return { sel: [], anchor: name };
}
