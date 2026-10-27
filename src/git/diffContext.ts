import type { FileChange } from './types';

/** lines added on each side of every change by one "Expand context" */
export const CONTEXT_STEP = 10;

/** lines of a diff (all hunks) */
export const diffLines = (f?: FileChange | null) => (f?.hunks ?? []).reduce((n, h) => n + h.lines.length, 0);

/**
 * Whether a diff read with `context` lines around each change already shows the whole file, so more context would
 * add nothing: one hunk that starts at the first line and has fewer unchanged lines after its last change than were
 * asked for (git stopped at the end of the file). No hunks (nothing textual to show) counts as whole.
 */
export function coversWholeFile(f: FileChange, context = f.context ?? 3): boolean {
  const hs = f.hunks ?? [];
  if (hs.length === 0) return true;
  if (hs.length > 1) return false;
  const lines = hs[0].lines;
  if (!lines.length) return true;
  const first = lines[0];
  const startsAtTop = (first.kind === 'add' ? first.newNo : first.oldNo) === 1;
  let trailing = 0;
  for (let i = lines.length - 1; i >= 0 && lines[i].kind === 'ctx'; i--) trailing++;
  return startsAtTop && trailing < context;
}
