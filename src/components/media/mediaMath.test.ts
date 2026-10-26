import { describe, expect, it } from 'vitest';
import { availableModes, fitView, fmtBytes, fmtDuration, peaks, sideState, signedBytes, zoomAt } from './mediaMath';

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
