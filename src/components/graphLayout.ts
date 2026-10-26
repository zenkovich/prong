import { Commit, Ref, Sha } from '../git/types';

export interface GraphRow {
  sha: Sha;
  lane: number;
  color: number; // palette index
  hasIncoming: boolean; // a lane was already waiting for this commit (line from the row above)
  passThrough: { lane: number; color: number }[]; // straight lines across the row
  mergeIn: { lane: number; color: number }[]; // from top of lane -> node
  out: { lane: number; color: number }[]; // node -> bottom of lane
  isMerge: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  maxLanes: number;
}

/**
 * Lane allocation for a topologically ordered (newest first) commit list.
 * A lane holds the sha it is waiting for; when that commit is reached it occupies the lane.
 *
 * `cols` is how many columns the graph draws: lanes past the last column share it, and each row keeps one line
 * per column. A repository with thousands of branches keeps a hundred lanes open at once; without this every
 * row carried a hundred lines drawn on top of each other (138 000 SVG elements for 1 800 commits).
 */
export function layoutGraph(commits: Commit[], cols = Infinity): GraphLayout {
  const col = (l: number) => (l < cols ? l : cols - 1);
  /** one entry per drawn column, the first lane's colour wins */
  const squeeze = <T extends { lane: number; color: number }>(list: T[], skip = -1): T[] => {
    if (cols === Infinity) return list;
    const seen = new Set<number>();
    const out: T[] = [];
    for (const x of list) {
      const c = col(x.lane);
      if (c === skip || seen.has(c)) continue;
      seen.add(c);
      out.push(c === x.lane ? x : { ...x, lane: c });
    }
    return out;
  };
  const lanes: (Sha | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];
  let maxLanes = 1;

  const alloc = (sha: Sha) => {
    let i = lanes.indexOf(null);
    if (i === -1) {
      i = lanes.length;
      lanes.push(null);
      laneColor.push(0);
    }
    lanes[i] = sha;
    laneColor[i] = nextColor++;
    return i;
  };

  for (const c of commits) {
    // 1. find the lane waiting for this commit
    let L = lanes.indexOf(c.sha);
    const hasIncoming = L !== -1;
    const mergeIn: GraphRow['mergeIn'] = [];
    if (L === -1) {
      L = alloc(c.sha);
    } else {
      for (let i = L + 1; i < lanes.length; i++) {
        if (lanes[i] === c.sha) {
          mergeIn.push({ lane: i, color: laneColor[i] });
          lanes[i] = null;
        }
      }
    }
    const color = laneColor[L];

    // 2. lanes that simply pass through this row
    const passThrough: GraphRow['passThrough'] = [];
    for (let i = 0; i < lanes.length; i++) if (i !== L && lanes[i] !== null) passThrough.push({ lane: i, color: laneColor[i] });

    // 3. parents
    const out: GraphRow['out'] = [];
    if (c.parents.length === 0) {
      lanes[L] = null;
    } else {
      const [p0, ...rest] = c.parents;
      const j0 = lanes.indexOf(p0);
      if (j0 !== -1 && j0 !== L) {
        // first parent already expected elsewhere: this branch ends by joining that lane
        out.push({ lane: j0, color });
        lanes[L] = null;
      } else {
        lanes[L] = p0;
        out.push({ lane: L, color });
      }
      for (const p of rest) {
        const j = lanes.indexOf(p);
        if (j !== -1) out.push({ lane: j, color: laneColor[j] });
        else {
          const nj = alloc(p);
          out.push({ lane: nj, color: laneColor[nj] });
        }
      }
    }
    // trim trailing empty lanes
    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
      laneColor.pop();
    }
    maxLanes = Math.max(maxLanes, L + 1, ...passThrough.map((p) => p.lane + 1), ...out.map((o) => o.lane + 1), ...mergeIn.map((m) => m.lane + 1));
    const nodeCol = col(L);
    rows.push({ sha: c.sha, lane: nodeCol, color, hasIncoming, passThrough: squeeze(passThrough, nodeCol), mergeIn: squeeze(mergeIn, nodeCol), out: squeeze(out), isMerge: c.parents.length > 1 });
  }
  return { rows, maxLanes };
}

export function reachableFrom(commits: Commit[] | Map<Sha, Commit>, start: Sha | Sha[]): Set<Sha> {
  const map = commits instanceof Map ? commits : new Map(commits.map((c) => [c.sha, c]));
  const seen = new Set<Sha>();
  const stack = Array.isArray(start) ? [...start] : [start];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    map.get(s)?.parents.forEach((p) => stack.push(p));
  }
  return seen;
}

/** binary min-heap of list positions */
class MinHeap {
  private a: number[] = [];
  get size() {
    return this.a.length;
  }
  push(x: number) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l] < a[m]) m = l;
        if (r < a.length && a[r] < a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const MAIN = 1;
const SIDE = 2;
const QUEUED = 4;

/** parents as list positions (-1: not loaded), flat: parents of `i` are `idx[start[i]] .. idx[start[i + 1] - 1]` */
function parentPositions(commits: Commit[], index: Map<Sha, number>) {
  const start = new Int32Array(commits.length + 1);
  let total = 0;
  for (let i = 0; i < commits.length; i++) {
    start[i] = total;
    total += commits[i].parents.length;
  }
  start[commits.length] = total;
  const idx = new Int32Array(total);
  let k = 0;
  for (const c of commits) for (const p of c.parents) idx[k++] = index.get(p) ?? -1;
  return { start, idx };
}

/**
 * Hide what collapsing merge `mi` hides: commits reachable from its side parents but not from its first parent.
 * The list is date-ordered (children before parents), so walking both sides in list order settles every commit
 * before its parents: a commit that only the side reached when its turn comes is hidden. The walk stops when no
 * side-only commit is left (the merge base), so it costs the length of the merged branch, not of the history.
 * Returns how many commits it hid that were not hidden yet.
 */
function hideSide(mi: number, par: { start: Int32Array; idx: Int32Array }, flags: Uint8Array, hidden: Uint8Array): number {
  const touched: number[] = [];
  const heap = new MinHeap();
  let sideOnly = 0;
  const add = (i: number, f: number) => {
    if (i < 0) return;
    const old = flags[i];
    const was = old & 3;
    const now = was | f;
    if (now === was) return;
    if (old === 0) {
      touched.push(i);
      heap.push(i);
      flags[i] = now | QUEUED;
      if (now === SIDE) sideOnly++;
    } else {
      flags[i] = now | (old & QUEUED);
      if (was === SIDE && old & QUEUED) sideOnly--; // the mainline reaches it after all
    }
  };
  const s0 = par.start[mi];
  const s1 = par.start[mi + 1];
  if (s1 - s0 < 2) return 0;
  add(par.idx[s0], MAIN);
  for (let k = s0 + 1; k < s1; k++) add(par.idx[k], SIDE);
  let n = 0;
  while (heap.size && sideOnly > 0) {
    const i = heap.pop();
    flags[i] &= ~QUEUED;
    const f = flags[i] & 3;
    if (f === SIDE) {
      sideOnly--;
      if (!hidden[i]) {
        hidden[i] = 1;
        n++;
      }
    }
    // anything the mainline reaches is not hidden, whatever else reaches it
    const pf = f === SIDE ? SIDE : MAIN;
    for (let k = par.start[i]; k < par.start[i + 1]; k++) add(par.idx[k], pf);
  }
  for (const i of touched) flags[i] = 0;
  return n;
}

export interface CollapseResult {
  commits: Commit[]; // visible commits with parents re-pointed to visible ancestors
  hiddenBy: Map<Sha, number>; // merge sha -> number of commits hidden under it
  hidden: Set<Sha>;
}

/**
 * Apply merge collapsing: hides side-branch commits of every collapsed merge and rewires parents
 * so the remaining graph stays connected (a collapsed merge keeps only its first parent).
 */
export function applyCollapse(commits: Commit[], collapsed: Set<Sha>): CollapseResult {
  if (collapsed.size === 0) return { commits, hiddenBy: new Map(), hidden: new Set() };
  const map = new Map(commits.map((c) => [c.sha, c]));
  const index = new Map(commits.map((c, i) => [c.sha, i]));
  const par = parentPositions(commits, index);
  const flags = new Uint8Array(commits.length);
  const hiddenAt = new Uint8Array(commits.length);
  const hiddenBy = new Map<Sha, number>();
  // newest first: a merge inside a side branch that is already folded away is not walked again
  const order = [...collapsed].map((sha) => index.get(sha)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);
  for (const mi of order) {
    if (hiddenAt[mi]) continue;
    hiddenBy.set(commits[mi].sha, hideSide(mi, par, flags, hiddenAt));
  }
  const hidden = new Set<Sha>();
  for (let i = 0; i < commits.length; i++) if (hiddenAt[i]) hidden.add(commits[i].sha);
  if (hidden.size === 0) return { commits, hiddenBy, hidden };
  const visibleAncestor = (sha: Sha): Sha | null => {
    let cur: Sha | undefined = sha;
    let guard = 0;
    while (cur && hidden.has(cur) && guard++ < 10000) cur = map.get(cur)?.parents[0];
    return cur && map.has(cur) ? cur : null;
  };
  const out: Commit[] = [];
  for (const c of commits) {
    if (hidden.has(c.sha)) continue;
    let parents: Sha[];
    if (collapsed.has(c.sha) && c.parents.length > 1) parents = [c.parents[0]];
    else parents = c.parents;
    const rewired: Sha[] = [];
    for (const p of parents) {
      const v = visibleAncestor(p);
      if (v && !rewired.includes(v)) rewired.push(v);
    }
    out.push(parents === c.parents && rewired.length === c.parents.length && rewired.every((p, i) => p === c.parents[i]) ? c : { ...c, parents: rewired });
  }
  return { commits: out, hiddenBy, hidden };
}

export interface GraphFilter {
  mode: 'all' | 'current' | 'selected';
  refs: string[]; // ref names when mode === 'selected'
  hideRemotes: boolean;
}

/** Commits reachable from the refs allowed by the filter (plus HEAD when it is visible). */
export function filterByRefs(commits: Commit[], refs: Ref[], head: Sha, filter: GraphFilter): Commit[] {
  if (filter.mode === 'all' && !filter.hideRemotes) return commits;
  let starts: Sha[];
  if (filter.mode === 'current') starts = [head];
  else {
    const allowed = refs.filter((r) => r.kind !== 'stash' && r.name !== 'origin/HEAD' && (!filter.hideRemotes || r.kind !== 'remote') && (filter.mode === 'all' || filter.refs.includes(r.name)));
    starts = allowed.map((r) => r.sha);
    if (filter.mode === 'all') starts.push(head);
  }
  const keep = reachableFrom(commits, starts);
  return commits.filter((c) => keep.has(c.sha));
}
