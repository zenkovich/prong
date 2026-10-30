import { describe, expect, it } from 'vitest';
import type { FileChange } from '../../git/types';
import { availableModes, fitView, fmtBytes, fmtDuration, peaks, sideState, signedBytes, svgPoint, svgSize, svgSizeText, svgViewOf, VECTOR_FIT_MAX, zoomAt } from './mediaMath';

describe('zoom and pan geometry', () => {
  it('fits and centres, enlarging small images at most 8×', () => {
    const v = fitView({ w: 524, h: 424 }, { w: 100, h: 50 });
    expect(v.s).toBe(5); // (524-24)/100 = 5, (424-24)/50 = 8 → 5
    expect(v.x).toBe((524 - 500) / 2);
    expect(v.y).toBe((424 - 250) / 2);
    expect(v.fitted).toBe(true);
    expect(fitView({ w: 1024, h: 1024 }, { w: 16, h: 16 }).s).toBe(8);
    expect(fitView({ w: 224, h: 224 }, { w: 4000, h: 2000 }).s).toBeCloseTo(0.05);
  });
  it('zooms around the cursor: the image point under it stays put', () => {
    const v = { s: 2, x: 10, y: 20, fitted: true };
    const z = zoomAt(v, 1.5, 110, 70);
    // image point under the cursor before: ((110-10)/2, (70-20)/2) = (50, 25)
    expect((110 - z.x) / z.s).toBeCloseTo(50);
    expect((70 - z.y) / z.s).toBeCloseTo(25);
    expect(z.s).toBe(3);
    expect(z.fitted).toBe(false);
    expect(zoomAt(v, 1000, 0, 0).s).toBe(64);
    expect(zoomAt(v, 1e-6, 0, 0).s).toBe(0.02);
  });
});

describe('comparison modes', () => {
  it('offers nothing for a single side or identical content', () => {
    expect(availableModes(false, true, false)).toEqual([]);
    expect(availableModes(true, false, false)).toEqual([]);
    expect(availableModes(true, true, true)).toEqual([]);
  });
  it('offers Difference only for equal pixel sizes', () => {
    expect(availableModes(true, true, false, { w: 64, h: 48 }, { w: 80, h: 48 })).toEqual(['side', 'swipe', 'onion']);
    expect(availableModes(true, true, false, { w: 64, h: 48 }, { w: 64, h: 48 })).toEqual(['side', 'swipe', 'onion', 'diff']);
    expect(availableModes(true, true, false)).toEqual(['side', 'swipe', 'onion']); // sizes not known yet
  });
});

describe('side states and sizes', () => {
  it('names what happened to the file', () => {
    expect(sideState(undefined, { oid: 'a' })).toBe('added');
    expect(sideState({ oid: 'a' }, undefined)).toBe('deleted');
    expect(sideState({ oid: 'a' }, { oid: 'a' })).toBe('unchanged');
    expect(sideState({ oid: 'a' }, { oid: 'b' })).toBe('modified');
    expect(sideState({}, {})).toBe('modified'); // working copy: no object id, assume changed
    expect(sideState()).toBe('missing');
  });
  it('formats sizes, deltas and durations', () => {
    expect(fmtBytes(1000)).toBe('1000 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(signedBytes(500)).toBe('+500 B');
    expect(signedBytes(-2048)).toBe('−2.0 KB');
    expect(signedBytes(0)).toBe('±0 B');
    expect(fmtDuration(0.5)).toBe('0:00.50');
    expect(fmtDuration(83.257)).toBe('1:23.26');
    expect(fmtDuration(undefined)).toBe('');
    expect(fmtDuration(Infinity)).toBe('');
  });
});

describe('waveform peaks', () => {
  it('takes min/max per bin across channels', () => {
    const l = new Float32Array([0.1, -0.5, 0.2, 0.9]);
    const r = new Float32Array([-0.7, 0.3, 0, 0]);
    expect(peaks([l, r], 2)).toEqual([
      [expect.closeTo(-0.7), expect.closeTo(0.3)],
      [0, expect.closeTo(0.9)],
    ]);
    expect(peaks([new Float32Array(0)])).toEqual([]);
  });
});

describe('SVG', () => {
  const svg = (attrs: string, before = '') => `${before}<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><path d="M0 0h1"/></svg>`;
  it('the size an <img> draws it at: width and height in any unit, the viewBox for what is missing', () => {
    expect(svgSize(svg('viewBox="0 0 24 24"'))).toEqual({ w: 24, h: 24, sized: false, viewBox: { x: 0, y: 0, w: 24, h: 24 } });
    expect(svgSize(svg('width="100" height="50px"'))).toEqual({ w: 100, h: 50, sized: true, viewBox: undefined });
    const pt = svgSize(svg('width="12pt" height="1in" viewBox="0,0,16,8"'))!;
    expect([pt.w, pt.h, pt.sized, pt.viewBox]).toEqual([16, 96, true, { x: 0, y: 0, w: 16, h: 8 }]);
    // one side given: the other from the viewBox's ratio; a percentage is no size
    expect(svgSize(svg('width="48" viewBox="0 0 24 12"'))).toMatchObject({ w: 48, h: 24, sized: false });
    expect(svgSize(svg('width="100%" height="32" viewBox="0 0 64 32"'))).toMatchObject({ w: 64, h: 32, sized: false });
    // nothing at all: the browser's 300×150
    expect(svgSize(svg(''))).toEqual({ w: 300, h: 150, sized: false });
    expect(svgSize('not an svg')).toBeNull();
  });
  it('reads the root element past a declaration, comments, a doctype and quoted ">"', () => {
    const text = svg(`width='20' data-x="a>b" height="10"`, '<?xml version="1.0"?>\n<!-- <svg width="1" height="1"> -->\n<!DOCTYPE svg>\n');
    expect(svgSize(text)).toMatchObject({ w: 20, h: 10, sized: true });
    expect(svgSize('<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 8 4"/>')).toMatchObject({ w: 8, h: 4 });
  });
  it('the cursor in the SVG’s own units, the viewBox fitted and centred', () => {
    const icon = svgSize(svg('viewBox="-12 -12 24 24"'))!;
    expect(svgPoint(icon, 12, 6)).toEqual({ x: 0, y: -6 });
    // a 200×100 box for a square viewBox: 50px bands left and right
    const wide = svgSize(svg('width="200" height="100" viewBox="0 0 10 10"'))!;
    expect(svgPoint(wide, 50, 0)).toEqual({ x: 0, y: 0 });
    expect(svgPoint(wide, 150, 100)).toEqual({ x: 10, y: 10 });
    expect(svgPoint(svgSize(svg('width="5" height="5"'))!, 2, 3)).toEqual({ x: 2, y: 3 });
    expect(svgSizeText(icon)).toBe('24×24 viewBox');
    expect(svgSizeText(svgSize(svg('width="12pt" height="10"'))!)).toBe('16×10 px');
  });
  it('fitting a vector enlarges small icons further than a bitmap', () => {
    expect(fitView({ w: 1024, h: 1024 }, { w: 16, h: 16 }, 24, VECTOR_FIT_MAX).s).toBe(32);
    expect(fitView({ w: 424, h: 424 }, { w: 24, h: 24 }, 24, VECTOR_FIT_MAX).s).toBeCloseTo(400 / 24);
  });
  it('picture or text: text only when git has a text diff; a conflict is text; other files are not SVGs', () => {
    const f = (path: string, kind: FileChange['kind'], extra: Partial<FileChange> = {}): FileChange => ({ path, status: 'M', kind, additions: 0, deletions: 0, ...extra });
    expect(svgViewOf(f('a.svg', 'text'), 'image')).toEqual({ svg: true, hasText: true, asImage: true });
    expect(svgViewOf(f('a.svg', 'text'), 'text')).toEqual({ svg: true, hasText: true, asImage: false });
    expect(svgViewOf(f('a.svg', 'large'), 'text').hasText).toBe(true);
    // kept binary (.gitattributes, LFS): the picture whatever was picked
    expect(svgViewOf(f('a.svg', 'image'), 'text')).toEqual({ svg: true, hasText: false, asImage: true });
    expect(svgViewOf(f('a.svg', 'text', { status: 'U' }), 'image').svg).toBe(false);
    expect(svgViewOf(f('a.svg', 'text', { conflict: { ours: [], theirs: [], base: [] } }), 'image').asImage).toBe(false);
    expect(svgViewOf(f('a.png', 'image'), 'image').svg).toBe(false);
    expect(svgViewOf(f('a.svg.txt', 'text'), 'image').svg).toBe(false);
  });
});
