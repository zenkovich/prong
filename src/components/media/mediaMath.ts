/** Pure helpers for the media previews (no React): geometry of zoom/pan, comparison modes, sizes, waveforms. */
import type { FileChange } from '../../git/types';

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
/** a vector picture stays sharp enlarged: a 24-unit icon fills the pane */
export const VECTOR_FIT_MAX = 32;
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** fit the frame into the pane, centred, small images enlarged up to `max` */
export function fitView(pane: Dims, frame: Dims, pad = 24, max = FIT_MAX): View2D {
  const s = clamp(Math.min((pane.w - pad) / frame.w, (pane.h - pad) / frame.h, max), MIN_SCALE, MAX_SCALE);
  return { s, x: (pane.w - frame.w * s) / 2, y: (pane.h - frame.h * s) / 2, fitted: true };
}
/** zoom by `factor` keeping the point (cx, cy) of the pane fixed */
export function zoomAt(v: View2D, factor: number, cx: number, cy: number): View2D {
  const s = clamp(v.s * factor, MIN_SCALE, MAX_SCALE);
  const k = s / v.s;
  return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, fitted: false };
}

// ---------- SVG ----------

export const isSvgPath = (path: string) => /\.svg$/i.test(path);

/**
 * How an SVG's change shows: as the picture (both versions, the image compare) or as its text diff. Text only when
 * git has one: an SVG kept binary (.gitattributes, Git LFS) is the picture alone; a conflict is resolved as text.
 */
export function svgViewOf(file: FileChange, pref: 'image' | 'text'): { svg: boolean; hasText: boolean; asImage: boolean } {
  const svg = isSvgPath(file.path) && !file.conflict && file.status !== 'U' && !file.path.endsWith('/') && (file.kind === 'text' || file.kind === 'large' || file.kind === 'image');
  const hasText = svg && file.kind !== 'image';
  return { svg, hasText, asImage: svg && (!hasText || pref === 'image') };
}

export interface SvgBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** what an SVG's root element says about its size */
export interface SvgSize {
  /** the size it is drawn at, in CSS px */
  w: number;
  h: number;
  /** width and height both given in absolute units; otherwise the size comes from the viewBox (or the browser's 300×150) */
  sized: boolean;
  viewBox?: SvgBox;
}

/** CSS px per unit (font-relative units at the default 16px font) */
const UNIT_PX: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 16, rem: 16, ex: 8, ch: 8 };

/** an absolute length in px; null for none, a percentage, "auto" */
function svgLength(v?: string): number | null {
  const m = v?.trim().match(/^\+?(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm|q|em|rem|ex|ch)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]) * UNIT_PX[(m[2] ?? '').toLowerCase()];
  return n > 0 && isFinite(n) ? n : null;
}

/**
 * The size of an SVG from its root element: width and height (px, pt, mm…), the viewBox for what is missing — as a
 * browser sizes it as an image. Icons often have only a viewBox ("0 0 24 24"): 24×24 then, not the 1×1 or 300×150 an
 * <img> reports. Null when the text has no <svg> element.
 */
export function svgSize(text: string): SvgSize | null {
  const head = text.slice(0, 64 * 1024).replace(/<!--[\s\S]*?(-->|$)/g, '');
  const tag = head.match(/<(?:[\w-]+:)?svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i);
  if (!tag) return null;
  const attrs: Record<string, string> = {};
  for (const a of tag[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? '';
  const vb = attrs.viewbox?.trim().split(/[\s,]+/).map(Number);
  const viewBox = vb && vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0 ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : undefined;
  const w = svgLength(attrs.width);
  const h = svgLength(attrs.height);
  const ratio = viewBox ? viewBox.w / viewBox.h : 0;
  if (w && h) return { w, h, sized: true, viewBox };
  if (w) return { w, h: ratio ? w / ratio : 150, sized: false, viewBox };
  if (h) return { w: ratio ? h * ratio : 300, h, sized: false, viewBox };
  return viewBox ? { w: viewBox.w, h: viewBox.h, sized: false, viewBox } : { w: 300, h: 150, sized: false };
}

/** a point of the drawn picture (px from its top left, at 1:1) in the SVG's own units: its viewBox, fitted as "xMidYMid meet" */
export function svgPoint(size: SvgSize, px: number, py: number): { x: number; y: number } {
  const vb = size.viewBox;
  if (!vb) return { x: px, y: py };
  const k = Math.min(size.w / vb.w, size.h / vb.h);
  return { x: vb.x + (px - (size.w - vb.w * k) / 2) / k, y: vb.y + (py - (size.h - vb.h * k) / 2) / k };
}

/** "24×24 viewBox", "100×50 px", "12.5×10 px" (sizes not whole are kept to one decimal) */
export function svgSizeText(size: SvgSize): string {
  const n = (v: number) => String(Math.round(v * 10) / 10);
  if (!size.sized && size.viewBox) return `${n(size.viewBox.w)}×${n(size.viewBox.h)} viewBox`;
  return `${n(size.w)}×${n(size.h)} px`;
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

