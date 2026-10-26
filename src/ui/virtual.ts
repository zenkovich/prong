import { useCallback, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/**
 * Which rows of a fixed-height list to render: the visible ones plus `overscan` on each side.
 * The window moves in steps of `chunk` rows, so scrolling re-renders the list only every few rows, never per pixel.
 * Rows go in an absolutely positioned layer of height `count * rowH` (see `rowTop`).
 */
export function useVirtualWindow(count: number, rowH: number, opts: { overscan?: number; chunk?: number } = {}) {
  const overscan = opts.overscan ?? 30;
  const chunk = opts.chunk ?? 10;
  const [step, setStep] = useState(0);
  const [viewH, setViewH] = useState(900);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const k = Math.floor(Math.max(0, e.nativeEvent.contentOffset.y) / rowH / chunk);
      setStep((prev) => (prev === k ? prev : k));
    },
    [rowH, chunk],
  );
  const onLayout = useCallback((e: LayoutChangeEvent) => setViewH(e.nativeEvent.layout.height), []);
  const top = step * chunk;
  const first = Math.max(0, Math.min(top - overscan, count - 1));
  const last = Math.max(first, Math.min(count, top + Math.ceil(viewH / rowH) + chunk + overscan));
  return { first, last, viewH, onScroll, onLayout };
}

export const rowTop = (i: number, rowH: number) => ({ position: 'absolute' as const, top: i * rowH, left: 0, right: 0, height: rowH });
