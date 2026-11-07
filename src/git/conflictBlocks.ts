import type { ConflictBlock, ConflictChoice, FileChange } from './types';

type Conflict = NonNullable<FileChange['conflict']>;

/**
 * A conflict's blocks: the engine sends the whole file; without them (mock data, an older engine) the conflicting
 * regions alone ("⋯" between them) make one conflict each.
 */
export function blocksOf(c: Conflict): ConflictBlock[] {
  if (c.blocks) return c.blocks;
  const split = (lines: string[]) => {
    const out: string[][] = [[]];
    for (const l of lines) if (l === '⋯') out.push([]);
    else out[out.length - 1].push(l);
    return out;
  };
  const [o, b, t] = [split(c.ours), split(c.base), split(c.theirs)];
  return o.map((ours, i) => ({ kind: 'conflict' as const, ours, base: b[i] ?? [], theirs: t[i] ?? [] }));
}

/** the lines the picks make (the engine writes the same, see composeConflict in server/src/git/repo.ts) */
export function composeLines(blocks: ConflictBlock[], choices: ConflictChoice[]): string[] {
  const out: string[] = [];
  let k = 0;
  for (const b of blocks) {
    if (b.kind === 'same') {
      out.push(...b.lines);
      continue;
    }
    out.push(...pickedLines(b, choices[k++]));
  }
  return out;
}

/** what one conflict becomes with a pick (nothing picked yet: its lines are still to come) */
export function pickedLines(b: Extract<ConflictBlock, { kind: 'conflict' }>, c: ConflictChoice | undefined): string[] {
  if (c === 'ours') return b.ours;
  if (c === 'theirs') return b.theirs;
  if (c === 'ours+theirs') return [...b.ours, ...b.theirs];
  if (c === 'theirs+ours') return [...b.theirs, ...b.ours];
  if (c === 'base') return b.base;
  return [];
}

/**
 * The pick a pair of ticks makes, as in Fork's merge view: ours and/or theirs, in the order they were ticked;
 * neither ticked keeps neither change (the base).
 */
export function choiceOf(ours: boolean, theirs: boolean, theirsFirst: boolean): ConflictChoice {
  if (ours && theirs) return theirsFirst ? 'theirs+ours' : 'ours+theirs';
  if (ours) return 'ours';
  if (theirs) return 'theirs';
  return 'base';
}
