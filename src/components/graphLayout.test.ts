import { describe, expect, it } from 'vitest';
import { Commit } from '../git/types';
import { applyCollapse, filterByRefs, layoutGraph, reachableFrom } from './graphLayout';

const c = (sha: string, parents: string[]): Commit => ({ sha, parents, subject: sha, body: '', author: 'a', email: 'a@x', date: 0 });
// m(c2, f2) ← main; f2 ← f1 ← c1; c2 ← c1 ; side: e1 ← c1
const COMMITS = [c('m', ['c2', 'f2']), c('f2', ['f1']), c('c2', ['c1']), c('f1', ['c1']), c('e1', ['c1']), c('c1', [])];

describe('layoutGraph', () => {
  it('assigns lanes, incoming lines and merge joins for a topo-ordered list', () => {
    const { rows, maxLanes } = layoutGraph(COMMITS);
    expect(rows.map((r) => r.sha)).toEqual(['m', 'f2', 'c2', 'f1', 'e1', 'c1']);
    expect(rows[0]).toMatchObject({ lane: 0, hasIncoming: false, isMerge: true });
    expect(rows[0].out.map((o) => o.lane)).toEqual([0, 1]); // first parent stays, second parent gets lane 1
    expect(rows[1]).toMatchObject({ sha: 'f2', lane: 1, hasIncoming: true });
    expect(rows[2]).toMatchObject({ sha: 'c2', lane: 0, hasIncoming: true });
    const f1 = rows[3];
    expect(f1.lane).toBe(1);
    expect(f1.out[0].lane).toBe(0); // f1's parent c1 is already awaited in lane 0 → joins
    const e1 = rows[4];
    expect(e1.out[0].lane).toBe(0); // e1's parent c1 is already awaited in lane 0 → its line joins lane 0
    const c1 = rows[5];
    expect(c1.hasIncoming).toBe(true);
    expect(c1.mergeIn).toEqual([]); // joins are drawn by the child rows, not as merge-ins
    expect(c1.out).toEqual([]);
    expect(maxLanes).toBeGreaterThanOrEqual(2);
  });
  it('never leaves a parent without a lane (every out lane is awaited by a later row)', () => {
    const { rows } = layoutGraph(COMMITS);
    for (let i = 0; i < rows.length; i++) {
      for (const o of rows[i].out) {
        const later = rows.slice(i + 1).some((r) => r.lane === o.lane || r.mergeIn.some((m) => m.lane === o.lane));
        expect(later).toBe(true);
      }
    }
  });
});

describe('reachableFrom / filterByRefs', () => {
  it('computes ancestry', () => {
    expect([...reachableFrom(COMMITS, 'f2')].sort()).toEqual(['c1', 'f1', 'f2']);
  });
  it('filters by current branch and by selected refs', () => {
    const refs = [
      { name: 'main', kind: 'branch' as const, sha: 'm', current: true },
      { name: 'exp', kind: 'branch' as const, sha: 'e1' },
      { name: 'origin/exp', kind: 'remote' as const, sha: 'e1' },
    ];
    expect(filterByRefs(COMMITS, refs, 'm', { mode: 'all', refs: [], hideRemotes: false })).toHaveLength(6);
    expect(filterByRefs(COMMITS, refs, 'm', { mode: 'current', refs: [], hideRemotes: false }).map((x) => x.sha)).toEqual(['m', 'f2', 'c2', 'f1', 'c1']);
    expect(filterByRefs(COMMITS, refs, 'm', { mode: 'selected', refs: ['exp'], hideRemotes: false }).map((x) => x.sha)).toEqual(['e1', 'c1']);
    expect(filterByRefs(COMMITS, refs, 'm', { mode: 'selected', refs: [], hideRemotes: false })).toEqual([]);
  });
});

describe('applyCollapse', () => {
  it('hides the side branch of a collapsed merge and rewires parents', () => {
    const r = applyCollapse(COMMITS, new Set(['m']));
    expect([...r.hidden].sort()).toEqual(['f1', 'f2']);
    expect(r.hiddenBy.get('m')).toBe(2);
    const m = r.commits.find((x) => x.sha === 'm')!;
    expect(m.parents).toEqual(['c2']);
    expect(r.commits.map((x) => x.sha)).toEqual(['m', 'c2', 'e1', 'c1']);
  });
  it('is a no-op without collapsed merges', () => {
    const r = applyCollapse(COMMITS, new Set());
    expect(r.commits).toBe(COMMITS);
    expect(r.hidden.size).toBe(0);
  });
});

describe('graph layout: column limit', () => {
  // a merge-heavy history with 40 branch tips open at once (a repository with thousands of branches)
  const tips = 40;
  const commit = (sha: string, parents: string[]) => ({ sha, parents, subject: '', body: '', author: '', email: '', date: 0 });
  const commits = [
    ...Array.from({ length: tips }, (_, i) => commit(`t${i}`, [`p${i}`])),
    ...Array.from({ length: tips }, (_, i) => commit(`p${i}`, ['base'])),
    commit('base', []),
  ];
  it('keeps one entry per drawn column, lanes past the last column share it', () => {
    const full = layoutGraph(commits);
    const capped = layoutGraph(commits, 12);
    expect(full.maxLanes).toBe(tips);
    expect(capped.maxLanes).toBe(tips); // the real width is still known
    expect(Math.max(...full.rows.map((r) => r.passThrough.length))).toBe(tips - 1);
    for (const r of capped.rows) {
      expect(r.passThrough.length).toBeLessThanOrEqual(11);
      expect(r.lane).toBeLessThan(12);
      for (const p of [...r.passThrough, ...r.out, ...r.mergeIn]) expect(p.lane).toBeLessThan(12);
      expect(new Set(r.passThrough.map((p) => p.lane)).size).toBe(r.passThrough.length);
    }
  });
  it('changes nothing while the lanes fit', () => {
    const small = [commit('a', ['b']), commit('x', ['b']), commit('b', ['base']), commit('base', [])];
    expect(layoutGraph(small, 12)).toEqual(layoutGraph(small));
  });
});

describe('merge collapsing: the bounded walk equals the definition', () => {
  // random histories, children before parents; "hidden by m" = reachable from m's side parents, not from its first
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const seed of [1, 7, 42, 2026]) {
    it(`random history #${seed}`, () => {
      const r = rng(seed);
      const n = 400;
      const commits = Array.from({ length: n }, (_, i) => {
        const parents: string[] = [];
        if (i < n - 1) parents.push(`c${i + 1 + Math.floor(r() * Math.min(6, n - i - 1))}`);
        if (i < n - 3 && r() < 0.3) parents.push(`c${i + 2 + Math.floor(r() * Math.min(40, n - i - 2))}`);
        return { sha: `c${i}`, parents: [...new Set(parents)], subject: '', body: '', author: '', email: '', date: 0 };
      });
      const merges = commits.filter((c) => c.parents.length > 1);
      expect(merges.length).toBeGreaterThan(50);
      for (const m of merges) {
        const main = reachableFrom(commits, m.parents[0]);
        const side = reachableFrom(commits, m.parents.slice(1));
        const want = [...side].filter((s) => !main.has(s)).sort();
        expect([...applyCollapse(commits, new Set([m.sha])).hidden].sort()).toEqual(want);
      }
      // all merges at once: newest first, a merge already folded away is not walked
      const all = new Set<string>();
      for (const m of merges) {
        if (all.has(m.sha)) continue;
        const main = reachableFrom(commits, m.parents[0]);
        for (const s of reachableFrom(commits, m.parents.slice(1))) if (!main.has(s)) all.add(s);
      }
      const res = applyCollapse(commits, new Set(merges.map((m) => m.sha)));
      expect([...res.hidden].sort()).toEqual([...all].sort());
      expect(res.commits.length).toBe(n - all.size);
      // every visible commit points only at visible commits
      const shown = new Set(res.commits.map((c) => c.sha));
      for (const c of res.commits) for (const p of c.parents) expect(shown.has(p)).toBe(true);
    });
  }

  it('collapses every merge of 20 000 commits quickly', () => {
    const r = rng(5);
    const n = 20000;
    const commits = Array.from({ length: n }, (_, i) => {
      const parents: string[] = [];
      if (i < n - 1) parents.push(`c${i + 1}`);
      if (i < n - 300 && r() < 0.15) parents.push(`c${i + 2 + Math.floor(r() * 250)}`);
      return { sha: `c${i}`, parents: [...new Set(parents)], subject: '', body: '', author: '', email: '', date: 0 };
    });
    const t0 = performance.now();
    applyCollapse(commits, new Set(commits.filter((c) => c.parents.length > 1).map((c) => c.sha)));
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
