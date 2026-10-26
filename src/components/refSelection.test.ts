import { describe, expect, it } from 'vitest';
import { nextSelection } from './refSelection';

const order = ['dev/a', 'dev/b', 'dev/c', 'main', 'ver/1'];
const meta = { meta: true, shift: false };
const shift = { meta: false, shift: true };

describe('branch multi-selection', () => {
  it('⌘ toggles one branch, keeping the others', () => {
    let s = nextSelection([], null, 'dev/a', meta, order);
    s = nextSelection(s.sel, s.anchor, 'main', meta, order);
    expect(s.sel).toEqual(['dev/a', 'main']);
    s = nextSelection(s.sel, s.anchor, 'dev/a', meta, order);
    expect(s.sel).toEqual(['main']);
  });
  it('Shift selects the run from the last clicked one, in the shown order, either direction', () => {
    const s = nextSelection(['dev/b'], 'dev/b', 'main', shift, order);
    expect(s.sel).toEqual(['dev/b', 'dev/c', 'main']);
    expect(nextSelection(['main'], 'main', 'dev/a', shift, order).sel).toEqual(['dev/a', 'dev/b', 'dev/c', 'main']);
  });
  it('⌘⇧ adds a run to what is selected; a plain click clears', () => {
    const s = nextSelection(['ver/1'], 'dev/a', 'dev/b', { meta: true, shift: true }, order);
    expect(s.sel).toEqual(['ver/1', 'dev/a', 'dev/b']);
    expect(nextSelection(s.sel, s.anchor, 'main', { meta: false, shift: false }, order).sel).toEqual([]);
  });
  it('a branch outside the shown order (filtered away) is just added', () => {
    expect(nextSelection(['main'], 'main', 'hidden', shift, order).sel).toEqual(['main', 'hidden']);
  });
});
