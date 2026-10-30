import { describe, expect, it } from 'vitest';
import { badgeFill, inkOn, rgba, THEMES } from './index';

describe('inkOn', () => {
  it('dark text on light fills, white on dark ones', () => {
    expect(inkOn('#e8b23b')).toBe('#101214');
    expect(inkOn('#ffffff')).toBe('#101214');
    expect(inkOn('#000000')).toBe('#ffffff');
    expect(inkOn('#2358c9')).toBe('#ffffff');
    expect(rgba('#ff0000', 0.5)).toBe('rgba(255,0,0,0.5)');
  });
  it('every lane of every scheme makes a badge whose ink reads at 4.5:1 (WCAG AA), barely changed', () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
    };
    const contrast = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    for (const t of Object.values(THEMES))
      for (const lane of t.lanes) {
        const fill = badgeFill(lane);
        expect(contrast(fill, inkOn(fill)), `${t.name} ${lane} → ${fill}`).toBeGreaterThanOrEqual(4.5);
        // the same colour: each channel within 16% of the lane's
        const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
        ch(fill).forEach((c, i) => expect(Math.abs(c - ch(lane)[i]), `${t.name} ${lane} → ${fill}`).toBeLessThanOrEqual(41));
      }
    expect(badgeFill('#e8b23b')).toBe('#e8b23b');
  });
});
