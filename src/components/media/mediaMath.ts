/** Pure helpers for the media previews (no React): geometry of zoom/pan, comparison modes, sizes, waveforms. */

export type Mode = 'side' | 'swipe' | 'onion' | 'diff';
export interface View2D {
  s: number;
  x: number;
  y: number;
  fitted: boolean;
}
export interface Dims {
  w: number;
  h: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 64;
export const FIT_MAX = 8;
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** fit the frame into the pane, centred, small images enlarged up to FIT_MAX */
export function fitView(pane: Dims, frame: Dims, pad = 24): View2D {
  const s = clamp(Math.min((pane.w - pad) / frame.w, (pane.h - pad) / frame.h, FIT_MAX), MIN_SCALE, MAX_SCALE);
  return { s, x: (pane.w - frame.w * s) / 2, y: (pane.h - frame.h * s) / 2, fitted: true };
}
/** zoom by `factor` keeping the point (cx, cy) of the pane fixed */
export function zoomAt(v: View2D, factor: number, cx: number, cy: number): View2D {
  const s = clamp(v.s * factor, MIN_SCALE, MAX_SCALE);
  const k = s / v.s;
  return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, fitted: false };
}

export function availableModes(hasBefore: boolean, hasAfter: boolean, identical: boolean, before?: Dims, after?: Dims): Mode[] {
  if (!hasBefore || !hasAfter || identical) return [];
  const sameSize = !!before && !!after && before.w === after.w && before.h === after.h;
  return sameSize ? ['side', 'swipe', 'onion', 'diff'] : ['side', 'swipe', 'onion'];
}


export type SideState = 'added' | 'deleted' | 'unchanged' | 'modified' | 'missing';

export function sideState(before?: { oid?: string }, after?: { oid?: string }, identical = !!before?.oid && before?.oid === after?.oid): SideState {
  if (!before && !after) return 'missing';
  if (!before) return 'added';
  if (!after) return 'deleted';
  return identical ? 'unchanged' : 'modified';
}

export function fmtBytes(n: number) {
  const a = Math.abs(n);
  const v = a < 1024 ? `${a} B` : a < 1024 * 1024 ? `${(a / 1024).toFixed(1)} KB` : a < 1024 ** 3 ? `${(a / 1024 / 1024).toFixed(1)} MB` : `${(a / 1024 ** 3).toFixed(2)} GB`;
  return n < 0 ? `−${v}` : v;
}
export const signedBytes = (n: number) => (n === 0 ? '±0 B' : n > 0 ? `+${fmtBytes(n)}` : fmtBytes(n));


export const fmtDuration = (s?: number) => {
  if (s === undefined || !isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
};

export const WAVE_MAX_BYTES = 60 * 1024 * 1024;
export const BINS = 480;

/** min/max peaks per bin over all channels, -1..1 */
export function peaks(channels: Float32Array[], bins = BINS): [number, number][] {
  const len = channels[0]?.length ?? 0;
  const out: [number, number][] = [];
  if (!len) return out;
  const per = Math.max(1, Math.floor(len / bins));
  for (let b = 0; b < bins; b++) {
    let lo = 0;
    let hi = 0;
    const start = b * per;
    const end = Math.min(len, start + per);
    for (const ch of channels)
      for (let i = start; i < end; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    out.push([lo, hi]);
  }
  return out;
}

